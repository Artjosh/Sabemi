using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sabemi.Application.Auth;
using Sabemi.Infrastructure.Email;
using Shouldly;

namespace Sabemi.UnitTests.Infrastructure;

/// <summary>
/// O envio do e-mail de acesso pela Brevo.
/// </summary>
/// <remarks>
/// <b>O que se verifica.</b> Não é "o HttpClient foi chamado" - isso não diz
/// nada. É o contrato com a Brevo (endpoint, header de autenticação, forma do
/// corpo) e, principalmente, a garantia de que <b>uma falha de e-mail nunca
/// derruba o login</b>: ela vira <c>false</c>, o pedido de acesso continua válido
/// no banco e o link segue no log.
///
/// <b>Como.</b> Um <c>HttpMessageHandler</c> falso, sem rede. Um teste que
/// chamasse a Brevo de verdade precisaria de credencial, gastaria cota de envio e
/// falharia quando a rede oscilasse - medindo a Brevo, e não o nosso código.
/// </remarks>
public class BrevoLoginNotificationSenderTests
{
    /// <summary>Registra o que foi enviado e devolve a resposta combinada.</summary>
    private sealed class HandlerFalso(
        HttpStatusCode status = HttpStatusCode.Created,
        string corpo = """{"messageId":"<abc@brevo>"}""",
        Exception? explodirCom = null) : HttpMessageHandler
    {
        public HttpRequestMessage? Recebido { get; private set; }
        public string? CorpoEnviado { get; private set; }
        public int Chamadas { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Chamadas++;
            Recebido = request;

            if (request.Content is not null)
            {
                CorpoEnviado = await request.Content.ReadAsStringAsync(cancellationToken);
            }

            if (explodirCom is not null) throw explodirCom;

            return new HttpResponseMessage(status)
            {
                Content = new StringContent(corpo, Encoding.UTF8, "application/json"),
            };
        }
    }

    private static (BrevoLoginNotificationSender Remetente, HandlerFalso Handler) Montar(
        HttpStatusCode status = HttpStatusCode.Created,
        string corpo = """{"messageId":"<abc@brevo>"}""",
        Exception? explodirCom = null)
    {
        var handler = new HandlerFalso(status, corpo, explodirCom);

        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.brevo.test") };
        http.DefaultRequestHeaders.Add("api-key", "chave-de-teste");

        var remetente = new BrevoLoginNotificationSender(
            http,
            Options.Create(new BrevoOptions
            {
                ApiKey = "chave-de-teste",
                SenderEmail = "nao-responda@sabemi.com.br",
                SenderName = "Sabemi",
            }),
            Options.Create(new AuthOptions { MagicLinkTtl = TimeSpan.FromMinutes(15) }),
            NullLogger<BrevoLoginNotificationSender>.Instance);

        return (remetente, handler);
    }

    // ------------------------------------------------------- caminho felizardo

    [Fact]
    public async Task Um_dominio_reservado_nao_gera_nem_a_CHAMADA()
    {
        // O ponto do teste e o `handler.Recebido` ficar nulo: nao basta a Brevo
        // recusar depois, a requisicao nao pode sair. Uma tentativa de entrega
        // em dominio reservado e um hard bounce garantido, e bounce corroi a
        // entregabilidade de tudo o mais que a conta envia.
        var (remetente, handler) = Montar();

        var enviou = await remetente.SendAsync(
            "e2e-dotnet-123@e2e.invalid", "https://app/confirm?token=t", "123456");

        enviou.ShouldBeFalse();
        handler.Recebido.ShouldBeNull();
    }

    [Fact]
    public async Task A_requisicao_e_a_que_a_Brevo_espera()
    {
        // Endpoint, autenticacao e forma do corpo em um caso so: sao aspectos da
        // MESMA requisicao, e separa-los em quatro testes multiplicava a
        // montagem sem acrescentar cobertura - se um esta errado, o e-mail nao
        // sai, e a mensagem de falha diz qual.
        var (remetente, handler) = Montar();

        var enviou = await remetente.SendAsync(
            "destino@sabemi.com.br", "https://app/confirm?token=abc", "654321");

        enviou.ShouldBeTrue();
        handler.Recebido!.Method.ShouldBe(HttpMethod.Post);
        handler.Recebido.RequestUri!.AbsolutePath.ShouldBe("/v3/smtp/email");

        // A Brevo usa `api-key`, e nao `Authorization: Bearer`. Errar isto
        // devolve 401 com uma mensagem que nao diz qual header ela esperava.
        handler.Recebido.Headers.TryGetValues("api-key", out var chave).ShouldBeTrue();
        chave!.ShouldContain("chave-de-teste");

        using var json = JsonDocument.Parse(handler.CorpoEnviado!);
        var raiz = json.RootElement;

        raiz.GetProperty("sender").GetProperty("email").GetString()
            .ShouldBe("nao-responda@sabemi.com.br");
        raiz.GetProperty("sender").GetProperty("name").GetString().ShouldBe("Sabemi");

        // `to` e uma LISTA, mesmo com um destinatario so - a Brevo recusa objeto.
        var destinatarios = raiz.GetProperty("to");
        destinatarios.GetArrayLength().ShouldBe(1);
        destinatarios[0].GetProperty("email").GetString().ShouldBe("destino@sabemi.com.br");

        raiz.GetProperty("subject").GetString().ShouldBe(LoginEmail.Assunto);

        // Evita que um autoresponder de ferias gere uma resposta que ninguem le.
        raiz.GetProperty("headers").GetProperty("Auto-Submitted").GetString()
            .ShouldBe("auto-generated");
    }

