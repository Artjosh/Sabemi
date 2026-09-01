using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Contracts;
using Sabemi.Domain.Entities;

namespace Sabemi.Application.Auth;

/// <summary>Configuracao do login passwordless.</summary>
public sealed class AuthOptions
{
    public const string SectionName = "Auth";

    /// <summary>Validade do pedido de login - e tambem o teto do polling.</summary>
    public TimeSpan MagicLinkTtl { get; set; } = TimeSpan.FromMinutes(15);

    /// <summary>Tentativas de OTP antes de destruir o pedido.</summary>
    public int OtpMaxAttempts { get; set; } = 5;

    /// <summary>Validade do JWT de sessao emitido apos a aprovacao.</summary>
    public TimeSpan SessionTtl { get; set; } = TimeSpan.FromHours(24);

    /// <summary>
    /// Devolve link e OTP no corpo da resposta, para a demonstracao rodar sem
    /// SMTP. Ignorado quando <see cref="IsProduction"/> - ver
    /// <see cref="ExposeLoginCodes"/>.
    /// </summary>
    public bool ExposeLoginCodesInDevelopment { get; set; } = true;

    /// <summary>Preenchido pelo host a partir do ambiente.</summary>
    public bool IsProduction { get; set; }

    /// <summary>URL publica da API, usada para montar o link de confirmacao.</summary>
    public string PublicBaseUrl { get; set; } = "http://localhost:8080";

    /// <summary>
    /// Decisao final sobre expor os segredos, e ela falha fechada: em producao e
    /// sempre <c>false</c>, independentemente da configuracao. Vive no servidor e
    /// nenhum campo da requisicao a influencia.
    /// </summary>
    public bool ExposeLoginCodes => !IsProduction && ExposeLoginCodesInDevelopment;
}

/// <summary>Motivos pelos quais um passo do login pode falhar.</summary>
public enum AuthFailure
{
    /// <summary>Pedido inexistente, expirado ou ja consumido. Encerre o polling.</summary>
    NotFound,

    /// <summary>Codigo OTP incorreto - ainda restam tentativas.</summary>
    InvalidCode,

    /// <summary>Tentativas esgotadas; o pedido foi destruido.</summary>
    TooManyAttempts,

    /// <summary>E-mail ausente ou malformado.</summary>
    InvalidEmail
}

/// <summary>Resultado de um passo do login: sucesso com valor, ou motivo da falha.</summary>
public readonly record struct AuthResult<T>(T? Value, AuthFailure? Failure, string? Message)
{
    public bool Ok => Failure is null;
    public static AuthResult<T> Success(T value) => new(value, null, null);
    public static AuthResult<T> Fail(AuthFailure failure, string message) => new(default, failure, message);
}

