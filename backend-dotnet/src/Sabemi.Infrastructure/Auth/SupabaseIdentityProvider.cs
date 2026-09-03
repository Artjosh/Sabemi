using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Auth;
using Sabemi.Domain.Entities;

namespace Sabemi.Infrastructure.Auth;

/// <summary>
/// Delega o desafio de acesso ao GoTrue (Supabase Auth).
/// </summary>
/// <remarks>
/// <b>O que o GoTrue passa a fazer.</b> Gerar o magic link, gerar o código OTP,
/// enviar o e-mail (pelo SMTP dele) e validar o código. O que continua aqui é o
/// pedido de login com <c>selector</c> - e é ele que sustenta o polling
/// cross-device, que o GoTrue não tem.
///
/// <b>Como o clique no celular aprova o pedido do desktop.</b> O
/// <c>redirect_to</c> enviado ao GoTrue carrega o <c>selector</c>. O usuário abre
/// o e-mail no celular, o GoTrue valida o token e redireciona para
/// <c>{base}/auth/supabase/confirm?selector=…</c>. Esse endpoint marca o pedido
/// como aprovado, e o polling que está rodando no desktop recebe a sessão no
/// ciclo seguinte. Sem o selector no <c>redirect_to</c>, o clique autenticaria
/// apenas o celular - que é o comportamento padrão do GoTrue e justamente o que
/// não serve aqui.
///
/// <b>Por que o link do GoTrue não é devolvido na resposta.</b> Ele é montado
/// dentro do GoTrue e nunca passa por este código. É a diferença prática entre
/// os dois modos: no local, a demonstração sem SMTP funciona porque temos o link
/// em mãos; no modo Supabase, sem SMTP configurado o link fica no LOG DO
/// CONTAINER do GoTrue. Está documentado no <c>.env</c>, porque é o tipo de coisa
/// que faz alguém concluir que "o login parou de funcionar".
/// </remarks>
public sealed class SupabaseIdentityProvider(
    HttpClient http,
    IClock clock,
    IOptions<SupabaseAuthOptions> opcoes,
    IOptions<AuthOptions> authOpcoes,
    ILogger<SupabaseIdentityProvider> logger) : IIdentityProvider
{
    private readonly SupabaseAuthOptions _opcoes = opcoes.Value;
    private readonly AuthOptions _auth = authOpcoes.Value;

    public IdentityProvider Kind => IdentityProvider.Supabase;

    public async Task<ChallengeResult> StartChallengeAsync(
        string email,
        string selector,
        CancellationToken cancellationToken = default)
    {
        var pedido = LoginRequest.CreateDelegado(
            email, selector, clock.UtcNow, _auth.MagicLinkTtl);

        // O selector viaja no `redirect_to`: é o que liga o clique no celular ao
        // pedido que está sendo pollado no desktop.
        var redirect =
            $"{_auth.PublicBaseUrl.TrimEnd('/')}/auth/supabase/confirm"
            + $"?selector={Uri.EscapeDataString(selector)}";

        var pedidoOtp = new PedidoDeOtp
        {
            Email = email,

            // `true`: não há tela de cadastro neste sistema - o primeiro acesso
            // com um e-mail cria a conta, igual ao modo local. Com `false`, um
            // e-mail novo receberia um erro em vez de um convite.
            CreateUser = true,
        };

        try
        {
            using var resposta = await http.PostAsJsonAsync(
                $"/auth/v1/otp?redirect_to={Uri.EscapeDataString(redirect)}",
                pedidoOtp,
                cancellationToken);

            if (resposta.IsSuccessStatusCode)
            {
                logger.LogInformation(
                    "Desafio de acesso delegado ao GoTrue para {Email}.", email);

                // `EmailEnviado: true` = o GoTrue ACEITOU o pedido. Ele envia o
                // e-mail de forma assíncrona, então isto não é confirmação de
                // entrega - e é o máximo que se pode afirmar sem inventar. Sem
                // SMTP configurado, o GoTrue registra o link no próprio log.
                //
                // O link e o código são `null`: eles vivem dentro do GoTrue e
                // nunca passam por aqui.
                return new ChallengeResult(pedido, EmailEnviado: true, MagicUrl: null, OtpCode: null);
            }

            var corpo = await resposta.Content.ReadAsStringAsync(cancellationToken);

            logger.LogError(
                "O GoTrue recusou o desafio para {Email}: HTTP {Status}. Resposta: {Corpo}",
                email, (int)resposta.StatusCode, Truncar(corpo, 500));

            return new ChallengeResult(pedido, EmailEnviado: false, MagicUrl: null, OtpCode: null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // O pedido é devolvido de todo modo, e quem chama vai persistí-lo.
            // Parece contraintuitivo gravar um pedido cujo desafio falhou, mas é
            // o comportamento certo: o selector já foi entregue ao cliente, que
            // já está pollando. Um pedido ausente daria 404 e a tela diria "seu
            // acesso expirou" - quando o que houve foi uma falha de envio.
            logger.LogError(ex, "Falha ao falar com o GoTrue para {Email}.", email);
            return new ChallengeResult(pedido, EmailEnviado: false, MagicUrl: null, OtpCode: null);
        }
    }

    public async Task<OtpVerification> VerifyOtpAsync(
        LoginRequest pedido,
        string code,
        CancellationToken cancellationToken = default)
    {
        var verificacao = new PedidoDeVerificacao
        {
            Email = pedido.Email,
            Token = code.Trim(),

            // `email` é o tipo do OTP de acesso do GoTrue. `magiclink` valida o
            // token longo do link, que não é o que o usuário digita.
            Type = "email",
        };

        try
        {
            using var resposta = await http.PostAsJsonAsync(
                "/auth/v1/verify", verificacao, cancellationToken);

            if (resposta.IsSuccessStatusCode)
            {
                return OtpVerification.Valido;
            }

            // 400/401/403 = o GoTrue respondeu e disse que o código não serve.
            // Qualquer outro status é problema DELE, não do código - e a
            // distinção importa: contar tentativa por indisponibilidade
            // consumiria o orçamento do usuário por uma falha que não é dele.
            if (resposta.StatusCode is HttpStatusCode.BadRequest
                or HttpStatusCode.Unauthorized
                or HttpStatusCode.Forbidden)
            {
                return OtpVerification.Invalido;
            }

            var corpo = await resposta.Content.ReadAsStringAsync(cancellationToken);

            logger.LogError(
                "O GoTrue falhou ao verificar o codigo de {Email}: HTTP {Status}. Resposta: {Corpo}",
                pedido.Email, (int)resposta.StatusCode, Truncar(corpo, 500));

            return OtpVerification.Indisponivel;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Falha ao verificar o codigo de {Email} no GoTrue.", pedido.Email);
            return OtpVerification.Indisponivel;
        }
    }

    public async Task<string?> VerifyAccessTokenAsync(
        string accessToken,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return null;
        }

        // `GET /auth/v1/user` com o token no Authorization: e o GoTrue quem diz
        // se o token vale e de quem ele e.
        //
        // <b>Por que perguntar ao GoTrue em vez de validar a assinatura aqui.</b>
        // Validar localmente com o `GOTRUE_JWT_SECRET` seria mais rapido e nao
        // exigiria rede - mas aceitaria um token JA REVOGADO. Um logout no
        // GoTrue, ou um usuario banido, continuaria autenticando por todo o
        // tempo de vida do JWT. Para o passo que decide "esta pessoa abriu o
        // e-mail e pode entrar", a resposta autoritativa vale a chamada.
        using var requisicao = new HttpRequestMessage(HttpMethod.Get, "/auth/v1/user");
        requisicao.Headers.Authorization = new("Bearer", accessToken);

        try
        {
            using var resposta = await http.SendAsync(requisicao, cancellationToken);

            if (!resposta.IsSuccessStatusCode)
            {
                logger.LogWarning(
                    "Token de acesso recusado pelo GoTrue: HTTP {Status}.",
                    (int)resposta.StatusCode);

                return null;
            }

            var usuario = await resposta.Content.ReadFromJsonAsync<UsuarioDoGoTrue>(
                cancellationToken);

            // Um usuario sem e-mail nao serve: e por e-mail que este sistema
            // identifica o operador, e e com ele que a comparacao com o pedido e
            // feita.
            return string.IsNullOrWhiteSpace(usuario?.Email)
                ? null
                : usuario.Email.Trim().ToLowerInvariant();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // `null` = nao autenticado. Nao ha caminho de "talvez" aqui: na
            // duvida, o acesso e negado.
            logger.LogError(ex, "Falha ao validar o token de acesso no GoTrue.");
            return null;
        }
    }

    private static string Truncar(string valor, int max)
        => valor.Length <= max ? valor : valor[..max];

    // ------------------------------------------------------------ contrato

    private sealed class PedidoDeOtp
    {
        [JsonPropertyName("email")]
        public required string Email { get; init; }

        [JsonPropertyName("create_user")]
        public required bool CreateUser { get; init; }
    }

    /// <summary>Resposta de <c>GET /auth/v1/user</c> - só o campo que interessa.</summary>
    private sealed class UsuarioDoGoTrue
    {
        [JsonPropertyName("email")]
        public string? Email { get; init; }
    }

    private sealed class PedidoDeVerificacao
    {
        [JsonPropertyName("email")]
        public required string Email { get; init; }

        [JsonPropertyName("token")]
        public required string Token { get; init; }

        [JsonPropertyName("type")]
        public required string Type { get; init; }
    }
}
