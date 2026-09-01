using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Sabemi.Infrastructure.Security;

/// <summary>Configuracao da autenticacao do webhook.</summary>
public sealed class WebhookSecurityOptions
{
    public const string SectionName = "WebhookSecurity";

    /// <summary>Chave compartilhada esperada no header <c>X-Api-Key</c>.</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Segredo do HMAC. Vazio desliga a verificacao de assinatura, deixando a
    /// ApiKey como unico fator - util em desenvolvimento.
    /// </summary>
    public string SignatureSecret { get; set; } = string.Empty;

    /// <summary>
    /// Exige a assinatura quando ha segredo configurado. Desligar aceita
    /// requisicoes sem <c>X-Signature</c> mesmo com segredo presente, o que
    /// serve a uma migracao gradual do parceiro.
    /// </summary>
    public bool RequireSignature { get; set; } = true;

    public string ApiKeyHeader { get; set; } = "X-Api-Key";
    public string SignatureHeader { get; set; } = "X-Signature";

    public bool SignatureEnabled => !string.IsNullOrWhiteSpace(SignatureSecret);
}

/// <summary>Desfecho da autenticacao do webhook.</summary>
public enum WebhookAuthResult
{
    /// <summary>Autenticado.</summary>
    Ok,

    /// <summary>ApiKey ausente ou incorreta. HTTP 401.</summary>
    InvalidApiKey,

    /// <summary>Assinatura exigida e ausente. HTTP 403.</summary>
    MissingSignature,

    /// <summary>Assinatura presente mas nao confere com o corpo. HTTP 403.</summary>
    InvalidSignature
}

/// <summary>
/// Autentica as chamadas do banco parceiro ao webhook.
/// </summary>
/// <remarks>
/// <para><b>A escolha: ApiKey e assinatura HMAC, em camadas.</b> A task pedia
/// "Signature ou ApiKey". Os dois foram implementados porque respondem a
/// perguntas diferentes, e uma so nao cobre o caso:</para>
///
/// <list type="bullet">
/// <item><description><b>X-Api-Key</b> responde "quem esta chamando?". E
/// simples, mas e um segredo estatico: quem o intercepta pode reenviar qualquer
/// corpo que quiser.</description></item>
/// <item><description><b>X-Signature</b> (HMAC-SHA256 do corpo bruto) responde
/// "este corpo chegou intacto?". Como a assinatura cobre o payload, alterar um
/// centavo do valor em transito invalida a requisicao. O segredo nunca trafega -
/// so a prova de que o remetente o possui.</description></item>
/// </list>
///
/// <para><b>Detalhes que decidem a corretude:</b></para>
///
/// <list type="bullet">
/// <item><description>A assinatura e calculada sobre os <b>bytes brutos</b> do
/// corpo, nunca sobre o JSON reserializado. Reserializar muda espacos e ordem de
/// chaves e quebra a assinatura de forma aparentemente aleatoria - e por isso
/// que o endpoint le o corpo como string antes de desserializar.</description></item>
/// <item><description>Todas as comparacoes usam
/// <see cref="CryptographicOperations.FixedTimeEquals"/>. Comparar com
/// <c>==</c> retorna assim que dois bytes diferem, e essa diferenca de tempo,
/// medida com paciencia, permite descobrir o segredo caractere a
/// caractere.</description></item>
/// </list>
///
/// <para><b>O que nao foi implementado, e por que.</b> Nao ha janela de
/// timestamp contra replay: a idempotencia por <c>id_transacao</c> ja neutraliza
/// a reexecucao - reenviar a mesma notificacao assinada nao produz efeito algum.
/// Em um cenario com rotacao de chaves, o proximo passo natural seria aceitar um
/// conjunto de chaves em vez de uma so.</para>
/// </remarks>
public sealed class WebhookAuthenticator(
    IOptions<WebhookSecurityOptions> options,
    ILogger<WebhookAuthenticator> logger)
{
    private readonly WebhookSecurityOptions _options = options.Value;

    /// <param name="apiKey">Valor do header <c>X-Api-Key</c>.</param>
    /// <param name="signature">Valor do header <c>X-Signature</c>, se houver.</param>
    /// <param name="rawBody">Corpo exatamente como recebido.</param>
    /// <returns>O desfecho e se a assinatura foi de fato conferida.</returns>
    public (WebhookAuthResult Result, bool SignatureVerified) Authenticate(
        string? apiKey, string? signature, string rawBody)
    {
        if (string.IsNullOrWhiteSpace(_options.ApiKey))
        {
            // Falha fechada: sem chave configurada, o endpoint fica trancado.
            // Aberto por omissao seria a pior falha possivel aqui.
            logger.LogError(
                "WebhookSecurity:ApiKey nao esta configurada; o webhook rejeitara todas as chamadas.");
            return (WebhookAuthResult.InvalidApiKey, false);
        }

        if (string.IsNullOrWhiteSpace(apiKey) || !FixedTimeEquals(apiKey, _options.ApiKey))
        {
            return (WebhookAuthResult.InvalidApiKey, false);
        }

        if (!_options.SignatureEnabled)
        {
            return (WebhookAuthResult.Ok, false);
        }

        if (string.IsNullOrWhiteSpace(signature))
        {
            return _options.RequireSignature
                ? (WebhookAuthResult.MissingSignature, false)
                : (WebhookAuthResult.Ok, false);
        }

        return VerifySignature(signature, rawBody)
            ? (WebhookAuthResult.Ok, true)
            : (WebhookAuthResult.InvalidSignature, false);
    }

    /// <summary>Confere o HMAC-SHA256 do corpo bruto.</summary>
    private bool VerifySignature(string signature, string rawBody)
    {
        // Aceita "sha256=<hex>" alem do hex puro: e a convencao usada por
        // GitHub e Stripe, e o parceiro pode ja seguir alguma delas.
        var recebida = signature.StartsWith("sha256=", StringComparison.OrdinalIgnoreCase)
            ? signature["sha256=".Length..]
            : signature;

        var esperada = ComputeSignature(rawBody, _options.SignatureSecret);
        return FixedTimeEquals(recebida.Trim().ToLowerInvariant(), esperada);
    }

    /// <summary>
    /// Calcula a assinatura de um corpo. Publico porque os testes e o script de
    /// demonstracao precisam produzir requisicoes assinadas validas.
    /// </summary>
    public static string ComputeSignature(string rawBody, string secret)
    {
        var hmac = HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(secret),
            Encoding.UTF8.GetBytes(rawBody));
        return Convert.ToHexString(hmac).ToLowerInvariant();
    }

    /// <summary>
    /// Compara em tempo constante. Vaza apenas o comprimento, que nao e segredo.
    /// </summary>
    private static bool FixedTimeEquals(string a, string b)
        => CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(a),
            Encoding.UTF8.GetBytes(b));
}
