using System.Text.Json.Serialization;

namespace Sabemi.Application.Contracts;

/// <summary>Pedido de magic link.</summary>
public sealed record MagicLinkRequest
{
    [JsonPropertyName("email")]
    public string? Email { get; init; }
}

/// <summary>
/// Resposta ao inicio do login. O <c>selector</c> e o que a aba de origem guarda
/// para fazer o polling.
/// </summary>
public sealed record MagicLinkStartDto
{
    [JsonPropertyName("selector")]
    public required string Selector { get; init; }

    [JsonPropertyName("email")]
    public required string Email { get; init; }

    [JsonPropertyName("email_sent")]
    public required bool EmailSent { get; init; }

    /// <summary>
    /// Link de confirmacao devolvido no corpo apenas em desenvolvimento, para a
    /// demonstracao rodar sem servidor de e-mail. Em producao e sempre
    /// <c>null</c>, decidido no servidor - nenhum campo do request altera isso.
    /// </summary>
    [JsonPropertyName("dev_magic_url")]
    public string? DevMagicUrl { get; init; }

    /// <summary>Codigo OTP, sob a mesma regra de <see cref="DevMagicUrl"/>.</summary>
    [JsonPropertyName("dev_otp_code")]
    public string? DevOtpCode { get; init; }

    [JsonPropertyName("message")]
    public required string Message { get; init; }
}

/// <summary>Verificacao do codigo de 6 digitos (mesmo dispositivo).</summary>
public sealed record VerifyOtpRequest
{
    [JsonPropertyName("selector")]
    public string? Selector { get; init; }

    [JsonPropertyName("code")]
    public string? Code { get; init; }
}

/// <summary>
/// Resposta do polling e do OTP.
/// </summary>
/// <remarks>
/// Enquanto o pedido esta pendente, so <c>status</c> e <c>authenticated</c> vem
/// preenchidos - resposta minima porque ela e pedida a cada 2,5s. Quando aprova,
/// traz o token; o gateway do frontend o intercepta e grava em cookie httpOnly,
/// de modo que ele nunca chega ao JavaScript do browser.
/// </remarks>
public sealed record LoginStatusDto
{
    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("authenticated")]
    public required bool Authenticated { get; init; }

    [JsonPropertyName("access_token")]
    public string? AccessToken { get; init; }

    [JsonPropertyName("expires_in")]
    public int? ExpiresIn { get; init; }

    [JsonPropertyName("user")]
    public UserDto? User { get; init; }

    public static LoginStatusDto Pending() => new() { Status = "pending", Authenticated = false };
}

public sealed record UserDto
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("email")]
    public required string Email { get; init; }

    [JsonPropertyName("criado_em")]
    public required DateTimeOffset CriadoEm { get; init; }
}

/// <summary>
/// Formato de erro uniforme (RFC 7807 enxuto).
/// </summary>
/// <remarks>
/// Os dois backends devolvem exatamente esta forma. E o que permite ao frontend
/// ter um unico tratamento de erro: ele le <c>detail</c> e exibe, sem saber qual
/// implementacao respondeu.
/// </remarks>
public sealed record ProblemDetailsDto
{
    [JsonPropertyName("detail")]
    public required string Detail { get; init; }

    [JsonPropertyName("code")]
    public string? Code { get; init; }

    [JsonPropertyName("errors")]
    public IReadOnlyDictionary<string, string[]>? Errors { get; init; }

    public static ProblemDetailsDto Of(string detail, string? code = null) =>
        new() { Detail = detail, Code = code };
}
