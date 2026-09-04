using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Payments;
using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;
using Sabemi.Infrastructure.Persistence;
using Sabemi.Infrastructure.Queue;
using Sabemi.IntegrationTests.Support;
using Shouldly;

namespace Sabemi.IntegrationTests.Worker;

/// <summary>
/// Processamento em background: fila durable, retentativa e recuperacao de
/// itens orfaos.
/// </summary>
/// <remarks>
/// Precisa de PostgreSQL real porque o mecanismo central e
/// <c>FOR UPDATE SKIP LOCKED</c>, que nao existe em provider em memoria.
///
/// Os testes chamam <see cref="PaymentProcessingService.RunOnceAsync"/> em vez
/// de hospedar o worker: o ciclo e deterministico e verificavel, enquanto
/// esperar um <c>BackgroundService</c> reagir seria lento e instavel.
/// </remarks>
[Collection(PostgresCollection.Name)]
public class ProcessingTests(PostgresFixture postgres) : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    public async Task InitializeAsync() => await postgres.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    /// <summary>Regra de negocio controlavel: instantanea, ou sempre falhando.</summary>
    private sealed class RegraControlada(bool falhar = false, string mensagem = "falha simulada")
        : IPaymentBusinessRule
    {
        public int Execucoes { get; private set; }

        public Task ExecuteAsync(PaymentEvent evento, CancellationToken cancellationToken = default)
        {
            Execucoes++;
            return falhar ? throw new InvalidOperationException(mensagem) : Task.CompletedTask;
        }
    }

    private sealed record Ambiente(
        SabemiDbContext Db,
        PaymentProcessingService Processor,
        FakeClock Clock,
        RegraControlada Regra) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync() => await Db.DisposeAsync();
    }

    private Ambiente Montar(
        IPaymentBusinessRule? regra = null,
        int maxTentativas = 3,
        TimeSpan? visibilityTimeout = null,
        DateTimeOffset? agora = null)
    {
        var db = postgres.CreateDbContext();
        var clock = new FakeClock(agora ?? T0);
        var regraConcreta = regra as RegraControlada ?? new RegraControlada();

        var opcoes = Options.Create(new ProcessingOptions
        {
            MaxTentativas = maxTentativas,
            BaseRetryDelay = TimeSpan.FromSeconds(5),
            SimulatedWorkMs = 0,
            BatchSize = 10,
            VisibilityTimeout = visibilityTimeout ?? TimeSpan.FromMinutes(2),
        });

        var fila = new PostgresJobQueue(db, clock, NullLogger<PostgresJobQueue>.Instance);

        var processor = new PaymentProcessingService(
            db, fila, clock, regraConcreta, opcoes,
            NullLogger<PaymentProcessingService>.Instance);

        return new Ambiente(db, processor, clock, regraConcreta);
    }

    private async Task<Guid> SemearEvento(
        string idTransacao = "TRX-1",
        string idContrato = "CTR-1",
        decimal valor = 100m,
        string status = "PAGO",
        int maxTentativas = 3)
    {
        await using var db = postgres.CreateDbContext();

        var evento = PaymentEvent.Accepted(
            idTransacao, idContrato, valor, T0.AddHours(-1), status, "{}", true, T0);
        var job = ProcessingJob.For(evento, maxTentativas, T0);

        db.PaymentEvents.Add(evento);
        db.ProcessingJobs.Add(job);
        await db.SaveChangesAsync();

        return evento.Id;
    }

    // ---------------------------------------------------------------- sucesso

    [Fact]
    public async Task Ciclo_processa_o_evento_e_atualiza_o_contrato()
    {
        await SemearEvento();
        await using var amb = Montar();

        var resultado = await amb.Processor.RunOnceAsync("worker-teste");

        resultado.Claimed.ShouldBe(1);
        resultado.Succeeded.ShouldBe(1);

        await using var db = postgres.CreateDbContext();

        var evento = await db.PaymentEvents.SingleAsync();
        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Sucesso);
        evento.ProcessadoEm.ShouldNotBeNull();
        evento.Tentativas.ShouldBe(1);

        var job = await db.ProcessingJobs.SingleAsync();
        job.Estado.ShouldBe(JobState.Concluido);

        var contrato = await db.ContractStatuses.SingleAsync();
        contrato.ValorTotalLiquidado.ShouldBe(100m);
        contrato.PagamentosConfirmados.ShouldBe(1);
        contrato.Situacao.ShouldBe(ContractSituation.Liquidado);
    }

    [Fact]
    public async Task Fila_vazia_nao_faz_trabalho_algum()
    {
        await using var amb = Montar();

        var resultado = await amb.Processor.RunOnceAsync("worker-teste");

        resultado.Claimed.ShouldBe(0);
        resultado.DidWork.ShouldBeFalse();
        amb.Regra.Execucoes.ShouldBe(0);
    }

    [Fact]
    public async Task Lote_inteiro_e_processado_e_cada_evento_conta_a_propria_tentativa()
    {
        // Regressao de um defeito real: limpar o rastreamento do contexto ao
        // concluir um item desanexava os demais do lote, e as alteracoes deles
        // nunca chegavam ao banco - sem erro algum.
        for (var i = 1; i <= 5; i++)
        {
            await SemearEvento($"LOTE-{i}", "CTR-LOTE", 10m);
        }

        await using var amb = Montar();
        var resultado = await amb.Processor.RunOnceAsync("worker-teste");

        resultado.Claimed.ShouldBe(5);
        resultado.Succeeded.ShouldBe(5);

        await using var db = postgres.CreateDbContext();

        var eventos = await db.PaymentEvents.ToListAsync();
        eventos.ShouldAllBe(e => e.StatusProcessamento == ProcessingStatus.Sucesso);
        eventos.ShouldAllBe(e => e.Tentativas == 1);

        var contrato = await db.ContractStatuses.SingleAsync();
        contrato.ValorTotalLiquidado.ShouldBe(50m);
        contrato.PagamentosConfirmados.ShouldBe(5);
    }

    [Theory]
    [InlineData("CANCELADO")]
    [InlineData("ESTORNADO")]
    public async Task Pagamento_cancelado_nao_soma_ao_total(string status)
    {
        await SemearEvento("TRX-CANC", "CTR-C", 500m, status);
        await using var amb = Montar();

        await amb.Processor.RunOnceAsync("worker-teste");

        await using var db = postgres.CreateDbContext();
        var contrato = await db.ContractStatuses.SingleAsync();

        contrato.ValorTotalLiquidado.ShouldBe(0m);
        contrato.Situacao.ShouldBe(ContractSituation.Inadimplente);
    }

    // ------------------------------------------------------------ retentativa

    [Fact]
    public async Task Falha_transitoria_reagenda_com_backoff()
    {
        await SemearEvento("TRX-FALHA", maxTentativas: 3);
        await using var amb = Montar(new RegraControlada(falhar: true));

        var resultado = await amb.Processor.RunOnceAsync("worker-teste");

        resultado.Retried.ShouldBe(1);
        resultado.Failed.ShouldBe(0);

        await using var db = postgres.CreateDbContext();

        var job = await db.ProcessingJobs.SingleAsync();
        job.Estado.ShouldBe(JobState.Pendente);
        job.Tentativas.ShouldBe(1);
        // Reagendado para o futuro: nao pode ser reivindicado de imediato.
        job.DisponivelEm.ShouldBeGreaterThan(T0);

        var evento = await db.PaymentEvents.SingleAsync();
        // Ainda Pendente, nao Erro: ha tentativas pela frente.
        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Pendente);
        evento.Erro.ShouldNotBeNull();
        evento.Erro.ShouldContain("falha simulada");
    }

    [Fact]
    public async Task Item_reagendado_nao_e_reivindicado_antes_da_hora()
    {
        await SemearEvento("TRX-BACKOFF");
        await using var amb = Montar(new RegraControlada(falhar: true));

        await amb.Processor.RunOnceAsync("worker-teste");

        // O relogio nao avancou: o backoff ainda esta valendo.
        var segundo = await amb.Processor.RunOnceAsync("worker-teste");
        segundo.Claimed.ShouldBe(0);

        // Passado o backoff, o item volta a ficar disponivel.
        amb.Clock.Advance(TimeSpan.FromMinutes(1));
        var terceiro = await amb.Processor.RunOnceAsync("worker-teste");
        terceiro.Claimed.ShouldBe(1);
    }

    [Fact]
    public async Task Esgotadas_as_tentativas_o_evento_vai_para_ERRO()
    {
        await SemearEvento("TRX-MORRE", maxTentativas: 2);
        await using var amb = Montar(new RegraControlada(falhar: true), maxTentativas: 2);

        // Tentativa 1: reagenda.
        (await amb.Processor.RunOnceAsync("w")).Retried.ShouldBe(1);

        amb.Clock.Advance(TimeSpan.FromMinutes(1));

        // Tentativa 2: acabou o orcamento.
        var ultima = await amb.Processor.RunOnceAsync("w");
        ultima.Failed.ShouldBe(1);

        await using var db = postgres.CreateDbContext();

        var evento = await db.PaymentEvents.SingleAsync();
        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Erro);
        evento.ProcessadoEm.ShouldNotBeNull();

        var job = await db.ProcessingJobs.SingleAsync();
        job.Estado.ShouldBe(JobState.Falhou);

        // Nada foi somado ao contrato - o pagamento nunca foi aplicado.
        (await db.ContractStatuses.CountAsync()).ShouldBe(0);
    }

    [Fact]
    public async Task Item_que_falhou_definitivamente_nao_volta_para_a_fila()
    {
        await SemearEvento("TRX-MORTO", maxTentativas: 1);
        await using var amb = Montar(new RegraControlada(falhar: true), maxTentativas: 1);

        await amb.Processor.RunOnceAsync("w");
        amb.Clock.Advance(TimeSpan.FromHours(1));

        var novoCiclo = await amb.Processor.RunOnceAsync("w");

        novoCiclo.Claimed.ShouldBe(0);
    }

    // -------------------------------------------------------------- orfaos

    [Fact]
    public async Task Item_orfao_volta_para_a_fila_apos_o_visibility_timeout()
    {
        // Simula o worker morto no meio do trabalho: o item fica em Processando e
        // ninguem o conclui. Sem a varredura, ficaria travado para sempre.
        await SemearEvento("TRX-ORFAO");

        await using (var db = postgres.CreateDbContext())
        {
            var job = await db.ProcessingJobs.SingleAsync();
            job.Claim("worker-que-morreu", T0);
            await db.SaveChangesAsync();
        }

        await using var amb = Montar(visibilityTimeout: TimeSpan.FromMinutes(2));
        amb.Clock.Advance(TimeSpan.FromMinutes(5));

        var resultado = await amb.Processor.RunOnceAsync("worker-novo");

        resultado.Released.ShouldBe(1);
        resultado.Claimed.ShouldBe(1);
        resultado.Succeeded.ShouldBe(1);

        await using var verificacao = postgres.CreateDbContext();
        (await verificacao.PaymentEvents.SingleAsync()).StatusProcessamento
            .ShouldBe(ProcessingStatus.Sucesso);
    }

    [Fact]
    public async Task Item_em_processamento_dentro_do_prazo_NAO_e_roubado()
    {
        // O outro lado da moeda: um worker que esta trabalhando normalmente nao
        // pode ter o item tomado por outro, senao o processamento duplicaria.
        await SemearEvento("TRX-ATIVO");

        await using (var db = postgres.CreateDbContext())
        {
            var job = await db.ProcessingJobs.SingleAsync();
            job.Claim("worker-ativo", T0);
            await db.SaveChangesAsync();
        }

        await using var amb = Montar(visibilityTimeout: TimeSpan.FromMinutes(2));
        amb.Clock.Advance(TimeSpan.FromSeconds(30));

        var resultado = await amb.Processor.RunOnceAsync("worker-intruso");

        resultado.Released.ShouldBe(0);
        resultado.Claimed.ShouldBe(0);
    }

    // ---------------------------------------------------- concorrencia real

    [Fact]
    public async Task Dois_workers_concorrentes_nao_pegam_o_mesmo_item()
    {
        // A prova do SKIP LOCKED. Cada evento tem de ser processado exatamente uma
        // vez, mesmo com dois consumidores disputando a fila ao mesmo tempo.
        for (var i = 1; i <= 10; i++)
        {
            await SemearEvento($"CONC-{i}", "CTR-CONC", 10m);
        }

        await using var a = Montar();
        await using var b = Montar();

        var resultados = await Task.WhenAll(
            a.Processor.RunOnceAsync("worker-a"),
            b.Processor.RunOnceAsync("worker-b"));

        // Nenhum item entregue duas vezes.
        resultados.Sum(r => r.Claimed).ShouldBe(10);
        resultados.Sum(r => r.Succeeded).ShouldBe(10);

        await using var db = postgres.CreateDbContext();

        var eventos = await db.PaymentEvents.ToListAsync();
        eventos.ShouldAllBe(e => e.StatusProcessamento == ProcessingStatus.Sucesso);

        // A prova final: o total do contrato bate exatamente. Um item processado
        // duas vezes apareceria aqui como 110 em vez de 100.
        var contrato = await db.ContractStatuses.SingleAsync();
        contrato.ValorTotalLiquidado.ShouldBe(100m);
        contrato.PagamentosConfirmados.ShouldBe(10);
    }
}
