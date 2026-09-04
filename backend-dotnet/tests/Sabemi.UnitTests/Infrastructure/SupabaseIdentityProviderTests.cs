using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sabemi.Application.Auth;
using Sabemi.Domain.Entities;
using Sabemi.Infrastructure.Auth;
using Sabemi.UnitTests.Support;
using Shouldly;

namespace Sabemi.UnitTests.Infrastructure;

/// <summary>
/// Delegação do desafio de acesso ao GoTrue.
/// </summary>
/// <remarks>
/// <b>O que se verifica.</b> O contrato com o GoTrue (endpoints, o `redirect_to`
/// carregando o selector, o header do gateway) e as três decisões que separam
/// este modo de uma integração ingênua:
///
/// <list type="number">
/// <item>uma falha do GoTrue devolve o pedido de todo modo, porque o selector já
/// foi entregue ao cliente e um pedido ausente daria "seu acesso expirou";</item>
/// <item>indisponibilidade NÃO é código inválido - senão uma queda de dois
/// segundos consumiria o orçamento de tentativas do usuário;</item>
/// <item>o token é validado CONTRA o GoTrue, e não localmente, para recusar
/// token revogado.</item>
/// </list>
///
/// <b>Como.</b> Um <c>HttpMessageHandler</c> falso, sem rede. Um teste contra um
/// GoTrue de verdade mediria o GoTrue, e não o nosso código.
/// </remarks>
public class SupabaseIdentityProviderTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 2, 12, 0, 0, TimeSpan.Zero);

    /// <summary>Responde por CAMINHO, para um teste cobrir mais de uma chamada.</summary>
    private sealed class HandlerFalso : HttpMessageHandler
    {
        private readonly Dictionary<string, (HttpStatusCode Status, string Corpo)> _porCaminho = [];

        public Exception? ExplodirCom { get; set; }
        public List<HttpRequestMessage> Recebidos { get; } = [];
        public List<string> Corpos { get; } = [];

        public HandlerFalso Responder(string caminho, HttpStatusCode status, string corpo = "{}")
        {
            _porCaminho[caminho] = (status, corpo);
            return this;
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Recebidos.Add(request);

            if (request.Content is not null)
            {
                Corpos.Add(await request.Content.ReadAsStringAsync(cancellationToken));
            }

            if (ExplodirCom is not null) throw ExplodirCom;

            var caminho = request.RequestUri!.AbsolutePath;

            var (status, corpo) = _porCaminho.TryGetValue(caminho, out var r)
                ? r
                : (HttpStatusCode.NotFound, """{"msg":"caminho nao configurado no teste"}""");

            return new HttpResponseMessage(status)
            {
                Content = new StringContent(corpo, Encoding.UTF8, "application/json"),
            };
        }
    }

    private static (SupabaseIdentityProvider Provedor, HandlerFalso Handler) Montar(
        HandlerFalso? handler = null)
    {
        handler = handler ?? new HandlerFalso()
            .Responder("/auth/v1/otp", HttpStatusCode.OK)
            .Responder("/auth/v1/verify", HttpStatusCode.OK)
            .Responder("/auth/v1/user", HttpStatusCode.OK, """{"email":"operador@sabemi.com.br"}""");

        var http = new HttpClient(handler) { BaseAddress = new Uri("https://supabase.test") };
        http.DefaultRequestHeaders.Add("apikey", "chave-anon");

        var provedor = new SupabaseIdentityProvider(
            http,
            new RelogioParado(T0),
            Options.Create(new SupabaseAuthOptions
            {
                Url = "https://supabase.test",
                AnonKey = "chave-anon",
            }),
            Options.Create(new AuthOptions
            {
                MagicLinkTtl = TimeSpan.FromMinutes(15),
                PublicBaseUrl = "http://localhost:8080",
            }),
            NullLogger<SupabaseIdentityProvider>.Instance);

        return (provedor, handler);
    }

    // --------------------------------------------------------------- desafio

    [Fact]
    public async Task O_desafio_delegado_ao_GoTrue_leva_o_selector_e_nao_guarda_segredo()
    {
        // Cinco aspectos do MESMO pedido de desafio, em um caso so. Separa-los em
        // cinco testes repetia a montagem sem acrescentar ramo de codigo.
        var (provedor, handler) = Montar();

        var resultado = await provedor.StartChallengeAsync("novo@sabemi.com.br", "SEL-ABC");

        resultado.EmailEnviado.ShouldBeTrue();
        handler.Recebidos[0].Method.ShouldBe(HttpMethod.Post);
        handler.Recebidos[0].RequestUri!.AbsolutePath.ShouldBe("/auth/v1/otp");

        // A peca que faz o cross-device funcionar. Sem o selector no
        // `redirect_to`, o clique no celular autenticaria apenas o celular - que
        // e o comportamento padrao do GoTrue e justamente o que nao serve aqui.
        var query = Uri.UnescapeDataString(handler.Recebidos[0].RequestUri!.Query);
        query.ShouldContain("selector=SEL-ABC");
        query.ShouldContain("/auth/supabase/confirm");

        // Nao ha tela de cadastro neste sistema: o primeiro acesso com um e-mail
        // cria a conta, igual ao modo local. Com `create_user: false`, um e-mail
        // novo receberia erro em vez de um convite.
        using var json = JsonDocument.Parse(handler.Corpos[0]);
        json.RootElement.GetProperty("create_user").GetBoolean().ShouldBeTrue();
        json.RootElement.GetProperty("email").GetString().ShouldBe("novo@sabemi.com.br");

        // A diferenca estrutural entre os dois modos: aqui quem guarda e valida
        // os segredos e o GoTrue. Um hash nosso nesta linha seria um segredo que
        // ninguem usa - e daria a impressao de que o pedido pode ser validado
        // localmente. O link e o codigo, pelo mesmo motivo, nunca passam por aqui.
        resultado.Pedido.MagicTokenHash.ShouldBeNull();
        resultado.Pedido.OtpCodeHash.ShouldBeNull();
        resultado.Pedido.Provedor.ShouldBe(IdentityProvider.Supabase);
        resultado.Pedido.Selector.ShouldBe("SEL-ABC");
        resultado.MagicUrl.ShouldBeNull();
        resultado.OtpCode.ShouldBeNull();
    }

    [Fact]
    public async Task Um_GoTrue_que_falha_ainda_DEVOLVE_o_pedido()
    {
        // O pedido ja existe no banco e vale: o usuario pode tentar de novo, ou
        // entrar pelo link do log do container. Perder o pedido por causa da
        // falha de envio transformaria um problema transitorio em sessao morta.
        //
        // Recusa HTTP e excecao de rede sao caminhos diferentes com o MESMO
        // contrato, e por isso ficam no mesmo caso.
        foreach (var handler in new[]
        {
            new HandlerFalso().Responder("/auth/v1/otp", HttpStatusCode.BadRequest, """{"msg":"erro"}"""),
            new HandlerFalso { ExplodirCom = new HttpRequestException("DNS") },
        })
        {
            var (provedor, _) = Montar(handler);

            var resultado = await provedor.StartChallengeAsync("a@b.c", "SEL-1");

            resultado.Pedido.ShouldNotBeNull();
            resultado.Pedido.Selector.ShouldBe("SEL-1");
            resultado.EmailEnviado.ShouldBeFalse();
        }
    }

    [Fact]
    public async Task Um_codigo_aceito_pelo_GoTrue_e_valido()
    {
        var (provedor, handler) = Montar();
        var pedido = LoginRequest.CreateDelegado("a@b.c", "SEL-1", T0, TimeSpan.FromMinutes(15));

        var resultado = await provedor.VerifyOtpAsync(pedido, "123456");

        resultado.ShouldBe(OtpVerification.Valido);
        handler.Recebidos[0].RequestUri!.AbsolutePath.ShouldBe("/auth/v1/verify");

        // `type: "email"` e nao `magiclink`: o GoTrue trata os dois como fluxos
        // distintos, e pedir o errado devolve 400 para um codigo correto.
        using var json = JsonDocument.Parse(handler.Corpos[0]);
        json.RootElement.GetProperty("type").GetString().ShouldBe("email");
        json.RootElement.GetProperty("token").GetString().ShouldBe("123456");
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.Unauthorized)]
    public async Task O_GoTrue_dizendo_nao_e_codigo_INVALIDO(HttpStatusCode status)
    {
        var handler = new HandlerFalso().Responder("/auth/v1/verify", status);
        var (provedor, _) = Montar(handler);
        var pedido = LoginRequest.CreateDelegado("a@b.c", "SEL-1", T0, TimeSpan.FromMinutes(15));

        (await provedor.VerifyOtpAsync(pedido, "000000")).ShouldBe(OtpVerification.Invalido);
    }

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public async Task O_GoTrue_QUEBRADO_e_INDISPONIVEL_e_nao_codigo_errado(HttpStatusCode status)
    {
        // A distincao existe para a UI: "codigo incorreto" manda o usuario digitar
        // de novo, e ele digitaria certo de novo. "Servico indisponivel" manda
        // tentar mais tarde, que e a acao que resolve.
        var handler = new HandlerFalso().Responder("/auth/v1/verify", status);
        var (provedor, _) = Montar(handler);
        var pedido = LoginRequest.CreateDelegado("a@b.c", "SEL-1", T0, TimeSpan.FromMinutes(15));

        (await provedor.VerifyOtpAsync(pedido, "123456")).ShouldBe(OtpVerification.Indisponivel);
    }

    [Fact]
    public async Task Um_erro_de_rede_na_verificacao_e_INDISPONIVEL()
    {
        var handler = new HandlerFalso { ExplodirCom = new TaskCanceledException("timeout") };
        var (provedor, _) = Montar(handler);
        var pedido = LoginRequest.CreateDelegado("a@b.c", "SEL-1", T0, TimeSpan.FromMinutes(15));

        (await provedor.VerifyOtpAsync(pedido, "123456")).ShouldBe(OtpVerification.Indisponivel);
    }

    [Fact]
    public async Task Um_token_valido_devolve_o_e_mail_do_dono_normalizado()
    {
        var (provedor, handler) = Montar();

        var email = await provedor.VerifyAccessTokenAsync("jwt-valido");

        email.ShouldBe("operador@sabemi.com.br");
        handler.Recebidos[0].RequestUri!.AbsolutePath.ShouldBe("/auth/v1/user");
        handler.Recebidos[0].Headers.Authorization!.Parameter.ShouldBe("jwt-valido");

        // Normalizacao: o e-mail e a chave da sessao, e "Operador@Sabemi.COM.BR"
        // precisa dar a MESMA sessao que "operador@sabemi.com.br".
        var comCaixa = new HandlerFalso().Responder(
            "/auth/v1/user", HttpStatusCode.OK, """{"email":"  Operador@Sabemi.COM.BR "}""");
        var (outro, _) = Montar(comCaixa);

        (await outro.VerifyAccessTokenAsync("jwt")).ShouldBe("operador@sabemi.com.br");
    }

    [Fact]
    public async Task Nada_alem_de_um_token_valido_com_e_mail_concede_acesso()
    {
        // Quatro maneiras de nao ter um dono confiavel, um contrato so: devolver
        // null, que o chamador traduz em 401. O caso do token vazio tambem afirma
        // que nao houve chamada - um "" enviado ao GoTrue voltaria 401 e poluiria
        // o log com um erro que nao e erro.
        var recusado = new HandlerFalso().Responder("/auth/v1/user", HttpStatusCode.Unauthorized);
        var semEmail = new HandlerFalso()
            .Responder("/auth/v1/user", HttpStatusCode.OK, """{"id":"abc"}""");
        var redeCaida = new HandlerFalso { ExplodirCom = new HttpRequestException("rede") };

        foreach (var handler in new[] { recusado, semEmail, redeCaida })
        {
            var (provedor, _) = Montar(handler);
            (await provedor.VerifyAccessTokenAsync("jwt")).ShouldBeNull();
        }

        var (comTudoOk, espiao) = Montar();
        (await comTudoOk.VerifyAccessTokenAsync("")).ShouldBeNull();
        espiao.Recebidos.ShouldBeEmpty();
    }

    [Fact]
    public void Sem_URL_ou_chave_as_opcoes_dizem_que_NAO_esta_configurado()
    {
        // É o que faz o DI recusar a subida com AUTH_PROVIDER=supabase.
        new SupabaseAuthOptions { Url = "", AnonKey = "k" }.Configurado.ShouldBeFalse();
        new SupabaseAuthOptions { Url = "u", AnonKey = "" }.Configurado.ShouldBeFalse();
        new SupabaseAuthOptions { Url = "u", AnonKey = "k" }.Configurado.ShouldBeTrue();
    }
}
