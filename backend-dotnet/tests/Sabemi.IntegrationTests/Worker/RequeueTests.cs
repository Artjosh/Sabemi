using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Payments;
using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;
using Sabemi.Domain.Processing;
using Sabemi.Infrastructure.Persistence;
using Sabemi.Infrastructure.Queue;
using Sabemi.IntegrationTests.Support;
using Shouldly;

namespace Sabemi.IntegrationTests.Worker;

/// <summary>
/// Retry por tipo de erro e reenfileiramento manual.
/// </summary>
/// <remarks>
/// As duas coisas sao as duas metades da mesma decisao. O sistema retenta
/// sozinho o que melhora com o tempo; o que nao melhora vai direto para ERRO,
/// com a causa explicada, e espera por uma pessoa. Este arquivo verifica que a
/// fronteira entre as duas esta no lugar certo - e, principalmente, que
/// reenfileirar NAO consegue somar um pagamento duas vezes.
/// </remarks>
[Collection(PostgresCollection.Name)]
public class RequeueTests(PostgresFixture postgres) : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    public async Task InitializeAsync() => await postgres.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    /// <summary>Regra que falha com uma excecao escolhida pelo teste.</summary>
    private sealed class RegraQueFalha(Func<Exception>? erro = null) : IPaymentBusinessRule
    {
        public int Execucoes { get; private set; }

        public Task ExecuteAsync(PaymentEvent evento, CancellationToken cancellationToken = default)
        {
            Execucoes++;

            if (erro is null) return Task.CompletedTask;
            throw erro();
        }
    }

    private (SabemiDbContext Db, PaymentProcessingService Processor) MontarProcessador(
        IPaymentBusinessRule regra,
        int maxTentativas = 3)
    {
        var db = postgres.CreateDbContext();
        var clock = new FakeClock(T0);

        var opcoes = Options.Create(new ProcessingOptions
        {
            MaxTentativas = maxTentativas,
            BaseRetryDelay = TimeSpan.FromSeconds(5),
            SimulatedWorkMs = 0,
            BatchSize = 10,
            VisibilityTimeout = TimeSpan.FromMinutes(2),
        });

        var fila = new PostgresJobQueue(db, clock, NullLogger<PostgresJobQueue>.Instance);

        return (db, new PaymentProcessingService(
            db, fila, clock, regra, opcoes, NullLogger<PaymentProcessingService>.Instance));
    }

    private PaymentRequeueService MontarRequeue(SabemiDbContext db)
        => new(db, new FakeClock(T0), NullLogger<PaymentRequeueService>.Instance);

    private async Task SemearEvento(string idTransacao, string idContrato = "CTR-1", decimal valor = 100m)
    {
        await using var db = postgres.CreateDbContext();

        var evento = PaymentEvent.Accepted(
            idTransacao, idContrato, valor, T0.AddHours(-1), "PAGO", "{}", true, T0);

        db.PaymentEvents.Add(evento);
        db.ProcessingJobs.Add(ProcessingJob.For(evento, 3, T0));
        await db.SaveChangesAsync();
    }

    // ------------------------------------------------- retry por tipo de erro

    [Fact]
    public async Task Falha_PERMANENTE_vai_direto_para_ERRO_sem_gastar_as_tentativas()
    {
        // O ponto do retry por tipo: um contrato inexistente nao passa a existir
        // na segunda tentativa. Insistir tres vezes so atrasa em minutos a unica
        // coisa util - o evento aparecer no painel com a causa e o botao.
        await SemearEvento("TRX-PERM");

        var regra = new RegraQueFalha(
            () => new InvalidOperationException("violates foreign key constraint"));

        var (db, processor) = MontarProcessador(regra);
        await using var _ = db;

        var resultado = await processor.RunOnceAsync("worker-teste");

        resultado.Failed.ShouldBe(1);
        resultado.Retried.ShouldBe(0);

        // Uma unica execucao da regra, e nao tres.
        regra.Execucoes.ShouldBe(1);

        await using var leitura = postgres.CreateDbContext();
        var evento = await leitura.PaymentEvents.FirstAsync(e => e.IdTransacao == "TRX-PERM");

        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Erro);
        evento.ErroCategoria.ShouldBe(FailureCategory.Permanente);
        evento.ErroCodigo.ShouldBe("REFERENCIA_INEXISTENTE");
        evento.Tentativas.ShouldBe(1);
    }

    [Fact]
    public async Task Falha_TRANSITORIA_continua_sendo_retentada()
    {
        // O outro lado: desistir de uma indisponibilidade de dois segundos
        // deixaria um pagamento sem consolidar.
        await SemearEvento("TRX-TRANS");

        var regra = new RegraQueFalha(() => new TimeoutException("statement timeout"));
        var (db, processor) = MontarProcessador(regra);
        await using var _ = db;

        var resultado = await processor.RunOnceAsync("worker-teste");

        resultado.Retried.ShouldBe(1);
        resultado.Failed.ShouldBe(0);

        await using var leitura = postgres.CreateDbContext();
        var evento = await leitura.PaymentEvents.FirstAsync(e => e.IdTransacao == "TRX-TRANS");

        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Pendente);
        evento.ErroCategoria.ShouldBe(FailureCategory.Transitoria);
        evento.ErroCodigo.ShouldBe("TIMEOUT");
    }

    // ----------------------------------------------- reenfileiramento manual

    [Fact]
    public async Task Reenfileirar_devolve_a_fila_e_o_evento_processa_na_sequencia()
    {
        // O ciclo completo que justifica o botao: falhou por causa permanente,
        // a pessoa corrigiu o que faltava, clicou, e agora passa.
        await SemearEvento("TRX-FIX", "CTR-FIX", 250m);

        var regra = new RegraQueFalha(
            () => new InvalidOperationException("violates foreign key constraint"));

        var (db1, processor1) = MontarProcessador(regra);
        await using (db1)
        {
            await processor1.RunOnceAsync("worker-teste");
        }

        await using var dbRequeue = postgres.CreateDbContext();
        var resultado = await MontarRequeue(dbRequeue).RequeueAsync("TRX-FIX");

        resultado.Ok.ShouldBeTrue();
        resultado.Value!.StatusProcessamento.ShouldBe("PENDENTE");

        // A causa foi "corrigida": agora a regra passa.
        var (db2, processor2) = MontarProcessador(new RegraQueFalha());
        await using (db2)
        {
            var ciclo = await processor2.RunOnceAsync("worker-teste");
            ciclo.Succeeded.ShouldBe(1);
        }

        await using var leitura = postgres.CreateDbContext();
        var evento = await leitura.PaymentEvents.FirstAsync(e => e.IdTransacao == "TRX-FIX");
        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Sucesso);

        // O sucesso limpa o diagnostico: manter a causa antiga numa linha que deu
        // certo faria o painel mostrar um erro que nao existe mais.
        evento.ErroCodigo.ShouldBeNull();
        evento.ErroCategoria.ShouldBeNull();

        var contrato = await leitura.ContractStatuses.FirstAsync(c => c.IdContrato == "CTR-FIX");
        contrato.ValorTotalLiquidado.ShouldBe(250m);
        contrato.PagamentosConfirmados.ShouldBe(1);
    }

    [Fact]
    public async Task Reenfileirar_um_evento_com_SUCESSO_e_RECUSADO()
    {
        // A protecao mais importante deste endpoint. A idempotencia da ingestao
        // impede um evento DUPLICADO de entrar - ela nao impede o MESMO evento
        // de ser processado duas vezes. Sem esta recusa, dois cliques dobrariam
        // o valor liquidado do contrato.
        await SemearEvento("TRX-OK", "CTR-OK", 500m);

        var (db1, processor) = MontarProcessador(new RegraQueFalha());
        await using (db1)
        {
            await processor.RunOnceAsync("worker-teste");
        }

        await using var db = postgres.CreateDbContext();
        var resultado = await MontarRequeue(db).RequeueAsync("TRX-OK");

        resultado.Ok.ShouldBeFalse();
        resultado.Failure.ShouldBe(PaymentRequeueService.RequeueFailure.NotEligible);

        // A mensagem e mostrada ao operador tal como vem: precisa dizer POR QUE.
        resultado.Message.ShouldNotBeNull();
        resultado.Message.ShouldContain("ja esta somado ao contrato");

        await using var leitura = postgres.CreateDbContext();
        var contrato = await leitura.ContractStatuses.FirstAsync(c => c.IdContrato == "CTR-OK");
        contrato.ValorTotalLiquidado.ShouldBe(500m);
        contrato.PagamentosConfirmados.ShouldBe(1);
    }

    [Fact]
    public async Task Dois_cliques_seguidos_nao_geram_dois_processamentos()
    {
        // O segundo clique encontra o evento ja em PENDENTE e e recusado - e o
        // que torna o botao seguro contra o duplo-clique apressado.
        await SemearEvento("TRX-2X");

        var regra = new RegraQueFalha(
            () => new InvalidOperationException("violates foreign key constraint"));

        var (db1, processor) = MontarProcessador(regra);
        await using (db1)
        {
            await processor.RunOnceAsync("worker-teste");
        }

        await using var db = postgres.CreateDbContext();
        var servico = MontarRequeue(db);

        (await servico.RequeueAsync("TRX-2X")).Ok.ShouldBeTrue();

        var segundo = await servico.RequeueAsync("TRX-2X");
        segundo.Ok.ShouldBeFalse();
        segundo.Message.ShouldNotBeNull();
        segundo.Message.ShouldContain("ja esta na fila");

        await using var leitura = postgres.CreateDbContext();
        var jobs = await leitura.ProcessingJobs
            .Where(j => j.PaymentEvent!.IdTransacao == "TRX-2X")
            .ToListAsync();

        jobs.Count.ShouldBe(1);
    }

    [Fact]
    public async Task Reenfileirar_um_evento_INVALIDO_e_recusado_com_o_motivo()
    {
        // Um payload reprovado na validacao nunca teve job. Reprocessa-lo nao
        // mudaria nada: o corpo continua o mesmo.
        await using (var db = postgres.CreateDbContext())
        {
            db.PaymentEvents.Add(PaymentEvent.Rejected(
                "TRX-INV", null, null, null, null, "{}", "valor obrigatorio", true, T0));
            await db.SaveChangesAsync();
        }

        await using var leitura = postgres.CreateDbContext();
        var resultado = await MontarRequeue(leitura).RequeueAsync("TRX-INV");

        resultado.Ok.ShouldBeFalse();
        resultado.Message.ShouldNotBeNull();
        resultado.Message.ShouldContain("corrija na origem", Case.Insensitive);
    }

    [Fact]
    public async Task Um_evento_invalido_tambem_tem_diagnostico()
    {
        // Seria o unico estado de erro sem tooltip - e e justamente o mais
        // frequente no painel.
        await using (var db = postgres.CreateDbContext())
        {
            db.PaymentEvents.Add(PaymentEvent.Rejected(
                "TRX-DIAG", null, null, null, null, "{}", "valor obrigatorio", true, T0));
            await db.SaveChangesAsync();
        }

        await using var leitura = postgres.CreateDbContext();
        var evento = await leitura.PaymentEvents.FirstAsync(e => e.IdTransacao == "TRX-DIAG");

        evento.ErroCodigo.ShouldBe(FailureCatalog.PayloadInvalido);
        evento.ErroCategoria.ShouldBe(FailureCategory.Permanente);
    }

    [Fact]
    public async Task Reenfileirar_um_id_inexistente_devolve_NotFound()
    {
        await using var db = postgres.CreateDbContext();

        var resultado = await MontarRequeue(db).RequeueAsync("NAO-EXISTE");

        resultado.Ok.ShouldBeFalse();
        resultado.Failure.ShouldBe(PaymentRequeueService.RequeueFailure.NotFound);
    }

    [Fact]
    public async Task O_diagnostico_chega_ao_DTO_com_explicacao_e_acao()
    {
        // O painel nao le a tabela: le o DTO. Se a derivacao do codigo para o
        // texto falhasse aqui, o tooltip apareceria vazio.
        await SemearEvento("TRX-DTO");

        var regra = new RegraQueFalha(
            () => new InvalidOperationException("violates foreign key constraint"));

        var (db1, processor) = MontarProcessador(regra);
        await using (db1)
        {
            await processor.RunOnceAsync("worker-teste");
        }

        await using var db = postgres.CreateDbContext();
        var detalhe = await new PaymentQueryService(db).GetByTransactionIdAsync("TRX-DTO");

        detalhe.ShouldNotBeNull();
        detalhe.Diagnostico.ShouldNotBeNull();
        detalhe.Diagnostico.Codigo.ShouldBe("REFERENCIA_INEXISTENTE");
        detalhe.Diagnostico.Categoria.ShouldBe("PERMANENTE");
        detalhe.Diagnostico.Retentavel.ShouldBeFalse();
        detalhe.Diagnostico.Explicacao.ShouldNotBeNullOrWhiteSpace();
        detalhe.Diagnostico.AcaoSugerida.ShouldNotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Um_evento_que_nunca_falhou_nao_tem_diagnostico()
    {
        // A UI usa a AUSENCIA para decidir se mostra o tooltip. Um diagnostico
        // generico numa linha de sucesso poria um icone de erro onde nao ha erro.
        await SemearEvento("TRX-LIMPO");

        var (db1, processor) = MontarProcessador(new RegraQueFalha());
        await using (db1)
        {
            await processor.RunOnceAsync("worker-teste");
        }

        await using var db = postgres.CreateDbContext();
        var detalhe = await new PaymentQueryService(db).GetByTransactionIdAsync("TRX-LIMPO");

        detalhe!.Diagnostico.ShouldBeNull();
    }
}
