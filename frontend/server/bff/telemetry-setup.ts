import { metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationType, MeterProvider } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import { bffConfig } from "./config";
import { reiniciarInstrumentos } from "./telemetry";

/**
 * Inicializa o SDK do OpenTelemetry no backend VINEXT.
 *
 * <b>Separado de `telemetry.ts` de proposito.</b> Aquele arquivo so pega
 * instrumentos da API - e importavel de qualquer lugar, inclusive dos testes,
 * sem efeito colateral. Este aqui ABRE porta e conexao, entao roda uma unica vez
 * e apenas quando o servidor sobe. Misturar os dois faria cada teste que toca no
 * servico de pagamentos subir um exportador Prometheus.
 *
 * <b>Nada aqui pode derrubar o servidor.</b> Observabilidade e apoio: se o
 * coletor estiver fora do ar ou a porta ocupada, o pior desfecho aceitavel e
 * ficar sem metricas. Por isso a inicializacao inteira esta em try/catch e
 * apenas registra um aviso.
 *
 * <b>Metricas: exportador proprio, e nao o do NodeSDK.</b> O `PrometheusExporter`
 * sobe um servidor HTTP proprio (porta 9464 por padrao, a que a especificacao do
 * OpenTelemetry reserva). Poderia-se servir `/metrics` pela rota do BFF, mas o
 * VINEXT roda o handler em um contexto por requisicao e o exportador precisa de
 * um coletor de longa duracao - a porta separada e mais simples e e o que as
 * ferramentas esperam encontrar.
 *
 * <b>Tracing e opcional.</b> Sem `OTEL_EXPORTER_OTLP_ENDPOINT` configurado, o
 * tracing nao e ligado e `docker compose up` continua funcionando sem um
 * coletor no ar.
 */

let iniciado = false;

export function iniciarTelemetria(): void {
  // Guarda contra dupla inicializacao. Em desenvolvimento o HMR reavalia
  // modulos, e um segundo `PrometheusExporter` na mesma porta falharia com
  // EADDRINUSE - um erro que parece nao ter causa.
  if (iniciado) return;
  iniciado = true;

  try {
    const recurso = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "sabemi-bff",
      [ATTR_SERVICE_VERSION]: "1.0.0",
      // Com varias replicas, sem isto fica impossivel dizer QUAL delas esta
      // lenta.
      "host.name": process.env.HOSTNAME ?? "desconhecido",
      "service.namespace": process.env.OTEL_SERVICE_NAMESPACE ?? "sabemi",
    });

    const porta = Number(process.env.METRICS_PORT ?? 9464);

    // O construtor do PrometheusExporter ja inicia o servidor HTTP.
    const exportadorDeMetricas = new PrometheusExporter(
      { port: porta, endpoint: "/metrics" },
      () => {
        console.info(`[bff-telemetria] métricas em http://0.0.0.0:${porta}/metrics`);
      },
    );

    const meterProvider = new MeterProvider({
      resource: recurso,
      readers: [exportadorDeMetricas],

      // Buckets explicitos, em SEGUNDOS.
      //
      // Os buckets padrao do SDK sao pensados para MILISSEGUNDOS (0, 5, 10, 25,
      // ... 10000). Como estes histogramas gravam segundos, toda medicao real
      // caia no primeiro bucket e o p95 do webhook aparecia como "<= 5" - cinco
      // segundos, um numero que nao diz nada. Pior: a metrica parecia funcionar.
      views: [
        {
          instrumentName: "sabemi_webhook_duration_seconds",
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              // A ponta baixa importa: e onde o webhook DEVE estar. Se ele sair
              // dos milissegundos, a regra pesada voltou para dentro do request.
              boundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            },
          },
        },
        {
          instrumentName: "sabemi_processing_duration_seconds",
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              // Outra escala: a regra simulada sozinha leva ~2s.
              boundaries: [0.1, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 30, 60],
            },
          },
        },
      ],
    });

    // Registra como provedor global: e o que faz `metrics.getMeter()` em
    // telemetry.ts parar de devolver no-op e passar a gravar de verdade.
    metrics.setGlobalMeterProvider(meterProvider);

    // E descarta os instrumentos que porventura ja tenham sido criados. Ao
    // contrario do tracer, um instrumento de metrica fica preso ao meter que o
    // criou: um webhook atendido nos primeiros milissegundos do processo teria
    // fixado tudo no meter no-op, e /metrics nunca mostraria uma metrica
    // `sabemi_` - sem erro nenhum, so ausencia de numero.
    reiniciarInstrumentos();

    const otlp = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    if (otlp) {
      const sdk = new NodeSDK({
        resource: recurso,
        traceExporter: new OTLPTraceExporter({
          // O SDK espera o caminho completo; a variavel padrao aponta so para a
          // base do coletor.
          url: `${otlp.replace(/\/$/, "")}/v1/traces`,
        }),
        // Instrumentacao do `pg` para as consultas aparecerem como spans filhos
        // dentro do span do webhook - e assim que se ve que os 2s do
        // processamento sao a regra de negocio, e nao o banco.
        instrumentations: [new PgInstrumentation()],
      });

      sdk.start();

      // Descarrega o que estiver em buffer antes de o processo morrer. Sem isto,
      // os spans dos ultimos segundos - normalmente os mais interessantes,
      // porque foram eles que motivaram o desligamento - se perdem.
      const encerrar = () => {
        void sdk.shutdown().catch(() => {
          // Encerrando de qualquer forma: nao ha o que fazer aqui.
        });
      };

      process.once("SIGTERM", encerrar);
      process.once("SIGINT", encerrar);

      console.info(`[bff-telemetria] tracing OTLP para ${otlp}`);
    } else if (!bffConfig.isProduction) {
      console.info("[bff-telemetria] OTEL_EXPORTER_OTLP_ENDPOINT ausente: tracing desligado.");
    }
  } catch (erro) {
    // Observabilidade nao pode derrubar o servico que ela observa.
    console.warn("[bff-telemetria] não foi possível iniciar a telemetria:", erro);
  }
}
