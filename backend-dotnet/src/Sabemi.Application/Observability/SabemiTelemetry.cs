using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Sabemi.Application.Observability;

/// <summary>
/// Instrumentos de metricas e tracing do dominio.
/// </summary>
/// <remarks>
/// <b>Por que aqui, e nao no host.</b> Este arquivo usa apenas
/// <c>System.Diagnostics</c> - nada de OpenTelemetry. Quem emite a medicao e a
/// camada que conhece o significado dela (a ingestao sabe o que e uma
/// reentrega; o worker sabe o que e uma tentativa); quem decide para ONDE
/// exportar e o host. Trocar OTLP por outra coisa nao toca em uma linha da
/// aplicacao, e os testes rodam sem exportador algum.
///
/// <b>Nomes.</b> Prefixo <c>sabemi_</c>, sufixo de unidade, snake_case - as
/// convencoes do Prometheus. Estes nomes viram consultas em painel e regras de
/// alerta: renomear um quebra tudo isso silenciosamente. Trate-os como contrato
/// publico, do mesmo jeito que os codigos do <c>FailureCatalog</c>.
///
/// <b>Cardinalidade.</b> Nenhum rotulo carrega <c>id_transacao</c> ou
/// <c>id_contrato</c>. Uma serie temporal por transacao derrubaria o Prometheus
/// em poucas horas - esse nivel de detalhe pertence ao trace e ao log, onde e
/// barato. Os rotulos usados tem dominio pequeno e fechado: situacao, categoria
/// de falha, codigo de falha.
/// </remarks>
public static class SabemiTelemetry
{
    /// <summary>Nome do serviço, usado no recurso OTLP e nas metricas.</summary>
    public const string ServiceName = "sabemi-webhooks";

    /// <summary>Fonte dos spans. O host a registra em <c>AddSource</c>.</summary>
    public static readonly ActivitySource Activity = new(ServiceName, "1.0.0");

    /// <summary>Fonte dos instrumentos. O host a registra em <c>AddMeter</c>.</summary>
    public static readonly Meter Meter = new(ServiceName, "1.0.0");

    // ------------------------------------------------------------- ingestao

    /// <summary>
    /// Webhooks recebidos, por desfecho da INGESTAO (<c>aceito</c>,
    /// <c>duplicado</c>, <c>invalido</c>).
    /// </summary>
    /// <remarks>
    /// Separar duplicado de aceito e o que torna a idempotencia observavel: uma
    /// subida repentina de <c>duplicado</c> normalmente significa que o parceiro
    /// esta reentregando - e vale saber disso antes que alguem pergunte.
    /// </remarks>
    public static readonly Counter<long> WebhooksRecebidos =
        Meter.CreateCounter<long>(
            "sabemi_webhook_events_total",
            unit: "{evento}",
            description: "Webhooks de pagamento recebidos, por desfecho da ingestao.");

    /// <summary>
    /// Tempo do webhook, do recebimento ate a resposta.
    /// </summary>
    /// <remarks>
    /// A metrica que prova o requisito central da task: a regra pesada (~2s) NAO
    /// bloqueia o webhook. Se esta distribuicao passar de alguns milissegundos, o
    /// processamento voltou para dentro do request.
    /// </remarks>
    public static readonly Histogram<double> DuracaoIngestao =
        Meter.CreateHistogram<double>(
            "sabemi_webhook_duration_seconds",
            unit: "s",
            description: "Tempo de resposta do webhook de pagamento.");

    // --------------------------------------------------------- processamento

    /// <summary>Itens processados, por desfecho (<c>sucesso</c>, <c>retentativa</c>, <c>falha</c>).</summary>
    public static readonly Counter<long> ItensProcessados =
        Meter.CreateCounter<long>(
            "sabemi_processing_items_total",
            unit: "{item}",
            description: "Itens da fila processados, por desfecho.");

    /// <summary>
    /// Falhas por causa. Rotulos: <c>codigo</c> e <c>categoria</c>.
    /// </summary>
    /// <remarks>
    /// E por isso que os codigos do <c>FailureCatalog</c> precisam ser estaveis:
    /// uma renomeacao encerra a serie antiga e comeca outra, e o painel passa a
    /// mostrar uma queda que nunca aconteceu. A separacao por categoria responde
    /// a pergunta que importa em plantao - "isso vai se resolver sozinho?".
    /// </remarks>
    public static readonly Counter<long> FalhasDeProcessamento =
        Meter.CreateCounter<long>(
            "sabemi_processing_failures_total",
            unit: "{falha}",
            description: "Falhas de processamento, por codigo e categoria de causa.");

    /// <summary>
    /// Duracao do processamento de UM item, incluindo a regra pesada.
    /// </summary>
    public static readonly Histogram<double> DuracaoProcessamento =
        Meter.CreateHistogram<double>(
            "sabemi_processing_duration_seconds",
            unit: "s",
            description: "Tempo de processamento de um item da fila.");

    /// <summary>Reenfileiramentos manuais, por desfecho.</summary>
    public static readonly Counter<long> Reenfileiramentos =
        Meter.CreateCounter<long>(
            "sabemi_requeue_total",
            unit: "{acao}",
            description: "Reenfileiramentos manuais solicitados no painel, por desfecho.");

    /// <summary>
    /// Registra o desfecho de um webhook.
    /// </summary>
    /// <param name="desfecho"><c>aceito</c>, <c>duplicado</c> ou <c>invalido</c>.</param>
    /// <param name="segundos">Tempo total da requisicao.</param>
    public static void RegistrarIngestao(string desfecho, double segundos)
    {
        var rotulo = new KeyValuePair<string, object?>("desfecho", desfecho);

        WebhooksRecebidos.Add(1, rotulo);
        DuracaoIngestao.Record(segundos, rotulo);
    }

    /// <summary>Registra o desfecho do processamento de um item.</summary>
    public static void RegistrarProcessamento(string desfecho, double segundos)
    {
        var rotulo = new KeyValuePair<string, object?>("desfecho", desfecho);

        ItensProcessados.Add(1, rotulo);
        DuracaoProcessamento.Record(segundos, rotulo);
    }

    /// <summary>Registra uma falha ja classificada.</summary>
    public static void RegistrarFalha(string codigo, string categoria)
        => FalhasDeProcessamento.Add(
            1,
            new KeyValuePair<string, object?>("codigo", codigo),
            new KeyValuePair<string, object?>("categoria", categoria));
}
