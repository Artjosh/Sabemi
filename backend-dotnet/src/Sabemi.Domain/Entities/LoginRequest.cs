namespace Sabemi.Domain.Entities;

/// <summary>Estado de um pedido de login passwordless.</summary>
public enum LoginRequestStatus
{
    /// <summary>Criado; ninguem confirmou ainda. O polling devolve "pending".</summary>
    Pendente,

    /// <summary>Confirmado (link ou OTP). O proximo polling troca por uma sessao.</summary>
    Aprovado
}

/// <summary>
/// Pedido de login passwordless com confirmacao cross-device por polling.
/// </summary>
/// <remarks>
/// Esta e a peca central da feature de autenticacao por polling. O desenho
/// separa deliberadamente tres identificadores:
///
/// * <see cref="Selector"/> - publico. Fica na aba que iniciou o login e viaja
///   em toda chamada de polling. Sozinho nao autentica ninguem, entao pode ser
///   repetido a cada 2,5s sem risco.
/// * <see cref="MagicTokenHash"/> - segredo. Viaja apenas no link do e-mail e
///   pode ser aberto em QUALQUER aparelho. E o que torna o fluxo cross-device:
///   pede-se o login no desktop e confirma-se no celular.
/// * <see cref="OtpCodeHash"/> - segredo curto, digitado na propria aba quando o
///   usuario prefere nao sair dela.
///
/// Os dois segredos sao guardados como hash SHA-256. Um vazamento do banco nao
/// entrega logins ativos - diferente de guardar o token em claro.
///
/// O pedido e de uso unico: aprovado e trocado por sessao, e destruido. Um
/// segundo polling com o mesmo selector recebe 404, que o cliente le como
/// "pare de perguntar".
/// </remarks>
public class LoginRequest
{
    public Guid Id { get; private set; } = Guid.CreateVersion7();

    /// <summary>Identificador publico usado no polling.</summary>
    public string Selector { get; private set; } = string.Empty;

    /// <summary>SHA-256 do token do magic link.</summary>
    public string? MagicTokenHash { get; private set; }

    /// <summary>SHA-256 do codigo OTP de 6 digitos.</summary>
    public string? OtpCodeHash { get; private set; }

    public int OtpTentativas { get; private set; }

    public string Email { get; private set; } = string.Empty;

    public LoginRequestStatus Status { get; private set; } = LoginRequestStatus.Pendente;

    public DateTimeOffset CriadoEm { get; private set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset ExpiraEm { get; private set; }

    private LoginRequest() { }

    public static LoginRequest Create(
        string email,
        string selector,
        string magicTokenHash,
        string otpCodeHash,
        DateTimeOffset agora,
        TimeSpan ttl)
        => new()
        {
            Email = email,
            Selector = selector,
            MagicTokenHash = magicTokenHash,
            OtpCodeHash = otpCodeHash,
            CriadoEm = agora,
            ExpiraEm = agora.Add(ttl)
        };

    public bool IsExpired(DateTimeOffset agora) => agora > ExpiraEm;

    /// <summary>Aprova o pedido. Chamado pelo link do e-mail ou pelo OTP correto.</summary>
    public void Approve() => Status = LoginRequestStatus.Aprovado;

    /// <summary>Contabiliza um OTP incorreto, para limitar forca bruta.</summary>
    public void RegisterFailedOtpAttempt() => OtpTentativas += 1;

    public bool HasExhaustedOtpAttempts(int max) => OtpTentativas >= max;
}

/// <summary>
/// Operador do painel administrativo.
/// </summary>
/// <remarks>
/// Nao ha tela de cadastro: o primeiro login com um e-mail cria a conta. Nao ha
/// coluna de senha porque nao ha senha - o unico fator e a posse da caixa de
/// e-mail.
/// </remarks>
public class AppUser
{
    public Guid Id { get; private set; } = Guid.CreateVersion7();

    public string Email { get; private set; } = string.Empty;

    public DateTimeOffset CriadoEm { get; private set; } = DateTimeOffset.UtcNow;

    private AppUser() { }

    public static AppUser Create(string email, DateTimeOffset agora)
        => new() { Email = email, CriadoEm = agora };
}
