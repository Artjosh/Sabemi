using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Auth;
using Sabemi.Application.Payments;
using Sabemi.Infrastructure.Persistence;
using Sabemi.Infrastructure.Queue;
using Sabemi.Infrastructure.Security;

namespace Sabemi.Infrastructure;

/// <summary>
/// Composicao das dependencias, compartilhada pela API e pelo Worker.
/// </summary>
/// <remarks>
/// Os dois hosts registram exatamente o mesmo grafo. E o que garante que o
/// worker enxergue os dados com as mesmas regras da API - e o que permite aos
/// testes de integracao subir um deles e exercitar o outro.
/// </remarks>
public static class DependencyInjection
{
    public static IServiceCollection AddSabemiInfrastructure(
        this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<ProcessingOptions>()
            .Bind(configuration.GetSection(ProcessingOptions.SectionName))
            .ValidateOnStart();

        services.AddOptions<AuthOptions>()
            .Bind(configuration.GetSection(AuthOptions.SectionName))
            .ValidateOnStart();

        services.AddOptions<WebhookSecurityOptions>()
            .Bind(configuration.GetSection(WebhookSecurityOptions.SectionName))
            .ValidateOnStart();

        // O segredo do JWT e validado na subida, nao no primeiro login. Descobrir
        // que ele esta ausente quando alguem tenta entrar seria descobrir tarde
        // demais; o host recusa iniciar sem ele.
        services.AddOptions<JwtOptions>()
            .Bind(configuration.GetSection(JwtOptions.SectionName))
            .Validate(o => !string.IsNullOrWhiteSpace(o.Secret) && o.Secret.Length >= 32,
                      "Jwt:Secret e obrigatorio e deve ter ao menos 32 caracteres.")
            .ValidateOnStart();

        var connectionString = configuration.GetConnectionString("Postgres")
            ?? throw new InvalidOperationException(
                "ConnectionStrings:Postgres nao configurada. Defina-a no appsettings ou na variavel " +
                "ConnectionStrings__Postgres.");

        services.AddDbContext<SabemiDbContext>(opt =>
        {
            opt.UseNpgsql(connectionString, npgsql =>
            {
                // A tabela de historico fica no mesmo schema do resto: o schema
                // dotnet e autocontido e pode ser descartado inteiro sem tocar no
                // schema do backend VINEXT.
                npgsql.MigrationsHistoryTable("__EFMigrationsHistory", SabemiDbContext.Schema);

                // Resiliencia a falhas transitorias de conexao - reinicio do
                // Postgres, queda breve de rede - sem exigir codigo de retentativa
                // em cada consulta.
                npgsql.EnableRetryOnFailure(maxRetryCount: 5, maxRetryDelay: TimeSpan.FromSeconds(10), errorCodesToAdd: null);
            });
        });

        services.AddScoped<IAppDbContext>(sp => sp.GetRequiredService<SabemiDbContext>());
        services.AddScoped<IJobQueue, PostgresJobQueue>();
        services.AddSingleton<IDuplicateKeyDetector, NpgsqlDuplicateKeyDetector>();
        services.AddSingleton<IClock, SystemClock>();
        services.AddScoped<ITokenIssuer, JwtTokenIssuer>();
        services.AddScoped<IPaymentBusinessRule, SimulatedPaymentBusinessRule>();
        services.AddSingleton<ILoginNotificationSender, LoggingLoginNotificationSender>();

        services.AddScoped<PaymentIngestionService>();
        services.AddScoped<PaymentQueryService>();
        services.AddScoped<PaymentProcessingService>();
        services.AddScoped<PaymentRequeueService>();
        services.AddScoped<AuthService>();
        services.AddSingleton<WebhookAuthenticator>();

        return services;
    }
}

/// <summary>
/// Entrega do link de acesso por log.
/// </summary>
/// <remarks>
/// O teste tecnico precisa rodar com <c>docker compose up</c> e nada mais - e
/// exigir credenciais de SMTP para isso seria um obstaculo sem proposito. O link
/// aparece no log do container e tambem na tela em desenvolvimento
/// (<see cref="AuthOptions.ExposeLoginCodes"/>). Trocar por envio real e
/// implementar <see cref="ILoginNotificationSender"/> e registrar a nova
/// implementacao aqui; nada mais no fluxo muda.
/// </remarks>
public sealed class LoggingLoginNotificationSender(ILogger<LoggingLoginNotificationSender> logger)
    : ILoginNotificationSender
{
    public Task<bool> SendAsync(string email, string magicUrl, string otpCode, CancellationToken cancellationToken = default)
    {
        logger.LogInformation(
            "[ACESSO] E-mail: {Email} | Link: {MagicUrl} | Codigo OTP: {OtpCode}",
            email, magicUrl, otpCode);

        // false = "nao houve envio real". A UI usa isso para mostrar o link na
        // tela em vez de mandar o usuario procurar um e-mail que nunca chegou.
        return Task.FromResult(false);
    }
}
