using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Contracts;
using Sabemi.Application.Validation;
using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;

namespace Sabemi.Application.Payments;

/// <summary>Opcoes de ingestao e de processamento em background.</summary>
public sealed class ProcessingOptions
{
    public const string SectionName = "Processing";

    /// <summary>Tentativas por evento antes da falha definitiva.</summary>
    public int MaxTentativas { get; set; } = 3;

    /// <summary>Base do backoff exponencial entre tentativas.</summary>
    public TimeSpan BaseRetryDelay { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Duracao da regra de negocio simulada. A task pede ~2s de processamento
    /// pesado; e este valor que o webhook NAO paga, por rodar em outro processo.
    /// </summary>
    public TimeSpan SimulatedWorkDuration { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>Itens reivindicados por ciclo do worker.</summary>
    public int BatchSize { get; set; } = 10;

    /// <summary>Intervalo entre ciclos quando a fila esta vazia.</summary>
    public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Prazo para um worker concluir um item reivindicado. Passado ele, o item
    /// e considerado orfao (worker morto) e volta para a fila.
    /// </summary>
    public TimeSpan VisibilityTimeout { get; set; } = TimeSpan.FromMinutes(2);
}

/// <summary>Desfecho da ingestao, traduzido pela API em codigo HTTP.</summary>
public enum IngestionResultKind
{
    /// <summary>Evento novo e valido: persistido e enfileirado. HTTP 202.</summary>
    Accepted,

    /// <summary>Reentrega de um <c>id_transacao</c> conhecido. HTTP 200.</summary>
    Duplicate,

    /// <summary>Reprovado na validacao, mas persistido para auditoria. HTTP 400.</summary>
    Invalid
}

/// <param name="Kind">Desfecho.</param>
/// <param name="Ack">Corpo devolvido ao parceiro.</param>
/// <param name="Errors">Erros por campo, quando <see cref="IngestionResultKind.Invalid"/>.</param>
public sealed record IngestionResult(
    IngestionResultKind Kind,
    WebhookAck Ack,
    IReadOnlyDictionary<string, string[]>? Errors = null);

/// <summary>
/// Recebe uma notificacao de pagamento: valida, persiste e enfileira.
/// </summary>
/// <remarks>
/// <para><b>O caminho quente.</b> Este servico e tudo o que o banco parceiro
/// espera. Ele nao executa a regra de negocio - apenas grava e enfileira -, por
/// isso responde em milissegundos mesmo com a regra levando 2s.</para>
///
/// <para><b>Idempotencia.</b> A garantia e o indice unico sobre
/// <c>id_transacao</c>, e a insercao e feita de forma otimista: tenta-se
/// gravar, e a violacao de unicidade e o sinal de duplicidade. Consultar antes
/// de inserir seria uma verificacao inutil sob concorrencia - duas replicas
/// recebendo a mesma reentrega passariam as duas pelo <c>SELECT</c> e as duas
/// tentariam inserir. Aqui, o banco arbitra: uma insere, a outra recebe 23505 e
/// responde "duplicado" com HTTP 200.</para>
///
/// <para>Ainda assim ha uma consulta previa (<see cref="FindExistingAsync"/>),
/// mas o papel dela e outro: no caso comum de reentrega - o parceiro reenviando
/// por timeout de rede - ela evita gerar uma excecao e sujar o log. A corretude
/// nao depende dela.</para>
///
/// <para><b>Atomicidade.</b> O evento e o job vao na mesma transacao. Nao existe
/// janela em que o evento foi aceito mas nao ha nada enfileirado para
/// processa-lo.</para>
/// </remarks>
public sealed class PaymentIngestionService(
    IAppDbContext db,
    IClock clock,
    IDuplicateKeyDetector duplicateDetector,
    IOptions<ProcessingOptions> options,
    ILogger<PaymentIngestionService> logger)
{
    private readonly ProcessingOptions _options = options.Value;

    public async Task<IngestionResult> IngestAsync(
        PaymentWebhookRequest request,
        string rawBody,
        bool signatureVerified,
        CancellationToken cancellationToken = default)
    {
        var agora = clock.UtcNow;
        var validator = new PaymentWebhookRequestValidator(() => agora);
        var validation = await validator.ValidateAsync(request, cancellationToken);

        // Sem id_transacao nao ha chave de idempotencia, e portanto nao ha como
        // gravar a linha de auditoria sem colidir com outros payloads igualmente
        // incompletos. Este e o unico caso rejeitado sem persistir.
        if (string.IsNullOrWhiteSpace(request.IdTransacao))
        {
            logger.LogWarning("Webhook recebido sem id_transacao; nao ha chave de idempotencia para auditar.");
            return new IngestionResult(
                IngestionResultKind.Invalid,
                new WebhookAck
                {
                    IdTransacao = string.Empty,
                    Status = nameof(ProcessingStatus.Invalido).ToUpperInvariant(),
                    Duplicate = false,
                    ReceivedAt = agora,
                    Message = "O campo 'id_transacao' e obrigatorio."
                },
                ToErrorDictionary(validation.Errors.Select(e => (e.PropertyName, e.ErrorMessage))));
        }

        var idTransacao = request.IdTransacao.Trim();

        // Atalho para o caso comum de reentrega. Nao e a garantia - so evita a
        // excecao no caminho mais frequente.
        var existente = await FindExistingAsync(idTransacao, cancellationToken);
        if (existente is not null)
        {
            return DuplicateResult(existente, agora);
        }

        if (!validation.IsValid)
        {
            var motivos = string.Join(" ", validation.Errors.Select(e => e.ErrorMessage));
            return await PersistInvalidAsync(request, idTransacao, rawBody, motivos, signatureVerified, agora,
                ToErrorDictionary(validation.Errors.Select(e => (e.PropertyName, e.ErrorMessage))), cancellationToken);
        }

        Guid jobId = default;

        try
        {
            // Evento + job numa unica transacao: aceitar sem enfileirar seria
            // perder o trabalho em silencio, exatamente o que se quer evitar.
            //
            // As entidades sao construidas DENTRO do delegate porque a estrategia
            // de resiliencia pode reexecuta-lo; reaproveitar instancias ja
            // rastreadas de uma tentativa anterior deixaria o contexto sujo.
            await db.ExecuteInTransactionAsync(async ct =>
            {
                db.ResetTrackedState();

                var evento = PaymentEvent.Accepted(
                    idTransacao,
                    request.IdContrato!.Trim(),
                    request.Valor!.Value,
                    request.DataPagamento!.Value,
                    request.Status!.Trim().ToUpperInvariant(),
                    rawBody,
                    signatureVerified,
                    agora);

                var job = ProcessingJob.For(evento, _options.MaxTentativas, agora);
                jobId = job.Id;

                db.PaymentEvents.Add(evento);
                db.ProcessingJobs.Add(job);
                await db.SaveChangesAsync(ct);
            }, cancellationToken);
        }
        catch (Exception ex) when (duplicateDetector.IsDuplicateKey(ex))
        {
            // Corrida perdida: outra replica gravou este id_transacao entre a
            // nossa consulta e o nosso insert. E o desfecho correto, nao um erro.
            logger.LogInformation(
                "Reentrega concorrente de {IdTransacao} rejeitada pelo indice unico.", idTransacao);

            var vencedor = await FindExistingAsync(idTransacao, cancellationToken);
            return DuplicateResult(vencedor, agora);
        }

        logger.LogInformation(
            "Evento {IdTransacao} aceito e enfileirado (job {JobId}).", idTransacao, jobId);

        return new IngestionResult(
            IngestionResultKind.Accepted,
            new WebhookAck
            {
                IdTransacao = idTransacao,
                Status = nameof(ProcessingStatus.Pendente).ToUpperInvariant(),
                Duplicate = false,
                ReceivedAt = agora,
                Message = "Evento recebido e enfileirado para processamento."
            });
    }

    private Task<PaymentEvent?> FindExistingAsync(string idTransacao, CancellationToken ct)
        => db.PaymentEvents
            .AsNoTracking()
            .FirstOrDefaultAsync(e => e.IdTransacao == idTransacao, ct);

    private static IngestionResult DuplicateResult(PaymentEvent? existente, DateTimeOffset agora)
    {
        var idTransacao = existente?.IdTransacao ?? string.Empty;
        return new IngestionResult(
            IngestionResultKind.Duplicate,
            new WebhookAck
            {
                IdTransacao = idTransacao,
                // Devolve a situacao REAL do evento ja conhecido, nao um rotulo
                // generico: o parceiro descobre no mesmo passo que a notificacao
                // foi recebida antes e em que pe ela esta.
                Status = (existente?.StatusProcessamento ?? ProcessingStatus.Duplicado)
                    .ToString().ToUpperInvariant(),
                Duplicate = true,
                ReceivedAt = existente?.RecebidoEm ?? agora,
                Message = "Notificacao ja recebida anteriormente. Nenhum reprocessamento foi disparado."
            });
    }

    /// <summary>
    /// Grava o evento reprovado para ele aparecer no dashboard.
    /// </summary>
    /// <remarks>
    /// Nao enfileira job: nao ha o que processar. E preserva o que deu para
    /// aproveitar do payload, para o operador ter contexto na tela.
    /// </remarks>
    private async Task<IngestionResult> PersistInvalidAsync(
        PaymentWebhookRequest request,
        string idTransacao,
        string rawBody,
        string motivos,
        bool signatureVerified,
        DateTimeOffset agora,
        IReadOnlyDictionary<string, string[]> errors,
        CancellationToken ct)
    {
        var evento = PaymentEvent.Rejected(
            idTransacao,
            string.IsNullOrWhiteSpace(request.IdContrato) ? null : request.IdContrato.Trim(),
            request.Valor,
            request.DataPagamento,
            string.IsNullOrWhiteSpace(request.Status) ? null : request.Status.Trim().ToUpperInvariant(),
            rawBody,
            motivos,
            signatureVerified,
            agora);

        try
        {
            db.PaymentEvents.Add(evento);
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (duplicateDetector.IsDuplicateKey(ex))
        {
            var vencedor = await FindExistingAsync(idTransacao, ct);
            return DuplicateResult(vencedor, agora);
        }

        logger.LogWarning("Evento {IdTransacao} reprovado na validacao: {Motivos}", idTransacao, motivos);

        return new IngestionResult(
            IngestionResultKind.Invalid,
            new WebhookAck
            {
                IdTransacao = idTransacao,
                Status = nameof(ProcessingStatus.Invalido).ToUpperInvariant(),
                Duplicate = false,
                ReceivedAt = agora,
                Message = motivos
            },
            errors);
    }

    private static IReadOnlyDictionary<string, string[]> ToErrorDictionary(
        IEnumerable<(string Property, string Message)> errors)
        => errors
            .GroupBy(e => ToSnakeCase(e.Property))
            .ToDictionary(g => g.Key, g => g.Select(e => e.Message).ToArray());

    /// <summary>
    /// Converte o nome da propriedade C# para a chave do contrato
    /// (<c>IdTransacao</c> -> <c>id_transacao</c>), para o cliente casar o erro
    /// com o campo que ele enviou.
    /// </summary>
    private static string ToSnakeCase(string name)
    {
        var sb = new System.Text.StringBuilder(name.Length + 4);
        for (var i = 0; i < name.Length; i++)
        {
            if (char.IsUpper(name[i]))
            {
                if (i > 0) sb.Append('_');
                sb.Append(char.ToLowerInvariant(name[i]));
            }
            else
            {
                sb.Append(name[i]);
            }
        }
        return sb.ToString();
    }
}
