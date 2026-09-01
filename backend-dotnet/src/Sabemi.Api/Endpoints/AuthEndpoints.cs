using System.Security.Claims;
using Microsoft.Extensions.Options;
using Sabemi.Application.Auth;
using Sabemi.Application.Contracts;

namespace Sabemi.Api.Endpoints;

/// <summary>
/// Endpoints do login passwordless com polling.
/// </summary>
/// <remarks>
/// Tudo aqui e anonimo por natureza, exceto <c>/auth/me</c>: sao os endpoints
/// que precedem a existencia de uma sessao. A protecao contra abuso e o rate
/// limit registrado no host, nao a autenticacao.
/// </remarks>
public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/auth").WithTags("auth");

        group.MapPost("/magic-link", StartLogin)
            .AllowAnonymous()
            .RequireRateLimiting("auth")
            .WithSummary("Inicia um pedido de login passwordless")
            .Produces<MagicLinkStartDto>()
            .Produces<ProblemDetailsDto>(StatusCodes.Status400BadRequest);

        group.MapGet("/confirm", Confirm)
            .AllowAnonymous()
            .WithSummary("Alvo do link do e-mail - aprova o login em qualquer dispositivo");

        group.MapPost("/verify-otp", VerifyOtp)
            .AllowAnonymous()
            .RequireRateLimiting("auth")
            .WithSummary("Valida o codigo de 6 digitos")
            .Produces<LoginStatusDto>()
            .Produces<ProblemDetailsDto>(StatusCodes.Status400BadRequest)
            .Produces<ProblemDetailsDto>(StatusCodes.Status404NotFound)
            .Produces<ProblemDetailsDto>(StatusCodes.Status429TooManyRequests);

        group.MapPost("/login-status", Poll)
            .AllowAnonymous()
            .WithSummary("Polling - troca o selector por uma sessao quando aprovado")
            .Produces<LoginStatusDto>()
            .Produces<ProblemDetailsDto>(StatusCodes.Status404NotFound);

        group.MapGet("/me", Me)
            .RequireAuthorization()
            .WithSummary("Dados do usuario autenticado")
            .Produces<UserDto>()
            .Produces<ProblemDetailsDto>(StatusCodes.Status401Unauthorized);

        return app;
    }

    private static async Task<IResult> StartLogin(
        MagicLinkRequest request, AuthService auth, CancellationToken ct)
    {
        var resultado = await auth.StartAsync(request.Email, ct);

        return resultado.Ok
            ? Results.Ok(resultado.Value)
            : Results.Json(
                ProblemDetailsDto.Of(resultado.Message!, "invalid_email"),
                statusCode: StatusCodes.Status400BadRequest);
    }

    /// <summary>
    /// Alvo do link do e-mail.
    /// </summary>
    /// <remarks>
    /// Devolve HTML e nao JSON porque quem abre isto e um navegador vindo do
    /// aplicativo de e-mail, possivelmente em outro aparelho, e a unica coisa que
    /// a pessoa precisa ler e "pode voltar para a outra aba". A aba de origem
    /// descobre a aprovacao sozinha, no proximo ciclo de polling.
    /// </remarks>
    private static async Task<IResult> Confirm(
        string? token, AuthService auth, IOptions<AuthOptions> options, CancellationToken ct)
    {
        var ok = await auth.ConfirmAsync(token, ct);

        return Results.Content(
            ConfirmationPage.Render(ok),
            "text/html; charset=utf-8",
            statusCode: ok ? StatusCodes.Status200OK : StatusCodes.Status400BadRequest);
    }

    private static async Task<IResult> VerifyOtp(
        VerifyOtpRequest request, AuthService auth, CancellationToken ct)
    {
        var resultado = await auth.VerifyOtpAsync(request.Selector, request.Code, ct);

        if (resultado.Ok) return Results.Ok(resultado.Value);

        var (status, code) = resultado.Failure switch
        {
            AuthFailure.NotFound => (StatusCodes.Status404NotFound, "login_request_not_found"),
            AuthFailure.TooManyAttempts => (StatusCodes.Status429TooManyRequests, "too_many_attempts"),
            _ => (StatusCodes.Status400BadRequest, "invalid_code")
        };

        return Results.Json(ProblemDetailsDto.Of(resultado.Message!, code), statusCode: status);
    }

    /// <summary>
    /// O polling.
    /// </summary>
    /// <remarks>
    /// Duas respostas so: <c>200 pending</c> (continue perguntando) ou
    /// <c>200 approved</c> com o token (pare, voce entrou). Um <c>404</c> tambem
    /// encerra o polling - o pedido expirou ou ja foi consumido. Nao ha estado
    /// em que o cliente fique perguntando para sempre.
    /// </remarks>
    private static async Task<IResult> Poll(string? selector, AuthService auth, CancellationToken ct)
    {
        var resultado = await auth.PollAsync(selector, ct);

        return resultado.Ok
            ? Results.Ok(resultado.Value)
            : Results.Json(
                ProblemDetailsDto.Of(resultado.Message!, "login_request_not_found"),
                statusCode: StatusCodes.Status404NotFound);
    }

    private static async Task<IResult> Me(ClaimsPrincipal principal, AuthService auth, CancellationToken ct)
    {
        var sub = principal.FindFirstValue(ClaimTypes.NameIdentifier)
                  ?? principal.FindFirstValue("sub");

        if (!Guid.TryParse(sub, out var id))
        {
            return Results.Json(
                ProblemDetailsDto.Of("Sessao invalida.", "invalid_session"),
                statusCode: StatusCodes.Status401Unauthorized);
        }

        var user = await auth.GetUserAsync(id, ct);

        return user is null
            ? Results.Json(
                ProblemDetailsDto.Of("Usuario nao encontrado.", "user_not_found"),
                statusCode: StatusCodes.Status401Unauthorized)
            : Results.Ok(user);
    }
}

/// <summary>Pagina de confirmacao mostrada depois de clicar o link do e-mail.</summary>
internal static class ConfirmationPage
{
    public static string Render(bool ok)
    {
        var cor = ok ? "#16a34a" : "#dc2626";
        var icone = ok ? "&#10003;" : "&#10007;";
        var titulo = ok ? "Acesso confirmado" : "Link invalido";
        var mensagem = ok
            ? "Pode voltar para a aba onde voce iniciou o login. Ela entrara sozinha em alguns segundos."
            : "Este link expirou ou ja foi utilizado. Solicite um novo acesso.";

        return $$"""
        <!doctype html>
        <html lang="pt-BR">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Sabemi - Acesso</title>
          <style>
            :root { color-scheme: light dark; }
            body {
              margin: 0; min-height: 100vh; display: grid; place-items: center;
              background: #0f172a; color: #e2e8f0;
              font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
            }
            .card {
              max-width: 26rem; padding: 2.5rem 2rem; border-radius: 1rem; text-align: center;
              background: #1e293b; border: 1px solid #334155;
            }
            .badge {
              width: 3.5rem; height: 3.5rem; border-radius: 999px; margin: 0 auto 1.25rem;
              display: grid; place-items: center; font-size: 1.75rem; font-weight: 700;
              background: {{cor}}22; color: {{cor}};
            }
            h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
            p { color: #94a3b8; line-height: 1.6; margin: 0; font-size: .95rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge">{{icone}}</div>
            <h1>{{titulo}}</h1>
            <p>{{mensagem}}</p>
          </div>
        </body>
        </html>
        """;
    }
}
