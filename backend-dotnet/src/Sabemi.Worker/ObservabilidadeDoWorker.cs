using System.Net;
using Npgsql;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Sabemi.Application.Observability;

namespace Sabemi.Worker;

/// <summary>
/// Liga metricas e tracing no worker.
/// </summary>
/// <remarks>
/// <b>Por que o worker precisa disso mais do que a API.</b> Uma falha na API
/// aparece imediatamente: alguem recebe um 500. Uma fila que parou de drenar nao
/// aparece em lugar nenhum - o webhook continua respondendo 202, os eventos
/// continuam entrando, e ninguem percebe ate que um contrato apareça sem o
/// pagamento. <c>sabemi_processing_items_total</c> caindo a zero e o unico sinal
/// precoce disso.
///
/// <b>Por que HttpListener e nao um middleware.</b> O worker e um
/// <c>Host</c> sem pipeline HTTP. Subir um ASP.NET inteiro so para servir
/// <c>/metrics</c> traria autenticacao, roteamento e middlewares que nao tem uso
/// aqui. O <c>PrometheusHttpListener</c> abre uma porta e serve um caminho - e
/// exatamente o que se precisa.
///
/// A porta e configuravel e o padrao (9464) e a que a especificacao do
/// OpenTelemetry reserva para exportadores Prometheus.
/// </remarks>
public static class ObservabilidadeDoWorker
{
    public static IServiceCollection AddObservabilidadeDoWorker(
        this IServiceCollection services,
        IConfiguration configuracao)
    {
        var otlp = configuracao["OTEL_EXPORTER_OTLP_ENDPOINT"];
        var porta = configuracao.GetValue("Metrics:Port", 9464);

        var builder = services.AddOpenTelemetry().ConfigureResource(r => r
            .AddService(
                serviceName: "sabemi-worker",
                serviceNamespace: configuracao["OTEL_SERVICE_NAMESPACE"] ?? "sabemi",
                serviceVersion: "1.0.0")
            // Com varias replicas drenando a mesma fila, sem `host.name` fica
            // impossivel dizer QUAL delas travou.
            .AddAttributes([new KeyValuePair<string, object>("host.name", Environment.MachineName)]));

        builder.WithMetrics(m => m
            .AddMeter(SabemiTelemetry.Meter.Name)
            .AddRuntimeInstrumentation()

            // Buckets explicitos, em SEGUNDOS - os padroes do SDK sao pensados
            // para milissegundos e jogariam toda medicao real no primeiro
            // bucket. A regra simulada sozinha leva ~2s, entao a faixa util
            // comeca em 100ms e precisa alcancar um item lento de verdade.
            .AddView(
                instrumentName: "sabemi_processing_duration_seconds",
                new ExplicitBucketHistogramConfiguration
                {
                    Boundaries = [0.1, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 30, 60],
                })
            .AddPrometheusHttpListener(o =>
            {
                // Estes tres valores nao sao os que valem no fim - ver o
                // `ConfigureHttpListener` abaixo. Eles existem porque o
                // exportador VALIDA a combinacao antes de construir o listener, e
                // `Host` precisa ser um hostname parseavel por `Uri`.
                o.Host = "localhost";
                o.Port = porta;
                o.ScrapeEndpointPath = "/metrics";

                // O prefixo real, trocado depois da construcao.
                //
                // <b>Por que este contorno.</b> Dentro de um container, um
                // listener preso ao loopback e inalcancavel de fora e a raspagem
                // falha sem nenhum erro visivel no worker. Escutar em todas as
                // interfaces exige o curinga `+`, e ai as duas validacoes se
                // contradizem:
                //
                //   - `Host = "+"`  -> o exportador monta `new Uri("http://+:9464/metrics/")`
                //                      e falha: "hostname could not be parsed";
                //   - `Host = "0.0.0.0"` -> passa na validacao, mas o HttpListener
                //                      do .NET no Linux recusa bind explicito:
                //                      HttpListenerException (50).
                //
                // Trocar os prefixos DEPOIS da construcao contorna as duas: a
                // validacao ve `localhost` e o listener recebe o curinga.
                o.ConfigureHttpListener = (_, listener) =>
                {
                    listener.Prefixes.Clear();
                    listener.Prefixes.Add($"http://+:{porta}/metrics/");
                };
            }));

        if (!string.IsNullOrWhiteSpace(otlp))
        {
            builder.WithTracing(t => t
                .AddSource(SabemiTelemetry.Activity.Name)
                .AddNpgsql()
                .AddOtlpExporter(o => o.Endpoint = new Uri(otlp)));
        }

        return services;
    }
}