    [Fact]
    public async Task O_e_mail_leva_link_e_codigo_nos_DOIS_corpos()
    {
        // O texto alternativo nao e decoracao: alguns clientes corporativos
        // bloqueiam HTML por politica, e um codigo que nao chega e um usuario que
        // nao entra.
        var (remetente, handler) = Montar();

        await remetente.SendAsync(
            "a@b.c", "https://app/confirm?token=TOKEN123&extra=1", "987654");

        using var json = JsonDocument.Parse(handler.CorpoEnviado!);
        var html = json.RootElement.GetProperty("htmlContent").GetString()!;
        var texto = json.RootElement.GetProperty("textContent").GetString()!;

        html.ShouldContain("TOKEN123");
        html.ShouldContain("987654");
        texto.ShouldContain("987654");

        // Sem escape no corpo em texto: uma URL com `&amp;` quebra ao ser colada
        // no navegador.
        texto.ShouldContain("token=TOKEN123&extra=1");

        // Prazo no e-mail evita o suporte que comeca com "cliquei no link de ontem".
        texto.ShouldContain("15 minutos");
    }

    // ------------------------------------------------------------- falhas

    [Theory]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task Uma_recusa_da_Brevo_devolve_false_sem_lancar(HttpStatusCode status)
    {
        // A garantia central: uma falha de e-mail NÃO pode virar 500 no endpoint
        // de login. Ela vira `false`, e o `AuthService` usa isso para mostrar o
        // link na tela em vez de mandar o usuário procurar um e-mail que nunca vai
        // chegar.
        var (remetente, _) = Montar(status, """{"message":"algum erro"}""");

        var enviou = await remetente.SendAsync("a@b.c", "https://app/x", "444444");

        enviou.ShouldBeFalse();
    }

    [Fact]
    public async Task Um_erro_de_rede_devolve_false_sem_lancar()
    {
        var (remetente, _) = Montar(explodirCom: new HttpRequestException("DNS falhou"));

        var enviou = await remetente.SendAsync("a@b.c", "https://app/x", "555555");

        enviou.ShouldBeFalse();
    }

    [Fact]
    public async Task Um_timeout_devolve_false_sem_lancar()
    {
        // `TaskCanceledException` sem cancelamento pedido é como o HttpClient
        // reporta timeout. Se ela vazasse, o login viraria 500 por lentidão de um
        // terceiro.
        var (remetente, _) = Montar(explodirCom: new TaskCanceledException("timeout"));

        var enviou = await remetente.SendAsync("a@b.c", "https://app/x", "666666");

        enviou.ShouldBeFalse();
    }

    [Fact]
    public async Task Um_cancelamento_PEDIDO_propaga()
    {
        // Desligamento em andamento não é falha de e-mail: propagar deixa o host
        // encerrar, em vez de registrar um erro que não aconteceu.
        var (remetente, _) = Montar(explodirCom: new OperationCanceledException());

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Should.ThrowAsync<OperationCanceledException>(
            () => remetente.SendAsync("a@b.c", "https://app/x", "777777", cts.Token));
    }

    [Fact]
    public async Task Nao_ha_retentativa_automatica()
    {
        // Deliberado: quem espera é o usuário na tela de login. Retentar três
        // vezes com backoff multiplicaria a espera por um e-mail que pode nunca
        // sair; quem quer outro e-mail clica em "reenviar", e aí o pedido novo
        // gera um código novo.
        var (remetente, handler) = Montar(HttpStatusCode.InternalServerError);

        await remetente.SendAsync("a@b.c", "https://app/x", "888888");

        handler.Chamadas.ShouldBe(1);
    }

    // ------------------------------------------------------------ opções

    [Fact]
    public void Sem_chave_as_opcoes_dizem_que_NAO_esta_configurado()
    {
        // É o que faz o DI registrar o remetente de log em vez deste.
        new BrevoOptions { ApiKey = "" }.Configurado.ShouldBeFalse();
        new BrevoOptions { ApiKey = "   " }.Configurado.ShouldBeFalse();
        new BrevoOptions { ApiKey = "xkeysib-abc" }.Configurado.ShouldBeTrue();
    }

    [Fact]
    public void O_timeout_padrao_e_curto_o_bastante_para_o_usuario_esperar()
    {
        // O padrão do HttpClient é 100s - indistinguível de uma página travada
        // para quem está olhando a tela de login.
        new BrevoOptions().Timeout.ShouldBeLessThanOrEqualTo(TimeSpan.FromSeconds(15));
    }
}
