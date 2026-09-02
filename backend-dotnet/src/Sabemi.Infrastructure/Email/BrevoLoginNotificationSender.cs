using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Auth;

namespace Sabemi.Infrastructure.Email;

/// <summary>
/// Envia o e-mail de acesso pela API v3 da Brevo.
/// </summary>
/// <remarks>
/// <b>API HTTP e não SMTP.</b> A Brevo oferece os dois. A API dá erro imediato e
/// legível - "remetente não verificado", "chave inválida" -, enquanto por SMTP a
/// mesma falha chega como um <c>550</c> genérico ou, pior, como um aceite seguido
/// de descarte silencioso. Num fluxo em que o usuário está parado na tela
/// esperando o código, saber na hora que o envio falhou é o que permite mostrar
/// uma alternativa em vez de deixá-lo esperando.
///
/// <b>O retorno é o contrato.</b> <c>true</c> = a Brevo aceitou a mensagem;
/// <c>false</c> = não houve envio. O <c>AuthService</c> usa isso para decidir o
/// que a tela mostra, e é por isso que este método NUNCA lança: uma falha de
/// e-mail não pode virar 500 no endpoint de login. Ela vira <c>false</c>, o
/// pedido de acesso continua válido no banco, e o operador ainda pode entrar pelo
/// link do log.
///
/// <b>Idempotência.</b> Não há. Dois pedidos de acesso geram dois e-mails, com
/// códigos diferentes - e é o comportamento correto: quem clica "reenviar" quer
/// outro e-mail. O que garante que só um deles funcione é o pedido de login ser
/// de uso único.
/// </remarks>
public sealed class BrevoLoginNotificationSender(
    HttpClient http,
    IOptions<BrevoOptions> opcoes,
    IOptions<AuthOptions> authOpcoes,
    ILogger<BrevoLoginNotificationSender> logger)
    : ILoginNotificationSender
{
    private readonly BrevoOptions _opcoes = opcoes.Value;
    private readonly AuthOptions _auth = authOpcoes.Value;

    public async Task<bool> SendAsync(
        string email,
        string magicUrl,
        string otpCode,
        CancellationToken cancellationToken = default)
    {
        var conteudo = LoginEmail.Build(
            magicUrl, otpCode, (int)_auth.MagicLinkTtl.TotalMinutes);

        var pedido = new EnvioTransacional
        {
            Sender = new Contato { Email = _opcoes.SenderEmail, Name = _opcoes.SenderName },
            To = [new Contato { Email = email }],
            Subject = conteudo.Subject,
            HtmlContent = conteudo.Html,
            TextContent = conteudo.Text,

            // Cabeçalhos que o provedor de destino usa para agrupar e para
            // decidir o que fazer com uma resposta automática. `auto-generated`
            // evita que um autoresponder de férias gere uma resposta que ninguém
            // vai ler.
            Headers = new Dictionary<string, string>
            {
                ["X-Auto-Response-Suppress"] = "All",
                ["Auto-Submitted"] = "auto-generated",
            },
        };

        try
        {
            using var resposta = await http.PostAsJsonAsync(
                "/v3/smtp/email", pedido, cancellationToken);

            if (resposta.IsSuccessStatusCode)
            {
                logger.LogInformation("E-mail de acesso enviado para {Email} pela Brevo.", email);
                return true;
            }

            // O CORPO do erro é o que diz a causa - o status sozinho não. Um 400
            // da Brevo pode ser remetente não verificado, domínio sem
            // autenticação ou payload inválido, e cada um exige uma ação
            // diferente de quem opera.
            var corpo = await resposta.Content.ReadAsStringAsync(cancellationToken);

            logger.LogError(
                "A Brevo recusou o e-mail para {Email}: HTTP {Status}. Resposta: {Corpo}",
                email, (int)resposta.StatusCode, Truncar(corpo, 500));

            return false;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Desligamento em andamento, ou o cliente desistiu. Não é falha de
            // e-mail e não deve poluir o log de erro.
            throw;
        }
        catch (Exception ex)
        {
            // Timeout, DNS, TLS, indisponibilidade. Nada disso pode derrubar o
            // login: o pedido de acesso continua válido e o link está no log.
            logger.LogError(ex, "Falha ao enviar o e-mail de acesso para {Email}.", email);
            return false;
        }
    }

    private static string Truncar(string valor, int max)
        => valor.Length <= max ? valor : valor[..max];

    // ------------------------------------------------------------ contrato

    /// <summary>
    /// Corpo de <c>POST /v3/smtp/email</c>.
    /// </summary>
    /// <remarks>
    /// Tipado à mão, sem o SDK oficial. O SDK da Brevo traz um cliente gerado
    /// para a API inteira - dezenas de modelos de campanha, contato e estatística
    /// - quando o que se usa aqui é um endpoint com cinco campos. A superfície de
    /// dependência não se justifica, e o corpo tipado documenta melhor o que é
    /// enviado do que uma chamada a um método gerado.
    /// </remarks>
    private sealed class EnvioTransacional
    {
        [JsonPropertyName("sender")]
        public required Contato Sender { get; init; }

        [JsonPropertyName("to")]
        public required IReadOnlyList<Contato> To { get; init; }

        [JsonPropertyName("subject")]
        public required string Subject { get; init; }

        [JsonPropertyName("htmlContent")]
        public required string HtmlContent { get; init; }

        [JsonPropertyName("textContent")]
        public required string TextContent { get; init; }

        [JsonPropertyName("headers")]
        public Dictionary<string, string>? Headers { get; init; }
    }

    private sealed class Contato
    {
        [JsonPropertyName("email")]
        public required string Email { get; init; }

        /// <summary>Omitido quando nulo: a Brevo recusa <c>"name": null</c>.</summary>
        [JsonPropertyName("name")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Name { get; init; }
    }
}
