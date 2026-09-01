using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Validation;
using Sabemi.Domain.Entities;

namespace Sabemi.Application.Payments;

/// <summary>
/// Executa um ciclo da fila: reivindica itens, aplica a regra e fecha o job.
/// </summary>
/// <remarks>
/// <para>Este e o outro lado do webhook. Roda em um processo separado
/// (<c>Sabemi.Worker</c>), o que da tres coisas: a API nao perde CPU com a regra
/// de 2s, os dois lados escalam de forma independente, e derrubar o worker para
/// um deploy nao derruba a ingestao - os eventos se acumulam na fila e sao
/// processados quando ele volta.</para>
///
/// <para><b>Por que um ciclo e nao um laco.</b> Este servico processa uma
/// rodada e retorna. Quem repete e o host (<c>PaymentProcessingWorker</c>).
/// Assim o mesmo codigo serve ao worker de producao e aos testes de integracao,
/// que chamam <see cref="RunOnceAsync"/> e verificam o resultado sem precisar
/// subir um serviço nem esperar por temporizadores.</para>
///
/// <para><b>Garantia de entrega.</b> At-least-once. O item so sai da fila depois
/// que a transacao que atualiza o contrato e conclui o job commita. Se o
/// processo morrer no meio, o lease expira e outro worker retoma. O que impede a
/// dupla contagem no caso de reprocessamento e a idempotencia da ingestao: um
/// <c>id_transacao</c> gera um unico evento, e portanto um unico job.</para>
/// </remarks>
public sealed class PaymentProcessingService(
    IAppDbContext db,
    IJobQueue queue,
    IClock clock,
    IPaymentBusinessRule businessRule,
    IOptions<ProcessingOptions> options,
    ILogger<PaymentProcessingService> logger)
{
    private readonly ProcessingOptions _options = options.Value;

    /// <param name="Claimed">Itens reivindicados nesta rodada.</param>
    /// <param name="Succeeded">Concluidos com sucesso.</param>
    /// <param name="Retried">Falharam e voltaram para a fila com backoff.</param>
    /// <param name="Failed">Esgotaram as tentativas.</param>
    /// <param name="Released">Orfaos devolvidos a fila (lease expirado).</param>
    public sealed record CycleResult(int Claimed, int Succeeded, int Retried, int Failed, int Released)
    {
        public static readonly CycleResult Empty = new(0, 0, 0, 0, 0);
        public bool DidWork => Claimed > 0 || Released > 0;
    }

    /// <summary>Executa uma rodada completa da fila.</summary>
    public async Task<CycleResult> RunOnceAsync(string workerId, CancellationToken ct = default)
    {
        // Primeiro recupera o que ficou orfao: um item preso em "Processando"
        // por um worker que morreu nunca sairia de la sozinho.
        var released = await queue.ReleaseStaleAsync(_options.VisibilityTimeout, ct);
        if (released > 0)
        {
            logger.LogWarning("{Count} job(s) orfao(s) devolvido(s) a fila apos o visibility timeout.", released);
        }

        var claimed = await queue.ClaimAsync(workerId, _options.BatchSize, ct);
        if (claimed.Count == 0)
        {
            return CycleResult.Empty with { Released = released };
        }

        int sucesso = 0, retentativa = 0, falha = 0;

        // Os itens sao percorridos por ID, e nao pelas instancias devolvidas na
        // reivindicacao.
        //
        // O motivo e sutil e ja causou um defeito real: cada item processado
        // chama ResetTrackedState(), que limpa o rastreamento do contexto
        // INTEIRO. As instancias dos itens seguintes do mesmo lote ficariam
        // desanexadas, e as alteracoes feitas nelas jamais chegariam ao banco -
        // silenciosamente, porque SaveChanges nao reclama de entidade solta.
        var jobIds = claimed.Select(j => j.Id).ToList();

        foreach (var jobId in jobIds)
        {
            ct.ThrowIfCancellationRequested();

            var desfecho = await ProcessOneAsync(jobId, ct);
            switch (desfecho)
            {
                case Outcome.Succeeded: sucesso++; break;
                case Outcome.Retried: retentativa++; break;
                case Outcome.Failed: falha++; break;
            }
        }

        return new CycleResult(claimed.Count, sucesso, retentativa, falha, released);
    }

    private enum Outcome { Succeeded, Retried, Failed }

    private async Task<Outcome> ProcessOneAsync(Guid jobId, CancellationToken ct)
    {
        // Comeca de um estado limpo e releia: o item anterior do lote pode ter
        // limpado o rastreamento.
        db.ResetTrackedState();

        var job = await db.ProcessingJobs
            .Include(j => j.PaymentEvent)
            .FirstAsync(j => j.Id == jobId, ct);

        var evento = job.PaymentEvent!;

        // Valores copiados agora: apos um ResetTrackedState as referencias ficam
        // desanexadas e so os identificadores continuam servindo para reler.
        var eventoId = evento.Id;
        var idTransacao = evento.IdTransacao;
        var tentativaAtual = job.Tentativas;
        var maxTentativas = job.MaxTentativas;
        var podeRetentar = job.CanRetry;

        evento.MarkProcessing(job.Tentativas);
        await db.SaveChangesAsync(ct);

        try
        {
            // A regra pesada roda FORA da transacao. Segurar uma transacao aberta
            // durante 2s de trabalho prenderia uma conexao e as travas das linhas
            // por todo esse tempo - com dezenas de itens em paralelo, e assim que
            // se esgota o pool de conexoes.
            await businessRule.ExecuteAsync(evento, ct);

            var agora = clock.UtcNow;

            // Ja o efeito colateral e o fechamento do job vao juntos: contrato
            // atualizado com job ainda aberto seria contado duas vezes na proxima
            // tentativa.
            //
            // Tudo e relido dentro do delegate. A estrategia de resiliencia pode
            // reexecuta-lo, e reaplicar Apply() sobre um contrato ja somado em
            // memoria dobraria o valor liquidado - mesmo com a transacao anterior
            // desfeita no banco, porque o objeto rastreado guarda a mutacao.
            await db.ExecuteInTransactionAsync(async innerCt =>
            {
                db.ResetTrackedState();

                var ev = await db.PaymentEvents.FirstAsync(e => e.Id == eventoId, innerCt);
                var jb = await db.ProcessingJobs.FirstAsync(j => j.Id == jobId, innerCt);

                await ApplyToContractAsync(ev, agora, innerCt);
                ev.MarkSucceeded(agora);
                jb.Complete(agora);

                await db.SaveChangesAsync(innerCt);
            }, ct);

            logger.LogInformation(
                "Evento {IdTransacao} processado com sucesso na tentativa {Tentativa}.",
                idTransacao, tentativaAtual);

            return Outcome.Succeeded;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Desligamento em andamento: nao marca falha nem consome tentativa. O
            // lease expira e outro worker (ou este, ao reiniciar) retoma o item.
            throw;
        }
        catch (Exception ex)
        {
            var agora = clock.UtcNow;

            // A transacao de sucesso pode ter sido desfeita, deixando o contexto
            // com mutacoes que nunca chegaram ao banco. Releitura limpa garante
            // que o registro da falha reflita o estado real.
            db.ResetTrackedState();

            var ev = await db.PaymentEvents.FirstAsync(e => e.Id == eventoId, ct);
            var jb = await db.ProcessingJobs.FirstAsync(j => j.Id == jobId, ct);

            if (podeRetentar)
            {
                jb.Reschedule(ex.Message, agora, _options.BaseRetryDelay);
                ev.MarkRetrying(ex.Message, tentativaAtual);
                await db.SaveChangesAsync(ct);

                logger.LogWarning(ex,
                    "Evento {IdTransacao} falhou na tentativa {Tentativa}/{Max}; reagendado para {Quando}.",
                    idTransacao, tentativaAtual, maxTentativas, jb.DisponivelEm);

                return Outcome.Retried;
            }

            jb.Fail(ex.Message, agora);
            ev.MarkFailed(ex.Message, agora);
            await db.SaveChangesAsync(ct);

            logger.LogError(ex,
                "Evento {IdTransacao} falhou definitivamente apos {Max} tentativas.",
                idTransacao, maxTentativas);

            return Outcome.Failed;
        }
    }

    /// <summary>
    /// Projeta o evento no estado consolidado do contrato (upsert).
    /// </summary>
    /// <remarks>
    /// Roda dentro da transacao de conclusao do job. A concorrencia entre
    /// workers atualizando o MESMO contrato e resolvida pelo token <c>xmin</c>:
    /// o perdedor recebe <c>DbUpdateConcurrencyException</c>, que sobe como
    /// falha e devolve o item a fila - onde ele reaplica sobre o estado ja
    /// atualizado, em vez de sobrescreve-lo.
    /// </remarks>
    private async Task ApplyToContractAsync(PaymentEvent evento, DateTimeOffset agora, CancellationToken ct)
    {
        var idContrato = evento.IdContrato!;

        var contrato = await db.ContractStatuses.FirstOrDefaultAsync(c => c.IdContrato == idContrato, ct);
        if (contrato is null)
        {
            contrato = ContractStatus.Create(idContrato);
            db.ContractStatuses.Add(contrato);
        }

        contrato.Apply(
            PaymentWebhookRequestValidator.ParseStatus(evento.StatusOrigem!),
            evento.Valor!.Value,
            evento.DataPagamento!.Value,
            evento.IdTransacao,
            agora);
    }
}

/// <summary>
/// Regra de negocio simulada: ~2s de trabalho, como pede a task.
/// </summary>
/// <remarks>
/// Isolada atras de <see cref="IPaymentBusinessRule"/> por dois motivos: e onde
/// a regra real (liquidacao de seguro, baixa de parcela) entraria, e nos testes
/// ela e substituida por uma implementacao instantanea - ou por uma que lanca
/// excecao, que e como se exercita retentativa e falha definitiva sem esperar
/// segundos de relogio.
/// </remarks>
public sealed class SimulatedPaymentBusinessRule(
    IOptions<ProcessingOptions> options,
    ILogger<SimulatedPaymentBusinessRule> logger) : IPaymentBusinessRule
{
    public async Task ExecuteAsync(PaymentEvent evento, CancellationToken cancellationToken = default)
    {
        var duracao = options.Value.SimulatedWorkDuration;

        logger.LogDebug(
            "Iniciando regra de negocio de {Duracao}ms para {IdTransacao}.",
            duracao.TotalMilliseconds, evento.IdTransacao);

        await Task.Delay(duracao, cancellationToken);
    }
}
