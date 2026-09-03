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
using Microsoft.Extensions.Options;
using Sabemi.Infrastructure.Email;
using Sabemi.Infrastructure.Auth;

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

        // A MESMA variavel que o backend VINEXT usa. Ver PostgresConnectionString:
        // apontar a stack para um Supabase remoto passa a ser trocar uma linha, em
        // vez de transcrever a mesma informacao em duas sintaxes diferentes.
        var connectionString = PostgresConnectionString.Resolver(configuration)
            ?? throw new InvalidOperationException(
                "Conexao do PostgreSQL nao configurada. Defina DATABASE_URL " +
                "(postgresql://usuario:senha@host:porta/banco) ou, para usar o formato " +
                "nativo do Npgsql, ConnectionStrings__Postgres.");

        services.AddDbContext<SabemiDbContext>(opt =>
        {
            opt.UseNpgsql(connectionString, npgsql =>
            {
                // A tabela de historico fica no mesmo schema do resto. O schema
                // `sabemi` e COMPARTILHADO com o backend VINEXT, e o EF Core e o
                // unico dono das migrations - o Prisma apenas descreve o mesmo
                // modelo para poder consultar (ver frontend/prisma/schema.prisma).
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
        // -------------------------------------------- provedor de identidade
        //
        // Quem envia o desafio de acesso e quem valida o codigo. O pedido de
        // login (selector, polling, uso unico) e SEMPRE local - ver
        // IIdentityProvider -, porque e ele que da o cross-device e o GoTrue nao
        // tem esse conceito.
        //
        //   AUTH_PROVIDER=local      (padrao) magic link e OTP proprios
        //   AUTH_PROVIDER=supabase   GoTrue emite, envia e valida
        //
        // A escolha e feita AQUI, na subida, e nao a cada login: assim ela
        // aparece no log de inicializacao e um erro de configuracao e descoberto
        // antes de alguem tentar entrar.
        var provedor = (configuration["AUTH_PROVIDER"] ?? "local").Trim().ToLowerInvariant();

        services.AddOptions<SupabaseAuthOptions>()
            .Bind(configuration.GetSection(SupabaseAuthOptions.SectionName))
            .ValidateOnStart();

        if (provedor is "supabase")
        {
            var supabase = new SupabaseAuthOptions();
            configuration.GetSection(SupabaseAuthOptions.SectionName).Bind(supabase);

            if (!supabase.Configurado)
            {
                // Falha na SUBIDA, e nao no primeiro login. Cair para o modo
                // local em silencio seria pior: quem pediu Supabase acharia que
                // esta usando Supabase, e o comportamento observavel e quase
                // igual - ate o dia em que alguem procura o usuario no painel do
                // Supabase e nao o encontra.
                throw new InvalidOperationException(
                    "AUTH_PROVIDER=supabase exige SUPABASE_URL e SUPABASE_ANON_KEY. "
                    + "Configure-as (ver .env) ou use AUTH_PROVIDER=local.");
            }

            services.AddHttpClient<IIdentityProvider, SupabaseIdentityProvider>(
                (sp, cliente) =>
                {
                    var o = sp.GetRequiredService<IOptions<SupabaseAuthOptions>>().Value;

                    cliente.BaseAddress = new Uri(o.Url);
                    cliente.Timeout = o.Timeout;

                    // `apikey` e o header que o Kong exige antes de encaminhar ao
                    // GoTrue. A chave `anon` basta: o fluxo de acesso nao precisa
                    // da `service_role`, e manter a chave privilegiada fora do
                    // caminho quente reduz o estrago de um log vazado.
                    cliente.DefaultRequestHeaders.Add("apikey", o.AnonKey);
                });
        }
        else
        {
            services.AddScoped<IIdentityProvider, LocalIdentityProvider>();
        }

        // Entrega do e-mail de acesso: Brevo quando ha chave, log quando nao ha.
        //
        // A decisao e feita AQUI, na subida, e nao dentro do remetente. Um
        // remetente que checasse a chave a cada envio esconderia a configuracao
        // ausente no meio do fluxo de login - e a diferenca entre "o e-mail
        // falhou" e "nunca houve provedor configurado" e exatamente o que quem
        // opera precisa saber. Aqui a escolha aparece no log da inicializacao.
        services.AddOptions<BrevoOptions>()
            .Bind(configuration.GetSection(BrevoOptions.SectionName))
            .ValidateOnStart();

        var brevo = new BrevoOptions();
        configuration.GetSection(BrevoOptions.SectionName).Bind(brevo);

        if (brevo.Configurado)
        {
            // `AddHttpClient` e nao um `new HttpClient()`: a fabrica cuida da
            // reciclagem do handler, sem a qual uma instancia de longa duracao
            // ignora mudanca de DNS - e a Brevo esta atras de um balanceador.
            services.AddHttpClient<ILoginNotificationSender, BrevoLoginNotificationSender>(
                (sp, cliente) =>
                {
                    var o = sp.GetRequiredService<IOptions<BrevoOptions>>().Value;

                    cliente.BaseAddress = new Uri(o.BaseUrl);
                    cliente.Timeout = o.Timeout;

                    // `api-key` e o header da Brevo - nao e `Authorization`.
                    cliente.DefaultRequestHeaders.Add("api-key", o.ApiKey);
                    cliente.DefaultRequestHeaders.Add("accept", "application/json");
                });
        }
        else
        {
            services.AddSingleton<ILoginNotificationSender, LoggingLoginNotificationSender>();
        }

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
