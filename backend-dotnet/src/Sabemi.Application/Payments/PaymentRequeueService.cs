using Microsoft.EntityFrameworkCore;
using Sabemi.Application.Observability;
using Microsoft.Extensions.Logging;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Contracts;
using Sabemi.Domain.Entities;

namespace Sabemi.Application.Payments;

/// <summary>
/// Devolve a fila um evento que falhou, por decisao de uma pessoa no painel.
/// </summary>
/// <remarks>
/// <b>Por que existe.</b> O retry automatico so cobre falhas transitorias, e por
/// desenho: uma causa permanente nao melhora com repeticao, entao o item vai
/// direto para ERRO e para de gastar tentativas. Mas "permanente" quer dizer
/// "nao passa sozinha", nao "nao passa nunca" - o contrato que faltava pode ser
/// cadastrado, a dependencia pode ser corrigida. Sem este caminho, a unica saida
/// seria reenviar o webhook com um <c>id_transacao</c> diferente, o que sujaria
/// o log de eventos com uma linha duplicada de um pagamento que e o mesmo.
///
/// <b>Por que nao reprocessa aqui mesmo.</b> Reenfileirar apenas devolve o item
/// a fila; quem processa continua sendo o worker. Executar a regra de 2s dentro
/// do request seguraria a conexao HTTP por todo esse tempo e criaria um segundo
/// caminho de processamento - com as proprias condicoes de corrida - ao lado do
/// que ja existe. O botao responde na hora e o resultado aparece no painel
/// segundos depois, pelo mesmo caminho de sempre.
/// </remarks>
public sealed class PaymentRequeueService(
    IAppDbContext db,
    IClock clock,
    ILogger<PaymentRequeueService> logger)
{
    /// <summary>Por que um reenfileiramento nao pode ser feito.</summary>
    public enum RequeueFailure
    {
        /// <summary>Nao existe evento com este <c>id_transacao</c>.</summary>
        NotFound,

        /// <summary>O estado atual do evento nao permite - ver a mensagem.</summary>
        NotEligible
    }

    /// <summary>
    /// Devolve o evento a fila. Idempotente por natureza: chamar duas vezes
    /// seguidas devolve <see cref="RequeueFailure.NotEligible"/> na segunda,
    /// porque a primeira ja tirou o evento do estado ERRO. Dois cliques
    /// apressados nao geram dois processamentos.
    /// </summary>
    public async Task<RequeueOutcome> RequeueAsync(
        string idTransacao,
        CancellationToken ct = default)
    {
        var evento = await db.PaymentEvents
            .FirstOrDefaultAsync(e => e.IdTransacao == idTransacao, ct);

        if (evento is null)
        {
            SabemiTelemetry.Reenfileiramentos.Add(
                1, new KeyValuePair<string, object?>("desfecho", "nao_encontrado"));

            return RequeueOutcome.Fail(
                RequeueFailure.NotFound,
                $"Nenhum evento com id_transacao '{idTransacao}'.");
        }

        if (!evento.PodeSerReenfileirado)
        {
            // Vale contar as recusas: uma subida delas costuma significar que o
            // painel esta oferecendo o botao onde nao deveria, ou que quem opera
            // nao entendeu por que ele nao funciona.
            SabemiTelemetry.Reenfileiramentos.Add(
                1, new KeyValuePair<string, object?>("desfecho", "recusado"));

            return RequeueOutcome.Fail(
                RequeueFailure.NotEligible,
                MotivoDaRecusa(evento));
        }

        var job = await db.ProcessingJobs
            .FirstOrDefaultAsync(j => j.PaymentEventId == evento.Id, ct);

        if (job is null)
        {
            // Um evento em ERRO sempre teve job - eles nascem na mesma transacao
            // do webhook. Chegar aqui significa que alguem apagou a linha da
            // fila a mao. Recriar e melhor do que recusar: o dado que importa
            // (o evento bruto) esta intacto, e e dele que o job deriva.
            logger.LogWarning(
                "Evento {IdTransacao} estava em ERRO sem job na fila; um novo foi criado.",
                idTransacao);

            job = ProcessingJob.For(evento, MaxTentativasPadrao, clock.UtcNow);
            db.ProcessingJobs.Add(job);
        }

        var agora = clock.UtcNow;

        // Os dois na MESMA transacao: um evento em PENDENTE sem job na fila
        // ficaria parado para sempre, e um job pendente cujo evento continua em
        // ERRO mostraria no painel um estado que nao corresponde ao que vai
        // acontecer.
        await db.ExecuteInTransactionAsync(async innerCt =>
        {
            job.Requeue(agora);
            evento.MarkRequeued();
            await db.SaveChangesAsync(innerCt);
        }, ct);

        SabemiTelemetry.Reenfileiramentos.Add(
            1, new KeyValuePair<string, object?>("desfecho", "reenfileirado"));

        logger.LogInformation(
            "Evento {IdTransacao} devolvido a fila manualmente (causa anterior: {Codigo}).",
            idTransacao, evento.ErroCodigo ?? "desconhecida");

        return RequeueOutcome.Success(new RequeueResultDto
        {
            IdTransacao = evento.IdTransacao,
            StatusProcessamento = evento.StatusProcessamento.ToString().ToUpperInvariant(),
            ReenfileiradoEm = agora,
            Message = "Evento devolvido a fila. O processamento acontece em segundo plano.",
        });
    }

    /// <summary>
    /// Tentativas concedidas a um item recriado. Vale so para o caso raro do job
    /// ausente; o valor normal vem de <c>ProcessingOptions</c>, mas injetar as
    /// opcoes inteiras aqui acoplaria este servico a configuracao do worker por
    /// causa de um caminho que quase nunca executa.
    /// </summary>
    private const int MaxTentativasPadrao = 3;

    /// <summary>
    /// Diz por que ESTE evento nao pode ser reenfileirado. Uma recusa generica
    /// ("nao elegivel") obrigaria quem opera a adivinhar; cada estado tem um
    /// motivo diferente e uma acao diferente.
    /// </summary>
    private static string MotivoDaRecusa(PaymentEvent evento) => evento.StatusProcessamento switch
    {
        Domain.Enums.ProcessingStatus.Sucesso =>
            "Este evento ja foi processado com sucesso e o valor ja esta somado ao contrato. "
            + "Reprocessa-lo somaria o pagamento uma segunda vez.",

        Domain.Enums.ProcessingStatus.Pendente or Domain.Enums.ProcessingStatus.Processando =>
            "Este evento ja esta na fila. Aguarde o desfecho - a pagina se atualiza sozinha.",

        Domain.Enums.ProcessingStatus.Invalido =>
            "Este evento foi reprovado na validacao e nunca chegou a ser enfileirado. "
            + "O payload nao muda por ser reprocessado: corrija na origem e reenvie o webhook.",

        _ =>
            $"Um evento em {evento.StatusProcessamento.ToString().ToUpperInvariant()} nao pode ser reenfileirado.",
    };
}

/// <summary>
/// Desfecho de um reenfileiramento. Mesmo formato do <c>AuthResult&lt;T&gt;</c>
/// usado na autenticacao - um so idioma de resultado no projeto inteiro.
/// </summary>
public readonly record struct RequeueOutcome(
    RequeueResultDto? Value,
    PaymentRequeueService.RequeueFailure? Failure,
    string? Message)
{
    public bool Ok => Failure is null;

    public static RequeueOutcome Success(RequeueResultDto value) => new(value, null, null);

    public static RequeueOutcome Fail(PaymentRequeueService.RequeueFailure failure, string message)
        => new(null, failure, message);
}