/// <summary>
/// Login passwordless com confirmacao cross-device por polling.
/// </summary>
/// <remarks>
/// <para><b>O fluxo.</b> O operador informa o e-mail e recebe duas formas de
/// entrar: um link, clicavel em qualquer aparelho, e um codigo de 6 digitos para
/// digitar na propria aba. A aba que iniciou o login fica perguntando
/// <see cref="PollAsync"/> a cada poucos segundos; quando o link e aberto - no
/// celular, por exemplo - o proximo polling ja devolve a sessao e a aba do
/// desktop entra sozinha. Nao existe cadastro: o primeiro login cria a conta.</para>
///
/// <para><b>Por que polling e nao WebSocket.</b> O evento que se espera aqui e
/// unico, acontece uma vez por login e tem prazo curto. Uma conexao persistente
/// so para aguarda-lo custaria mais - em infraestrutura e em modos de falha (
/// reconexao, proxies que cortam conexoes ociosas, balanceador com aderencia de
/// sessao) - do que uma requisicao leve a cada 2,5s que termina em minutos.</para>
///
/// <para><b>Por que o selector e separado do segredo.</b> O polling repete o
/// mesmo identificador dezenas de vezes; se ele fosse o token de aprovacao,
/// bastaria observar o trafego para roubar o login. O selector nao aprova nada:
/// ele so pergunta. Quem aprova e o segredo do link, que trafega uma unica vez.</para>
///
/// <para><b>Encerramento.</b> Um pedido aprovado e trocado por sessao e
/// destruido no mesmo passo. O polling seguinte recebe <see cref="AuthFailure.NotFound"/>,
/// e e assim que o cliente sabe que deve parar - em vez de girar ate o timeout.</para>
/// </remarks>
public sealed class AuthService(
    IAppDbContext db,
    IClock clock,
    ITokenIssuer tokenIssuer,
    ILoginNotificationSender notifier,
    IOptions<AuthOptions> options,
    ILogger<AuthService> logger)
{
    private readonly AuthOptions _options = options.Value;

    /// <summary>Inicia um pedido de login e devolve o selector para o polling.</summary>
    public async Task<AuthResult<MagicLinkStartDto>> StartAsync(string? rawEmail, CancellationToken ct = default)
    {
        var email = rawEmail?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(email) || !IsPlausibleEmail(email))
        {
            return AuthResult<MagicLinkStartDto>.Fail(AuthFailure.InvalidEmail, "Informe um e-mail valido.");
        }

        var agora = clock.UtcNow;

        // Um novo pedido invalida os anteriores do mesmo e-mail: sem isso, links
        // antigos continuariam validos e o usuario que pediu duas vezes teria
        // dois codigos funcionando ao mesmo tempo.
        await InvalidatePendingAsync(email, ct);

        var selector = GenerateToken(24);
        var magicToken = GenerateToken(32);
        var otpCode = GenerateOtp();

        var pedido = LoginRequest.Create(
            email, selector, Hash(magicToken), Hash(otpCode), agora, _options.MagicLinkTtl);

        db.LoginRequests.Add(pedido);
        await db.SaveChangesAsync(ct);

        var magicUrl = $"{_options.PublicBaseUrl.TrimEnd('/')}/auth/confirm?token={Uri.EscapeDataString(magicToken)}";

        // Uma falha no envio nao derruba a requisicao: o pedido ja existe e o
        // usuario pode tentar de novo (e em dev os codigos voltam no corpo).
        bool enviado;
        try
        {
            enviado = await notifier.SendAsync(email, magicUrl, otpCode, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao enviar o e-mail de acesso para {Email}.", email);
            enviado = false;
        }

        var expoe = _options.ExposeLoginCodes;

        return AuthResult<MagicLinkStartDto>.Success(new MagicLinkStartDto
        {
            Selector = selector,
            Email = email,
            EmailSent = enviado,
            DevMagicUrl = expoe ? magicUrl : null,
            DevOtpCode = expoe ? otpCode : null,
            Message = enviado
                ? "Enviamos um link e um codigo de acesso para o seu e-mail."
                : expoe
                    ? "Use o link ou o codigo abaixo para entrar."
                    : "Nao foi possivel enviar o e-mail agora. Tente novamente em instantes."
        });
    }

    /// <summary>
    /// Aprova o pedido a partir do token do link. Chamado pelo aparelho que abriu
    /// o e-mail, que pode nao ser o que iniciou o login.
    /// </summary>
    public async Task<bool> ConfirmAsync(string? magicToken, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(magicToken)) return false;

        var hash = Hash(magicToken);
        var pedido = await db.LoginRequests.FirstOrDefaultAsync(r => r.MagicTokenHash == hash, ct);

        if (pedido is null) return false;

        if (pedido.IsExpired(clock.UtcNow))
        {
            db.LoginRequests.Remove(pedido);
            await db.SaveChangesAsync(ct);
            return false;
        }

        pedido.Approve();

        // A conta e criada aqui, no ato da confirmacao, e nao ao pedir o link:
        // caso contrario bastaria digitar e-mails para popular a tabela de
        // usuarios com contas que nunca provaram posse da caixa.
        await GetOrCreateUserAsync(pedido.Email, ct);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("Login aprovado por magic link para {Email}.", pedido.Email);
        return true;
    }

    /// <summary>
    /// Valida o codigo de 6 digitos e emite a sessao na hora (mesmo dispositivo).
    /// </summary>
    public async Task<AuthResult<LoginStatusDto>> VerifyOtpAsync(string? selector, string? code, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(selector) || string.IsNullOrWhiteSpace(code))
        {
            return AuthResult<LoginStatusDto>.Fail(AuthFailure.NotFound, "Pedido de login invalido.");
        }

        var pedido = await db.LoginRequests.FirstOrDefaultAsync(r => r.Selector == selector, ct);
        if (pedido is null || pedido.IsExpired(clock.UtcNow))
        {
            if (pedido is not null)
            {
                db.LoginRequests.Remove(pedido);
                await db.SaveChangesAsync(ct);
            }
            return AuthResult<LoginStatusDto>.Fail(AuthFailure.NotFound, "Pedido de login nao encontrado ou expirado.");
        }

        if (pedido.HasExhaustedOtpAttempts(_options.OtpMaxAttempts))
        {
            db.LoginRequests.Remove(pedido);
            await db.SaveChangesAsync(ct);
            return AuthResult<LoginStatusDto>.Fail(AuthFailure.TooManyAttempts, "Muitas tentativas. Solicite um novo acesso.");
        }

        // Comparacao em tempo constante: comparar hashes com == vazaria, pelo
        // tempo de resposta, quantos caracteres iniciais estao corretos.
        if (!FixedTimeEquals(pedido.OtpCodeHash, Hash(code.Trim())))
        {
            pedido.RegisterFailedOtpAttempt();
            await db.SaveChangesAsync(ct);
            return AuthResult<LoginStatusDto>.Fail(AuthFailure.InvalidCode, "Codigo incorreto.");
        }

        var user = await GetOrCreateUserAsync(pedido.Email, ct);
        var sessao = IssueSession(user);

        // Uso unico: o pedido morre junto com a emissao da sessao.
        db.LoginRequests.Remove(pedido);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("Login aprovado por OTP para {Email}.", pedido.Email);
        return AuthResult<LoginStatusDto>.Success(sessao);
    }

    /// <summary>
    /// O polling. Devolve "pending" enquanto ninguem confirmou; quando confirmado,
    /// troca o pedido por uma sessao e o consome.
    /// </summary>
    public async Task<AuthResult<LoginStatusDto>> PollAsync(string? selector, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(selector))
        {
            return AuthResult<LoginStatusDto>.Fail(AuthFailure.NotFound, "Pedido de login nao encontrado.");
        }

        var pedido = await db.LoginRequests.FirstOrDefaultAsync(r => r.Selector == selector, ct);

        // Ausente, expirado ou ja consumido caem todos no mesmo 404 - de
        // proposito. Sao indistinguiveis para quem esta de fora, e para o cliente
        // significam a mesma coisa: pare de perguntar.
        if (pedido is null)
        {
            return AuthResult<LoginStatusDto>.Fail(AuthFailure.NotFound, "Pedido de login nao encontrado ou ja consumido.");
        }

        if (pedido.IsExpired(clock.UtcNow))
        {
            db.LoginRequests.Remove(pedido);
            await db.SaveChangesAsync(ct);
            return AuthResult<LoginStatusDto>.Fail(AuthFailure.NotFound, "Pedido de login expirado. Solicite um novo acesso.");
        }

        if (pedido.Status != LoginRequestStatus.Aprovado)
        {
            return AuthResult<LoginStatusDto>.Success(LoginStatusDto.Pending());
        }

        var user = await GetOrCreateUserAsync(pedido.Email, ct);
        var sessao = IssueSession(user);

        db.LoginRequests.Remove(pedido);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("Sessao entregue por polling para {Email}.", pedido.Email);
        return AuthResult<LoginStatusDto>.Success(sessao);
    }

    /// <summary>Remove pedidos vencidos. Chamado periodicamente pelo worker.</summary>
    public async Task<int> PurgeExpiredAsync(CancellationToken ct = default)
    {
        var agora = clock.UtcNow;
        return await db.LoginRequests.Where(r => r.ExpiraEm < agora).ExecuteDeleteAsync(ct);
    }

    public async Task<UserDto?> GetUserAsync(Guid id, CancellationToken ct = default)
    {
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == id, ct);
        return user is null ? null : ToDto(user);
    }

    private LoginStatusDto IssueSession(AppUser user)
    {
        var (token, expiresIn) = tokenIssuer.Issue(user);
        return new LoginStatusDto
        {
            Status = "approved",
            Authenticated = true,
            AccessToken = token,
            ExpiresIn = expiresIn,
            User = ToDto(user)
        };
    }

    private async Task<AppUser> GetOrCreateUserAsync(string email, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Email == email, ct);
        if (user is not null) return user;

        user = AppUser.Create(email, clock.UtcNow);
        db.Users.Add(user);
        await db.SaveChangesAsync(ct);
        return user;
    }

    private async Task InvalidatePendingAsync(string email, CancellationToken ct)
        => await db.LoginRequests.Where(r => r.Email == email).ExecuteDeleteAsync(ct);

    private static UserDto ToDto(AppUser u) => new()
    {
        Id = u.Id.ToString(),
        Email = u.Email,
        CriadoEm = u.CriadoEm
    };

    private static string GenerateToken(int bytes)
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');

    /// <summary>Codigo de 6 digitos por RNG criptografico (nao <c>Random</c>).</summary>
    private static string GenerateOtp()
        => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");

    private static string Hash(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static bool FixedTimeEquals(string? a, string? b)
    {
        if (a is null || b is null) return false;
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
    }

    /// <summary>
    /// Checagem sintatica basica. Validar e-mail por regex e um beco sem saida
    /// conhecido; a verificacao real e a entrega - so entra quem abre a mensagem.
    /// </summary>
    private static bool IsPlausibleEmail(string email)
    {
        var at = email.IndexOf('@');
        return at > 0
            && at < email.Length - 1
            && email.IndexOf('@', at + 1) < 0
            && email.LastIndexOf('.') > at + 1
            && !email.Contains(' ');
    }
}
