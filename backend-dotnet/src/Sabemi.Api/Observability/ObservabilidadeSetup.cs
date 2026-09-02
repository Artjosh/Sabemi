using Npgsql;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Sabemi.Application.Observability;

namespace Sabemi.Api.Observability;

/// <summary>
/// Liga metricas e tracing.
/// </summary>
/// <remarks>
/// <b>Duas saidas, por motivos diferentes.</b> Metricas vao para
/// <c>/metrics</c>, em formato Prometheus: elas sao continuas e baratas, e o
/// modelo de coleta (o Prometheus busca) significa que a API nao precisa
/// conhecer ninguem. Traces vao por OTLP para um coletor: eles sao volumosos e
/// so fazem sentido agregados com os do worker e os do BFF.
///
/// <b>Tracing e opcional, metricas nao.</b> Sem
/// <c>OTEL_EXPORTER_OTLP_ENDPOINT</c> configurado, o tracing simplesmente nao e
/// ligado - `docker compose up` continua funcionando sem um Jaeger no ar.
/// Metricas nao dependem de ninguem, entao <c>/metrics</c> esta sempre de pe.
///
/// <b>Por que o <c>id_transacao</c> nao vira rotulo.</b> Ele e atributo de span.
/// Como rotulo de metrica, criaria uma serie temporal por transacao - o erro de
/// cardinalidade que derruba um Prometheus em horas. Ver
/// <see cref="SabemiTelemetry"/>.
/// </remarks>
public static class ObservabilidadeSetup
{
    public static IServiceCollection AddObservabilidade(
        this IServiceCollection services,
        IConfiguration configuracao,
        string nomeDoServico)
    {
        var otlp = configuracao["OTEL_EXPORTER_OTLP_ENDPOINT"];
        var temTracing = !string.IsNullOrWhiteSpace(otlp);

        var builder = services.AddOpenTelemetry().ConfigureResource(r => r
            .AddService(
                serviceName: nomeDoServico,
                serviceNamespace: configuracao["OTEL_SERVICE_NAMESPACE"] ?? "sabemi",
                serviceVersion: "1.0.0")
            // `host.name` porque duas replicas do worker apareceriam como um
            // serviço so, e ficaria impossivel dizer qual delas esta lenta.
            .AddAttributes([new KeyValuePair<string, object>("host.name", Environment.MachineName)]));

        builder.WithMetrics(m => m
            .AddMeter(SabemiTelemetry.Meter.Name)
            .AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation()
            .AddRuntimeInstrumentation()

            // Buckets explicitos, em SEGUNDOS.
            //
            // Os buckets padrao do SDK sao 0, 5, 10, 25, 50, ... 10000 - pensados
            // para MILISSEGUNDOS. Como estes histogramas gravam segundos, toda
            // medicao real caia no primeiro bucket: o p95 do webhook aparecia
            // como "<= 5" (cinco segundos), que nao diz nada. Pior: a metrica
            // parecia funcionar.
            //
            // A faixa aqui vai de 1ms a 10s. A ponta baixa importa porque e onde
            // o webhook deve estar - se ele sair dos milissegundos, a regra
            // pesada voltou para dentro do request.
            .AddView(
                instrumentName: "sabemi_webhook_duration_seconds",
                new ExplicitBucketHistogramConfiguration
                {
                    Boundaries = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
                })

            // O processamento e outra escala: a regra simulada sozinha leva ~2s,
            // entao buckets abaixo de 100ms seriam desperdicio e a ponta alta
            // precisa alcancar um item lento de verdade.
            .AddView(
                instrumentName: "sabemi_processing_duration_seconds",
                new ExplicitBucketHistogramConfiguration
                {
                    Boundaries = [0.1, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 30, 60],
                })

            .AddPrometheusExporter());

        if (temTracing)
        {
            builder.WithTracing(t => t
                .AddSource(SabemiTelemetry.Activity.Name)
                .AddAspNetCoreInstrumentation(o =>
                {
                    // O proprio /metrics e o /health nao viram trace: eles sao
                    // chamados a cada poucos segundos e afogariam os spans que
                    // interessam.
                    o.Filter = ctx =>
                        !ctx.Request.Path.StartsWithSegments("/metrics")
                        && !ctx.Request.Path.StartsWithSegments("/health");
                })
                .AddHttpClientInstrumentation()
                .AddNpgsql()
                .AddOtlpExporter(o => o.Endpoint = new Uri(otlp!)));
        }

        return services;
    }
}
