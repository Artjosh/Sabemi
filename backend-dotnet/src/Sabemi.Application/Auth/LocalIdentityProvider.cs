using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Domain.Entities;

namespace Sabemi.Application.Auth;

/// <summary>
/// Magic link e OTP próprios: nós geramos, guardamos o hash e enviamos.
/// </summary>
/// <remarks>
/// É o modo padrão, e o que a task pede: o fluxo passwordless com confirmação
/// cross-device, sem depender de nenhum serviço externo além do envio do e-mail
/// - que também é opcional (sem provedor, o link vai para o log).
///
/// <b>Os segredos são guardados como hash SHA-256.</b> Um vazamento do banco não
/// entrega logins ativos. SHA-256 sem salt basta aqui, e a razão é específica:
/// estes valores têm 32 bytes de entropia e vida de 15 minutos, então não há
/// dicionário a proteger - diferente de uma senha escolhida por humano, onde
/// bcrypt/argon2 seriam obrigatórios.
/// </remarks>
public sealed class LocalIdentityProvider(
    IClock clock,
    ILoginNotificationSender notifier,
    IOptions<AuthOptions> options) : IIdentityProvider
{
    private readonly AuthOptions _options = options.Value;

    public IdentityProvider Kind => IdentityProvider.Local;

    public async Task<ChallengeResult> StartChallengeAsync(
        string email,
        string selector,
        CancellationToken cancellationToken = default)
    {
        var agora = clock.UtcNow;
        var magicToken = GerarToken(32);
        var otpCode = GerarOtp();

        var pedido = LoginRequest.Create(
            email, selector, Hash(magicToken), Hash(otpCode), agora, _options.MagicLinkTtl);

        var magicUrl =
            $"{_options.PublicBaseUrl.TrimEnd('/')}/auth/confirm?token={Uri.EscapeDataString(magicToken)}";

        // Uma falha de envio não invalida o pedido: ele já existe e o usuário
        // pode entrar pelo link do log, ou pedir de novo.
        var enviado = await notifier.SendAsync(email, magicUrl, otpCode, cancellationToken);

        return new ChallengeResult(pedido, enviado, magicUrl, otpCode);
    }

    public Task<OtpVerification> VerifyOtpAsync(
        LoginRequest pedido,
        string code,
        CancellationToken cancellationToken = default)
    {
        // Um pedido sem hash não pode ser validado aqui. Acontece se o provedor
        // for trocado com pedidos em voo: o pedido foi criado no modo Supabase e
        // esta implementação assumiu o lugar. Tratar como inválido (e não
        // estourar) faz o usuário receber "código incorreto" e pedir um acesso
        // novo - que já sairá pelo provedor certo.
        if (pedido.OtpCodeHash is null)
        {
            return Task.FromResult(OtpVerification.Invalido);
        }

        // Comparação em tempo constante: comparar hashes com `==` vazaria, pelo
        // tempo de resposta, quantos caracteres iniciais estão corretos.
        var confere = CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(pedido.OtpCodeHash),
            System.Text.Encoding.UTF8.GetBytes(Hash(code.Trim())));

        return Task.FromResult(confere ? OtpVerification.Valido : OtpVerification.Invalido);
    }

    /// <summary>
    /// Sempre <c>null</c>: neste modo não há provedor externo emitindo token.
    /// </summary>
    /// <remarks>
    /// O endpoint que consome isto (<c>/auth/supabase/confirm</c>) responde 404
    /// no modo local. Devolver <c>null</c> em vez de lançar mantém a decisão em um
    /// só lugar - o endpoint - em vez de espalhar um <c>try/catch</c> por causa de
    /// uma rota que simplesmente não existe neste fluxo.
    /// </remarks>
    public Task<string?> VerifyAccessTokenAsync(
        string accessToken,
        CancellationToken cancellationToken = default)
        => Task.FromResult<string?>(null);

    /// <summary>Token base64url de <paramref name="bytes"/> bytes de entropia.</summary>
    private static string GerarToken(int bytes)
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

    /// <summary>
    /// OTP de 6 dígitos.
    /// </summary>
    /// <remarks>
    /// <c>RandomNumberGenerator.GetInt32</c> e não <c>Random</c>: um código de
    /// acesso previsível a partir do relógio é um código adivinhável.
    /// </remarks>
    private static string GerarOtp()
        => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");

    private static string Hash(string valor)
        => Convert.ToHexString(
            SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(valor))).ToLowerInvariant();
}
