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
/// Quem valida a identidade de um pedido de login.
/// </summary>
/// <remarks>
/// <b>Por que a escolha vive na LINHA, e nao so na configuracao.</b> Um pedido
/// criado no modo local guarda os hashes do proprio magic token e do proprio
/// OTP; um criado no modo Supabase nao guarda nenhum dos dois - quem valida e o
/// GoTrue. Se a decisao fosse lida da configuracao no momento da validacao, um
/// reinicio com o provedor trocado transformaria todo pedido em voo em algo
/// invalidavel: o codigo local nao seria mais verificado contra o hash que
/// existe, e o codigo do GoTrue nao existiria. Gravando o provedor, um pedido
/// termina do mesmo jeito que comecou.
/// </remarks>
public enum IdentityProvider
{
    /// <summary>Magic link e OTP proprios, com hash SHA-256 nesta tabela.</summary>
    Local,

    /// <summary>
    /// Magic link e OTP do GoTrue (Supabase Auth). Esta tabela guarda apenas o
    /// selector, que e o que sustenta o polling cross-device.
    /// </summary>
    Supabase
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
///
/// <para><b>No modo Supabase</b> (<see cref="IdentityProvider.Supabase"/>) os
/// dois hashes ficam nulos: o magic link e o OTP sao emitidos e validados pelo
/// GoTrue. O que continua aqui e o <see cref="Selector"/> - e ele que sustenta o
/// polling, porque o GoTrue nao tem esse conceito. E dessa divisao que sai o
/// melhor dos dois: a identidade e verificada por um servico dedicado, e o
/// cross-device continua funcionando.</para>
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

    /// <summary>Quem valida este pedido. Ver <see cref="IdentityProvider"/>.</summary>
    public IdentityProvider Provedor { get; private set; } = IdentityProvider.Local;

    private LoginRequest() { }

    /// <summary>
    /// Pedido validado por nos: os dois segredos ficam aqui, como hash.
    /// </summary>
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
            Provedor = IdentityProvider.Local,
            CriadoEm = agora,
            ExpiraEm = agora.Add(ttl)
        };

    /// <summary>
    /// Pedido validado pelo GoTrue: guarda apenas o selector.
    /// </summary>
    /// <remarks>
    /// Sem <c>magicTokenHash</c> e sem <c>otpCodeHash</c> - e isso e a razao de
    /// existir uma segunda fabrica em vez de parametros opcionais na primeira.
    /// Com parametros opcionais, esquecer de passar os hashes no modo local
    /// criaria em silencio um pedido que nenhum codigo consegue aprovar. Aqui as
    /// duas formas validas de um pedido sao explicitas, e o compilador nao deixa
    /// confundi-las.
    /// </remarks>
    public static LoginRequest CreateDelegado(
        string email,
        string selector,
        DateTimeOffset agora,
        TimeSpan ttl)
        => new()
        {
            Email = email,
            Selector = selector,
            MagicTokenHash = null,
            OtpCodeHash = null,
            Provedor = IdentityProvider.Supabase,
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
