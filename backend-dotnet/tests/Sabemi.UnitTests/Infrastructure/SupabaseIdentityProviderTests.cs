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
    public async Task O_desafio_vai_para_o_endpoint_de_OTP_do_GoTrue()
    {
        var (provedor, handler) = Montar();

        var resultado = await provedor.StartChallengeAsync("operador@sabemi.com.br", "SEL-1");

        resultado.EmailEnviado.ShouldBeTrue();
        handler.Recebidos[0].RequestUri!.AbsolutePath.ShouldBe("/auth/v1/otp");
        handler.Recebidos[0].Method.ShouldBe(HttpMethod.Post);
    }

    [Fact]
    public async Task O_redirect_to_carrega_o_SELECTOR()
    {
        // A peça que faz o cross-device funcionar. Sem o selector no
        // `redirect_to`, o clique no celular autenticaria apenas o celular - que
        // é o comportamento padrão do GoTrue e justamente o que não serve aqui.
        var (provedor, handler) = Montar();

        await provedor.StartChallengeAsync("operador@sabemi.com.br", "SEL-ABC");

        var query = handler.Recebidos[0].RequestUri!.Query;
        Uri.UnescapeDataString(query).ShouldContain("selector=SEL-ABC");
        Uri.UnescapeDataString(query).ShouldContain("/auth/supabase/confirm");
    }

    [Fact]
    public async Task Pede_ao_GoTrue_para_CRIAR_o_usuario_se_nao_existir()
    {
        // Não há tela de cadastro neste sistema: o primeiro acesso com um e-mail
        // cria a conta, igual ao modo local. Com `create_user: false`, um e-mail
        // novo receberia erro em vez de um convite.
        var (provedor, handler) = Montar();

        await provedor.StartChallengeAsync("novo@sabemi.com.br", "SEL-1");

        using var json = JsonDocument.Parse(handler.Corpos[0]);
        json.RootElement.GetProperty("create_user").GetBoolean().ShouldBeTrue();
        json.RootElement.GetProperty("email").GetString().ShouldBe("novo@sabemi.com.br");
    }

    [Fact]
    public async Task O_pedido_criado_NAO_guarda_hash_algum()
    {
        // É a diferença estrutural entre os dois modos: aqui quem guarda e valida
        // os segredos é o GoTrue. Um hash nosso nesta linha seria um segredo que
        // ninguém usa - e daria a impressão de que o pedido pode ser validado
        // localmente.
        var (provedor, _) = Montar();

        var resultado = await provedor.StartChallengeAsync("a@b.c", "SEL-1");

        resultado.Pedido.MagicTokenHash.ShouldBeNull();
        resultado.Pedido.OtpCodeHash.ShouldBeNull();
        resultado.Pedido.Provedor.ShouldBe(IdentityProvider.Supabase);
        resultado.Pedido.Selector.ShouldBe("SEL-1");
    }

    [Fact]
    public async Task Nao_devolve_link_nem_codigo()
    {
        // Eles vivem dentro do GoTrue e nunca passam por aqui. É por isso que,
        // neste modo, a demonstração sem SMTP depende do log do container do
        // GoTrue - e está documentado no .env.
        var (provedor, _) = Montar();

        var resultado = await provedor.StartChallengeAsync("a@b.c", "SEL-1");

        resultado.MagicUrl.ShouldBeNull();
        resultado.OtpCode.ShouldBeNull();
    }

    [Fact]
    public async Task Uma_recusa_do_GoTrue_ainda_DEVOLVE_o_pedido()
    {
        // Parece contraintuitivo, e é deliberado: o selector já vai para o
        // cliente, que já começa a pollar. Um pedido ausente daria 404 e a tela
        // diria "seu acesso expirou" - quando o que houve foi falha de envio.
        var handler = new HandlerFalso()
            .Responder("/auth/v1/otp", HttpStatusCode.BadRequest, """{"msg":"erro"}""");

        var (provedor, _) = Montar(handler);

        var resultado = await provedor.StartChallengeAsync("a@b.c", "SEL-1");

        resultado.Pedido.ShouldNotBeNull();
        resultado.Pedido.Selector.ShouldBe("SEL-1");
        resultado.EmailEnviado.ShouldBeFalse();
    }

    [Fact]
    public async Task Um_erro_de_rede_ainda_devolve_o_pedido()
    {
        var handler = new HandlerFalso { ExplodirCom = new HttpRequestException("DNS") };
        var (provedor, _) = Montar(handler);

        var resultado = await provedor.StartChallengeAsync("a@b.c", "SEL-1");

        resultado.Pedido.Selector.ShouldBe("SEL-1");
        resultado.EmailEnviado.ShouldBeFalse();
    }

    // ------------------------------------------------------------------ OTP

    [Fact]
    public async Task Um_codigo_aceito_pelo_GoTrue_e_valido()
    {
        var (provedor, handler) = Montar();
        var pedido = LoginRequest.CreateDelegado("a@b.c", "SEL-1", T0, TimeSpan.FromMinutes(15));

        var resultado = await provedor.VerifyOtpAsync(pedido, "123456");

        resultado.ShouldBe(OtpVerification.Valido);
        handler.Recebidos[0].RequestUri!.AbsolutePath.ShouldBe("/auth/v1/verify");
    }

    [Fact]
    public async Task Verifica_com_o_tipo_email_e_nao_magiclink()
    {
        // `email` é o tipo do OTP de acesso. `magiclink` valida o token longo do
        // link, que não é o que o usuário digita - e o GoTrue devolveria 400 sem
        // dizer que o tipo estava errado.
        var (provedor, handler) = Montar();
        var pedido = LoginRequest.CreateDelegado("a@b.c", "SEL-1", T0, TimeSpan.FromMinutes(15));

        await provedor.VerifyOtpAsync(pedido, "123456");

        using var json = JsonDocument.Parse(handler.Corpos[0]);
        json.RootElement.GetProperty("type").GetString().ShouldBe("email");
        json.RootElement.GetProperty("token").GetString().ShouldBe("123456");
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task O_GoTrue_dizendo_nao_e_codigo_INVALIDO(HttpStatusCode status)
    {
        var handler = new HandlerFalso().Responder("/auth/v1/verify", status);
        var (provedor, _) = Montar(handler);
        var pedido = LoginRequest.CreateDelegado("a@b.c", "SEL-1", T0, TimeSpan.FromMinutes(15));

        (await provedor.VerifyOtpAsync(pedido, "000000")).ShouldBe(OtpVerification.Invalido);
    }

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public async Task O_GoTrue_QUEBRADO_e_INDISPONIVEL_e_nao_codigo_errado(HttpStatusCode status)
    {
        // A distinção que protege o usuário: indisponibilidade não consome o
        // orçamento de tentativas, e a tela diz "tente de novo em instantes" em
        // vez de "código incorreto".
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

    // -------------------------------------------------- token de acesso

    [Fact]
    public async Task Um_token_valido_devolve_o_e_mail_do_dono()
    {
        var (provedor, handler) = Montar();

        var email = await provedor.VerifyAccessTokenAsync("jwt-valido");

        email.ShouldBe("operador@sabemi.com.br");

        // Pergunta ao GoTrue em vez de validar a assinatura localmente: validar
        // local aceitaria um token JÁ REVOGADO, e um logout no GoTrue continuaria
        // autenticando por todo o tempo de vida do JWT.
        handler.Recebidos[0].RequestUri!.AbsolutePath.ShouldBe("/auth/v1/user");
        handler.Recebidos[0].Headers.Authorization!.Parameter.ShouldBe("jwt-valido");
    }

    [Fact]
    public async Task O_e_mail_devolvido_vem_normalizado()
    {
        // A comparação com o e-mail do pedido é feita depois; normalizar aqui
        // evita depender de como o GoTrue guardou.
        var handler = new HandlerFalso()
            .Responder("/auth/v1/user", HttpStatusCode.OK, """{"email":"  Operador@Sabemi.COM.BR "}""");

        var (provedor, _) = Montar(handler);

        (await provedor.VerifyAccessTokenAsync("jwt")).ShouldBe("operador@sabemi.com.br");
    }

    [Fact]
    public async Task Um_token_recusado_devolve_null()
    {
        var handler = new HandlerFalso().Responder("/auth/v1/user", HttpStatusCode.Unauthorized);
        var (provedor, _) = Montar(handler);

        (await provedor.VerifyAccessTokenAsync("jwt-invalido")).ShouldBeNull();
    }

    [Fact]
    public async Task Um_usuario_sem_e_mail_devolve_null()
    {
        // É por e-mail que este sistema identifica o operador; sem ele não há
        // como comparar com o pedido.
        var handler = new HandlerFalso()
            .Responder("/auth/v1/user", HttpStatusCode.OK, """{"id":"abc"}""");

        var (provedor, _) = Montar(handler);

        (await provedor.VerifyAccessTokenAsync("jwt")).ShouldBeNull();
    }

    [Fact]
    public async Task Token_vazio_nao_gera_chamada_alguma()
    {
        var (provedor, handler) = Montar();

        (await provedor.VerifyAccessTokenAsync("")).ShouldBeNull();
        handler.Recebidos.ShouldBeEmpty();
    }

    [Fact]
    public async Task Uma_falha_de_rede_na_validacao_do_token_NEGA_o_acesso()
    {
        // Não há caminho de "talvez" aqui: na dúvida, o acesso é negado.
        var handler = new HandlerFalso { ExplodirCom = new HttpRequestException("rede") };
        var (provedor, _) = Montar(handler);

        (await provedor.VerifyAccessTokenAsync("jwt")).ShouldBeNull();
    }

    // ---------------------------------------------------------------- opções

    [Fact]
    public void Sem_URL_ou_chave_as_opcoes_dizem_que_NAO_esta_configurado()
    {
        // É o que faz o DI recusar a subida com AUTH_PROVIDER=supabase.
        new SupabaseAuthOptions { Url = "", AnonKey = "k" }.Configurado.ShouldBeFalse();
        new SupabaseAuthOptions { Url = "u", AnonKey = "" }.Configurado.ShouldBeFalse();
        new SupabaseAuthOptions { Url = "u", AnonKey = "k" }.Configurado.ShouldBeTrue();
    }
}
