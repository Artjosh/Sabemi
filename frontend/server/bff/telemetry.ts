import { metrics, trace, type Counter, type Histogram, type Tracer } from "@opentelemetry/api";

/**
 * Instrumentos de metricas e tracing do backend VINEXT.
 *
 * <b>Espelho de `Sabemi.Application/Observability/SabemiTelemetry.cs`.</b> Os
 * nomes das metricas e os rotulos sao os MESMOS de proposito: os dois backends
 * gravam nas mesmas tabelas e cumprem o mesmo contrato, entao um painel de
 * `sabemi_processing_failures_total` precisa somar os dois. Nomes diferentes
 * dariam duas series que ninguem consegue comparar.
 *
 * <b>Este arquivo nao inicializa nada.</b> Ele so PEGA instrumentos da API do
 * OpenTelemetry. Enquanto o SDK nao for inicializado (ver `telemetry-setup.ts`),
 * a API devolve implementacoes de no-op: gravar numa metrica nao faz nada e nao
 * custa nada. E o que permite importar este modulo nos testes sem ligar
 * exportador algum, e o que garante que uma falha na observabilidade nunca
 * derrube o processamento de um pagamento.
 *
 * <b>Por que os instrumentos sao PREGUICOSOS.</b> Este e o detalhe que custou um
 * ciclo de diagnostico. `trace.getTracer()` devolve um proxy que passa a delegar
 * assim que o SDK sobe - por isso o tracer pode ser criado na importacao. Ja
 * `metrics.getMeter()` NAO: ele resolve o provedor na hora da chamada e devolve
 * o objeto concreto. Como este modulo e importado pelo servico de pagamentos,
 * que carrega antes de `iniciarTelemetria()` rodar, os instrumentos ficavam
 * presos ao meter no-op para sempre - `/metrics` subia, respondia, e nunca
 * mostrava uma metrica `sabemi_`. Nada falhava; simplesmente nao havia numero.
 *
 * Criando os instrumentos na primeira GRAVACAO, o meter ja e o de verdade.
 *
 * <b>Cardinalidade.</b> Nenhum rotulo carrega `id_transacao` ou `id_contrato`.
 * Uma serie temporal por transacao derrubaria o Prometheus em poucas horas -
 * esse nivel de detalhe pertence ao span, onde e barato.
 */

const NOME_DO_SERVICO = "sabemi-bff";

/**
 * Fonte dos spans.
 *
 * Pode ser criada na importacao, ao contrario dos instrumentos de metrica:
 * `getTracer` devolve um proxy que passa a delegar quando o SDK sobe.
 */
export const tracer: Tracer = trace.getTracer(NOME_DO_SERVICO, "1.0.0");

/** Instrumentos, criados na primeira gravacao. Ver o comentario do topo. */
interface Instrumentos {
  webhooksRecebidos: Counter;
  duracaoIngestao: Histogram;
  itensProcessados: Counter;
  duracaoProcessamento: Histogram;
  falhasDeProcessamento: Counter;
  reenfileiramentos: Counter;
}

let instrumentos: Instrumentos | null = null;

function obter(): Instrumentos {
  if (instrumentos) return instrumentos;

  const meter = metrics.getMeter(NOME_DO_SERVICO, "1.0.0");

  instrumentos = {
    /**
     * Webhooks recebidos, por desfecho da INGESTAO (`aceito`, `duplicado`,
     * `invalido`).
     *
     * Separar duplicado de aceito e o que torna a idempotencia observavel: uma
     * subida repentina de `duplicado` normalmente significa que o parceiro esta
     * reentregando - e vale saber disso antes que alguem pergunte.
     */
    webhooksRecebidos: meter.createCounter("sabemi_webhook_events_total", {
      unit: "{evento}",
      description: "Webhooks de pagamento recebidos, por desfecho da ingestao.",
    }),

    /**
     * Tempo do webhook, do recebimento ate a resposta.
     *
     * A metrica que prova o requisito central da task: a regra pesada (~2s) NAO
     * bloqueia o webhook. Se esta distribuicao passar de alguns milissegundos, o
     * processamento voltou para dentro do request.
     */
    duracaoIngestao: meter.createHistogram("sabemi_webhook_duration_seconds", {
      unit: "s",
      description: "Tempo de resposta do webhook de pagamento.",
    }),

    itensProcessados: meter.createCounter("sabemi_processing_items_total", {
      unit: "{item}",
      description: "Itens da fila processados, por desfecho.",
    }),

    duracaoProcessamento: meter.createHistogram("sabemi_processing_duration_seconds", {
      unit: "s",
      description: "Tempo de processamento de um item da fila.",
    }),

    /**
     * Falhas por causa. Rotulos: `codigo` e `categoria`.
     *
     * E por isso que os codigos do catalogo precisam ser estaveis: uma
     * renomeacao encerra a serie antiga e comeca outra, e o painel mostra uma
     * queda que nunca aconteceu. A separacao por categoria responde a pergunta
     * que importa em plantao - "isso vai se resolver sozinho?".
     */
    falhasDeProcessamento: meter.createCounter("sabemi_processing_failures_total", {
      unit: "{falha}",
      description: "Falhas de processamento, por codigo e categoria de causa.",
    }),

    reenfileiramentos: meter.createCounter("sabemi_requeue_total", {
      unit: "{acao}",
      description: "Reenfileiramentos manuais solicitados no painel, por desfecho.",
    }),
  };

  return instrumentos;
}

/**
 * Descarta os instrumentos ja criados.
 *
 * Chamado por `iniciarTelemetria()` logo depois de registrar o provedor global.
 * Sem isto, qualquer gravacao que tenha acontecido ANTES da inicializacao - um
 * webhook atendido nos primeiros milissegundos do processo - teria fixado os
 * instrumentos no meter no-op, e eles nunca mais produziriam numero algum.
 */
export function reiniciarInstrumentos(): void {
  instrumentos = null;
}

/** Registra o desfecho de um webhook. */
export function registrarIngestao(desfecho: string, segundos: number): void {
  const i = obter();
  i.webhooksRecebidos.add(1, { desfecho });
  i.duracaoIngestao.record(segundos, { desfecho });
}

/** Registra o desfecho do processamento de um item. */
export function registrarProcessamento(desfecho: string, segundos: number): void {
  const i = obter();
  i.itensProcessados.add(1, { desfecho });
  i.duracaoProcessamento.record(segundos, { desfecho });
}

/** Registra uma falha ja classificada. */
export function registrarFalha(codigo: string, categoria: string): void {
  obter().falhasDeProcessamento.add(1, { codigo, categoria });
}

/** Registra um reenfileiramento manual, por desfecho. */
export function registrarReenfileiramento(desfecho: string): void {
  obter().reenfileiramentos.add(1, { desfecho });
}
