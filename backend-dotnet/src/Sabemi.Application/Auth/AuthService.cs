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
    /// Devolve link e OTP no corpo da resposta, em vez de so por e-mail.
    /// <para>
    /// Quando <c>null</c> (o padrao) a decisao acompanha o ambiente: ligado fora
    /// de producao, desligado em producao. Um valor explicito vale nos dois
    /// sentidos - ver <see cref="ExposeLoginCodes"/>.
    /// </para>
    /// </summary>
    public bool? ExposeLoginCodesInDevelopment { get; set; }

    /// <summary>
    /// Espera minima entre dois pedidos de acesso para o MESMO e-mail.
    /// </summary>
    /// <remarks>
    /// Sem isto, quem nao recebe o e-mail clica "enviar" repetidamente e cada
    /// clique vira uma mensagem de verdade - e um endereco inexistente vira uma
    /// sequencia de hard bounces, que e o que corroi reputacao de envio.
    /// <para>
    /// Um minuto e o mesmo valor que o GoTrue usa por padrao
    /// (<c>GOTRUE_SMTP_MAX_FREQUENCY</c>), entao os dois modos de autenticacao se
    /// comportam igual. Zero desliga.
    /// </para>
    /// <para>
    /// A conta e feita na tabela de pedidos, que os DOIS backends compartilham:
    /// pedir pelo .NET e repetir pelo VINEXT esbarra no mesmo prazo, porque a
    /// espera e do e-mail, nao do processo que atendeu.
    /// </para>
    /// </remarks>
    /// <remarks>
    /// Em SEGUNDOS, e nao <c>TimeSpan</c>, para caber em uma unica variavel de
    /// ambiente compartilhada com o backend VINEXT
    /// (<c>AUTH_RESEND_COOLDOWN_SECONDS</c>). O binding de <c>TimeSpan</c> exige
    /// <c>00:01:00</c>, que o Node nao entende - e o projeto ja pagou por essa
    /// divergencia uma vez, quando o mesmo numero vivia em duas variaveis com
    /// formatos diferentes.
    /// </remarks>
    public int ResendCooldownSeconds { get; set; } = 60;

    /// <summary>A espera de reenvio como intervalo.</summary>
    public TimeSpan ResendCooldown => TimeSpan.FromSeconds(Math.Max(0, ResendCooldownSeconds));

    /// <summary>Preenchido pelo host a partir do ambiente.</summary>
    public bool IsProduction { get; set; }

    /// <summary>URL publica da API, usada para montar o link de confirmacao.</summary>
    public string PublicBaseUrl { get; set; } = "http://localhost:8080";

    /// <summary>
    /// Decisao final sobre expor link e OTP na resposta. Falha fechada por
    /// padrao, com uma saida explicita.
    /// <para>
    /// A versao anterior travava em <c>!IsProduction</c>, e isso era um beco sem
    /// saida: uma imagem de producao sem provedor de e-mail ficava sem NENHUM
    /// caminho de login - o usuario pedia acesso, recebia <c>null</c> e nao havia
    /// como entrar. Quem opera precisa poder dizer "esta stack e uma
    /// demonstracao, entregue o codigo na resposta".
    /// </para>
    /// <para>
    /// Ligar em producao e uma decisao consciente e ruidosa: exige
    /// <c>Auth:ExposeLoginCodesInDevelopment=true</c> escrito a mao, e o host
    /// registra um aviso na inicializacao. <c>docker-compose.prod.yml</c> fixa
    /// <c>false</c>. Nenhum campo da requisicao influencia esta propriedade.
    /// </para>
    /// </summary>
    public bool ExposeLoginCodes => ExposeLoginCodesInDevelopment ?? !IsProduction;
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
    InvalidEmail,

    /// <summary>
    /// Pedido repetido para o mesmo e-mail antes do prazo de reenvio.
    /// </summary>
    /// <remarks>
    /// Distinto de <see cref="TooManyAttempts"/>, que fala de tentativas de OTP e
    /// destroi o pedido. Aqui o pedido anterior continua VALIDO: o e-mail pode
    /// chegar a qualquer momento, e o link dele ainda funciona.
    /// </remarks>
    ResendTooSoon,

    /// <summary>
    /// O provedor de identidade externo nao pode ser consultado.
    /// </summary>
    /// <remarks>
    /// Separado de <see cref="InvalidCode"/> de proposito. Um GoTrue fora do ar
    /// nao e um codigo errado: contar como tentativa faria uma queda de dois
    /// segundos consumir o orcamento do usuario, e a tela precisa dizer "tente
    /// de novo em instantes" em vez de "codigo incorreto". Vira HTTP 503, e nao
    /// 401 - o cliente nao errou nada.
    /// </remarks>
    ProviderUnavailable
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
    IIdentityProvider identityProvider,
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

        // Espera de reenvio. Vem ANTES de invalidar o anterior de proposito: quem
        // pede de novo cedo demais fica com o pedido que ja tem, e o e-mail que
        // talvez esteja a caminho continua servindo. Invalidar e depois recusar
        // deixaria a pessoa sem nenhum caminho de entrada.
        if (_options.ResendCooldown > TimeSpan.Zero)
        {
            var recente = await db.LoginRequests
                .Where(p => p.Email == email && p.Status == LoginRequestStatus.Pendente)
                .OrderByDescending(p => p.CriadoEm)
                .FirstOrDefaultAsync(ct);

            if (recente is not null)
            {
                var faltam = recente.CriadoEm + _options.ResendCooldown - agora;
                if (faltam > TimeSpan.Zero)
                {
                    var segundos = (int)Math.Ceiling(faltam.TotalSeconds);

                    return AuthResult<MagicLinkStartDto>.Fail(
                        AuthFailure.ResendTooSoon,
                        $"Um acesso ja foi enviado. Aguarde {segundos}s para pedir outro.");
                }
            }
        }

        // Um novo pedido invalida os anteriores do mesmo e-mail: sem isso, links
        // antigos continuariam validos e o usuario que pediu duas vezes teria
        // dois codigos funcionando ao mesmo tempo.
        await InvalidatePendingAsync(email, ct);

        // O selector e gerado AQUI, e nao pelo provedor: ele e a peca do fluxo
        // que nao pertence a nenhum dos dois modos. E o que sustenta o polling
        // cross-device, e no modo Supabase e ele que viaja no `redirect_to` para
        // ligar o clique no celular ao pedido pollado no desktop.
        var selector = GenerateToken(24);

        // O provedor decide o resto: gerar e guardar os segredos (modo local) ou
        // delegar tudo ao GoTrue (modo Supabase). Uma falha no envio NAO derruba
        // a requisicao nem descarta o pedido - o selector ja vai para o cliente,
        // que ja comeca a pollar, e um pedido ausente daria 404 com a tela
        // dizendo "seu acesso expirou" quando o que houve foi falha de envio.
        ChallengeResult desafio;
        try
        {
            desafio = await identityProvider.StartChallengeAsync(email, selector, ct);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Falha ao iniciar o desafio de acesso para {Email}.", email);

            return AuthResult<MagicLinkStartDto>.Fail(
                AuthFailure.ProviderUnavailable,
                "Nao foi possivel iniciar o acesso agora. Tente novamente em instantes.");
        }

        db.LoginRequests.Add(desafio.Pedido);
        await db.SaveChangesAsync(ct);

        var expoe = _options.ExposeLoginCodes;

        return AuthResult<MagicLinkStartDto>.Success(new MagicLinkStartDto
        {
            Selector = selector,
            Email = email,
            EmailSent = desafio.EmailEnviado,

            // `expoe` decide se PODE mostrar; o provedor decide se TEM o que
            // mostrar. No modo Supabase os dois vem nulos - o link vive dentro do
            // GoTrue e nunca passa por aqui.
            DevMagicUrl = expoe ? desafio.MagicUrl : null,
            DevOtpCode = expoe ? desafio.OtpCode : null,

            Message = MontarMensagem(desafio, expoe),
        });
    }

    /// <summary>
    /// O texto que a tela mostra depois de pedir acesso.
    /// </summary>
    /// <remarks>
    /// Os tres casos existem porque cada um manda o usuario fazer uma coisa
    /// diferente, e errar aqui e mandá-lo esperar por algo que nao vem. O caso do
    /// meio - envio aceito, mas sem link em maos - so acontece no modo Supabase.
    /// </remarks>
    private static string MontarMensagem(ChallengeResult desafio, bool expoe)
    {
        if (desafio.EmailEnviado)
        {
            return "Enviamos um link e um codigo de acesso para o seu e-mail.";
        }

        return expoe && desafio.MagicUrl is not null
            ? "Use o link ou o codigo abaixo para entrar."
            : "Nao foi possivel enviar o e-mail agora. Tente novamente em instantes.";
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
    /// Aprova o pedido a partir de um token de acesso do provedor externo.
    /// </summary>
    /// <remarks>
    /// <b>O caminho cross-device do modo Supabase.</b> O usuario abre o e-mail no
    /// celular; o GoTrue valida o magic link dele e redireciona para um endpoint
    /// nosso levando o <c>selector</c> na query e o token de acesso no fragmento
    /// da URL. Uma pagina nossa le o fragmento e chama este metodo, e o polling
    /// que roda no desktop recebe a sessao no ciclo seguinte.
    ///
    /// <b>As duas verificacoes que fazem isto ser seguro.</b> O selector e
    /// PUBLICO - ele viaja em cada chamada de polling -, entao aprovar so por ele
    /// deixaria qualquer pessoa que observasse uma requisicao entrar na conta
    /// alheia. Por isso:
    ///
    /// <list type="number">
    /// <item>o token e validado CONTRA O PROVEDOR (nao localmente), o que tambem
    /// recusa um token ja revogado;</item>
    /// <item>o e-mail que o provedor devolve e comparado com o do pedido - sem
    /// isso, um token valido de OUTRA conta aprovaria este.</item>
    /// </list>
    ///
    /// Devolve <c>false</c> para tudo que nao passar. Nenhuma distincao entre
    /// "selector inexistente", "token invalido" e "e-mail divergente chega ao
    /// cliente: essa granularidade so ajudaria quem esta sondando.
    /// </remarks>
    public async Task<bool> ApproveWithProviderTokenAsync(
        string? selector,
        string? accessToken,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(selector) || string.IsNullOrWhiteSpace(accessToken))
        {
            return false;
        }

        var pedido = await db.LoginRequests.FirstOrDefaultAsync(r => r.Selector == selector, ct);

        if (pedido is null)
        {
            return false;
        }

        if (pedido.IsExpired(clock.UtcNow))
        {
            db.LoginRequests.Remove(pedido);
            await db.SaveChangesAsync(ct);
            return false;
        }

        // Um pedido do modo LOCAL nao pode ser aprovado por token externo: ele
        // tem o proprio magic token, e aceitar os dois caminhos daria duas formas
        // de aprovar o mesmo pedido - uma delas nao prevista quando ele foi
        // criado.
        if (pedido.Provedor != identityProvider.Kind)
        {
            logger.LogWarning(
                "Tentativa de aprovar por token um pedido do provedor {Provedor}.",
                pedido.Provedor);

            return false;
        }

        var emailDoToken = await identityProvider.VerifyAccessTokenAsync(accessToken, ct);

        if (emailDoToken is null)
        {
            return false;
        }

        // A comparacao que impede um token valido de outra conta aprovar este
        // pedido. `OrdinalIgnoreCase` porque os dois lados ja vem normalizados,
        // mas a comparacao nao deve depender disso.
        if (!string.Equals(emailDoToken, pedido.Email, StringComparison.OrdinalIgnoreCase))
        {
            logger.LogWarning(
                "Token de acesso de {EmailDoToken} nao corresponde ao pedido de {EmailDoPedido}.",
                emailDoToken, pedido.Email);

            return false;
        }

        pedido.Approve();

        // A conta e criada aqui, na confirmacao, e nao ao pedir o acesso: do
        // contrario bastaria digitar e-mails para popular a tabela de usuarios
        // com contas que nunca provaram posse da caixa.
        await GetOrCreateUserAsync(pedido.Email, ct);
        await db.SaveChangesAsync(ct);

        logger.LogInformation(
            "Login aprovado por magic link do {Provedor} para {Email}.",
            identityProvider.Kind, pedido.Email);

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

        // Quem valida e o provedor: comparacao de hash em tempo constante no modo
        // local, chamada ao GoTrue no modo Supabase.
        var verificacao = await identityProvider.VerifyOtpAsync(pedido, code, ct);

        if (verificacao == OtpVerification.Indisponivel)
        {
            // NAO conta tentativa. Uma queda do provedor nao pode consumir o
            // orcamento do usuario e obriga-lo a pedir um acesso novo.
            return AuthResult<LoginStatusDto>.Fail(
                AuthFailure.ProviderUnavailable,
                "Nao foi possivel verificar o codigo agora. Tente novamente em instantes.");
        }

        if (verificacao == OtpVerification.Invalido)
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
