using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Configuration.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Sabemi.Application.Auth;
using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;
using Sabemi.Infrastructure;
using Sabemi.IntegrationTests.Support;
using Sabemi.Worker;
using Shouldly;

namespace Sabemi.IntegrationTests.Worker;

/// <summary>
/// O host do worker de verdade, drenando a fila.
/// </summary>
/// <remarks>
/// Os demais testes de processamento chamam <c>RunOnceAsync</c> diretamente,
/// porque e deterministico. Este aqui e o complemento necessario: sobe o
/// <c>BackgroundService</c> como ele roda em producao e confirma que o laco, o
/// escopo por ciclo e a espera adaptativa realmente funcionam juntos.
///
/// Sem ele, um erro na FIACAO - servico nao registrado, escopo criado errado,
/// laco que nunca comeca - passaria despercebido: todas as pecas testadas, e o
/// container em producao sem processar nada.
/// </remarks>
[Collection(PostgresCollection.Name)]
public class WorkerHostTests(PostgresFixture postgres) : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    public async Task InitializeAsync() => await postgres.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    private IHost ConstruirHost()
    {
        var builder = Host.CreateApplicationBuilder();

        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Postgres"] = postgres.ConnectionString,
            ["Jwt:Secret"] = "segredo-de-teste-com-mais-de-32-caracteres-aqui",
            ["WebhookSecurity:ApiKey"] = "chave-de-teste",
            ["Processing:SimulatedWorkDuration"] = "00:00:00",
            ["Processing:PollInterval"] = "00:00:00.100",
            ["Processing:BatchSize"] = "10",
        });

        builder.Services.AddSabemiInfrastructure(builder.Configuration);
        builder.Services.AddLogging(l => l.SetMinimumLevel(LogLevel.Warning));
        builder.Services.AddHostedService<PaymentProcessingWorker>();

        return builder.Build();
    }

    private async Task SemearEventos(int quantidade)
    {
        await using var db = postgres.CreateDbContext();

        for (var i = 1; i <= quantidade; i++)
        {
            var evento = PaymentEvent.Accepted(
                $"HOST-{i}", "CTR-HOST", 25m, T0.AddHours(-1), "PAGO", "{}", true, T0);
            db.PaymentEvents.Add(evento);
            db.ProcessingJobs.Add(ProcessingJob.For(evento, 3, T0));
        }

        await db.SaveChangesAsync();
    }

    /// <summary>
    /// Espera a condicao por sondagem, com prazo.
    /// </summary>
    /// <remarks>
    /// Uma pausa fixa seria instavel nos dois sentidos: curta demais em CI
    /// carregado, e desperdicio de tempo quando a maquina esta livre.
    /// </remarks>
    private static async Task<bool> AguardarAte(Func<Task<bool>> condicao, TimeSpan prazo)
    {
        var limite = DateTime.UtcNow + prazo;
        while (DateTime.UtcNow < limite)
        {
            if (await condicao()) return true;
            await Task.Delay(100);
        }
        return false;
    }

    [Fact]
    public async Task Worker_hospedado_drena_a_fila_sozinho()
    {
        await SemearEventos(5);

        using var host = ConstruirHost();
        await host.StartAsync();

        try
        {
            var concluiu = await AguardarAte(async () =>
            {
                await using var db = postgres.CreateDbContext();
                return await db.PaymentEvents
                    .CountAsync(e => e.StatusProcessamento == ProcessingStatus.Sucesso) == 5;
            }, TimeSpan.FromSeconds(30));

            concluiu.ShouldBeTrue("o worker deveria ter processado os 5 eventos");
        }
        finally
        {
            await host.StopAsync();
        }

        await using var verificacao = postgres.CreateDbContext();

        (await verificacao.ProcessingJobs.CountAsync(j => j.Estado == JobState.Concluido)).ShouldBe(5);

        var contrato = await verificacao.ContractStatuses.SingleAsync();
        contrato.ValorTotalLiquidado.ShouldBe(125m);
        contrato.PagamentosConfirmados.ShouldBe(5);
    }

    [Fact]
    public async Task Worker_processa_evento_que_chega_DEPOIS_de_ele_subir()
    {
        // O caso normal em producao: o worker esta ocioso quando o webhook chega.
        // Verifica que o laco continua ativo depois de encontrar a fila vazia -
        // um laco que parasse no primeiro ciclo vazio passaria em todos os outros
        // testes e falharia aqui.
        using var host = ConstruirHost();
        await host.StartAsync();

        try
        {
            await Task.Delay(500);   // deixa o worker rodar alguns ciclos vazios
            await SemearEventos(1);

            var processou = await AguardarAte(async () =>
            {
                await using var db = postgres.CreateDbContext();
                return await db.PaymentEvents
                    .AnyAsync(e => e.StatusProcessamento == ProcessingStatus.Sucesso);
            }, TimeSpan.FromSeconds(30));

            processou.ShouldBeTrue("o worker deveria continuar consumindo apos ciclos vazios");
        }
        finally
        {
            await host.StopAsync();
        }
    }

    [Fact]
    public async Task Limpeza_de_pedidos_de_login_remove_os_vencidos()
    {
        // Exercita o segundo hosted service pelo servico que ele chama. Sem esta
        // varredura, a tabela consultada a cada 2,5s pelo polling cresceria para
        // sempre com pedidos abandonados.
        await using (var db = postgres.CreateDbContext())
        {
            var vencido = LoginRequest.Create(
                "vencido@sabemi.com.br", "sel-vencido", "hash-a", "hash-b",
                DateTimeOffset.UtcNow.AddHours(-2), TimeSpan.FromMinutes(15));

            var valido = LoginRequest.Create(
                "valido@sabemi.com.br", "sel-valido", "hash-c", "hash-d",
                DateTimeOffset.UtcNow, TimeSpan.FromMinutes(15));

            db.LoginRequests.AddRange(vencido, valido);
            await db.SaveChangesAsync();
        }

        using var host = ConstruirHost();
        using var scope = host.Services.CreateScope();
        var auth = scope.ServiceProvider.GetRequiredService<AuthService>();

        var removidos = await auth.PurgeExpiredAsync();

        removidos.ShouldBe(1);

        await using var verificacao = postgres.CreateDbContext();
        var restantes = await verificacao.LoginRequests.ToListAsync();
        restantes.Count.ShouldBe(1);
        restantes[0].Email.ShouldBe("valido@sabemi.com.br");
    }
}
