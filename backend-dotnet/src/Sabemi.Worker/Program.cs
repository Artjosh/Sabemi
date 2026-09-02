using Microsoft.EntityFrameworkCore;
using Sabemi.Application.Auth;
using Sabemi.Application.Payments;
using Sabemi.Infrastructure;
using Sabemi.Infrastructure.Persistence;
using Sabemi.Worker;
using Serilog;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddSerilog((services, cfg) => cfg
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console());

builder.Services.AddSabemiInfrastructure(builder.Configuration);

builder.Services.Configure<AuthOptions>(o =>
    o.IsProduction = builder.Environment.IsProduction());

// Metricas em :9464/metrics e tracing por OTLP. Ver ObservabilidadeDoWorker.cs -
// e nele que a regra pesada roda, e uma fila que para de drenar so aparece aqui.
builder.Services.AddObservabilidadeDoWorker(builder.Configuration);

builder.Services.AddHostedService<PaymentProcessingWorker>();
builder.Services.AddHostedService<LoginRequestCleanupWorker>();

var host = builder.Build();

// O worker espera as migrations em vez de aplica-las: duas instancias migrando
// em paralelo disputam o lock do EF Core e uma delas falha na subida. A API e a
// unica dona do schema; aqui so verificamos que ele ja esta pronto.
// ILogger precisa ser qualificado: Serilog tambem publica um tipo com esse nome
// e o `using Serilog` acima torna a referencia simples ambigua.
await WaitForSchemaAsync(
    host.Services,
    host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Startup"));

await host.RunAsync();

static async Task WaitForSchemaAsync(IServiceProvider services, Microsoft.Extensions.Logging.ILogger logger)
{
    const int maxTentativas = 30;

    for (var tentativa = 1; tentativa <= maxTentativas; tentativa++)
    {
        try
        {
            using var scope = services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<SabemiDbContext>();

            var pendentes = await db.Database.GetPendingMigrationsAsync();
            if (!pendentes.Any())
            {
                logger.LogInformation("Schema pronto; iniciando o processamento da fila.");
                return;
            }

            logger.LogInformation(
                "Aguardando a API aplicar {Count} migration(s) pendente(s)... ({Tentativa}/{Max})",
                pendentes.Count(), tentativa, maxTentativas);
        }
        catch (Exception ex)
        {
            logger.LogInformation(
                "Banco ainda indisponivel ({Motivo}). Nova tentativa em 2s... ({Tentativa}/{Max})",
                ex.Message, tentativa, maxTentativas);
        }

        await Task.Delay(TimeSpan.FromSeconds(2));
    }

    // Segue em frente mesmo assim: o laco do worker tolera falhas de ciclo e
    // tentara de novo. Encerrar o processo aqui so produziria um container em
    // reinicio perpetuo, que e mais dificil de diagnosticar.
    logger.LogWarning("Tempo de espera pelo schema esgotado; iniciando assim mesmo.");
}

// Sem `public partial class Program` aqui, de proposito: a API ja expoe o seu
// para o WebApplicationFactory, e dois tipos publicos chamados Program no mesmo
// assembly de teste tornam a referencia ambigua. Os testes exercitam a logica do
// worker por PaymentProcessingService, que nao depende deste host.
