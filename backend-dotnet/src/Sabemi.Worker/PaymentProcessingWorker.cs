using Microsoft.Extensions.Options;
using Sabemi.Application.Auth;
using Sabemi.Application.Payments;

namespace Sabemi.Worker;

/// <summary>
/// Host do processamento em background: repete o ciclo da fila enquanto o
/// processo viver.
/// </summary>
/// <remarks>
/// <para>Este e o processo separado que executa a regra de ~2s. E o que faz o
/// webhook responder em milissegundos: a API grava e enfileira, e o trabalho
/// pesado acontece aqui, em outro container.</para>
///
/// <para><b>O que esta classe deliberadamente NAO faz.</b> Ela nao contem regra
/// de negocio, nao sabe o que e um pagamento e nao toca no banco diretamente.
/// Ela e so o laco: cria um escopo, chama
/// <see cref="PaymentProcessingService.RunOnceAsync"/>, trata o intervalo e
/// repete. Toda a logica vive no servico de aplicacao, que os testes chamam
/// direto - sem precisar hospedar nada nem esperar temporizadores.</para>
///
/// <para><b>Escopo por ciclo.</b> Um <c>BackgroundService</c> e singleton; o
/// <c>DbContext</c> e scoped. Reutilizar um contexto pela vida inteira do
/// processo acumularia entidades rastreadas ate estourar a memoria, e um erro
/// deixaria o contexto em estado inconsistente para sempre. Um escopo por ciclo
/// resolve os dois.</para>
///
/// <para><b>Espera adaptativa.</b> Ciclo produtivo volta imediatamente - havendo
/// fila, nao ha razao para dormir. Ciclo vazio espera <c>PollInterval</c>. Assim
/// a latencia fica baixa sob carga sem martelar o banco quando esta ocioso.</para>
/// </remarks>
public sealed class PaymentProcessingWorker(
    IServiceScopeFactory scopeFactory,
    IOptions<ProcessingOptions> options,
    IHostEnvironment environment,
    ILogger<PaymentProcessingWorker> logger) : BackgroundService
{
    private readonly ProcessingOptions _options = options.Value;

    /// <summary>
    /// Identidade desta replica, gravada no job reivindicado. Com varias
    /// replicas, e o que responde "quem estava processando isto quando parou?".
    /// </summary>
    private readonly string _workerId = $"{Environment.MachineName}:{Environment.ProcessId}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation(
            "Worker {WorkerId} iniciado no ambiente {Ambiente}. Lote={Lote}, intervalo={Intervalo}s, regra={Regra}s.",
            _workerId, environment.EnvironmentName, _options.BatchSize,
            _options.PollInterval.TotalSeconds, _options.SimulatedWorkDuration.TotalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var processor = scope.ServiceProvider.GetRequiredService<PaymentProcessingService>();

                var resultado = await processor.RunOnceAsync(_workerId, stoppingToken);

                if (resultado.Claimed > 0)
                {
                    logger.LogInformation(
                        "Ciclo concluido: {Claimed} reivindicado(s), {Sucesso} sucesso, {Retentativa} retentativa, {Falha} falha.",
                        resultado.Claimed, resultado.Succeeded, resultado.Retried, resultado.Failed);
                }

                // Havendo trabalho, volta ja. Fila vazia, dorme.
                if (!resultado.DidWork)
                {
                    await Task.Delay(_options.PollInterval, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // Uma falha de ciclo (banco fora, por exemplo) nao pode derrubar o
                // worker: o container reiniciaria em laco e a fila pararia de vez.
                // Registra, espera e tenta de novo - os itens continuam na fila.
                logger.LogError(ex, "Falha no ciclo de processamento; nova tentativa em {Intervalo}s.",
                    _options.PollInterval.TotalSeconds);

                await Task.Delay(_options.PollInterval, stoppingToken);
            }
        }

        logger.LogInformation("Worker {WorkerId} encerrado.", _workerId);
    }
}

/// <summary>
/// Limpeza periodica dos pedidos de login vencidos.
/// </summary>
/// <remarks>
/// Pedidos de login sao efemeros: expiram em 15 minutos e o polling os consome
/// ao entrar. O que sobra sao os abandonados - quem pediu o link e nunca clicou.
/// Sem esta varredura, a tabela cresceria para sempre com linhas mortas e
/// degradaria justamente o indice que o polling percorre a cada 2,5s.
///
/// Roda no worker, e nao na API, porque e trabalho de manutencao: nao tem nada a
/// ver com atender requisicoes, e a API deve ficar livre para isso.
/// </remarks>
public sealed class LoginRequestCleanupWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<LoginRequestCleanupWorker> logger) : BackgroundService
{
    private static readonly TimeSpan Intervalo = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Espera um ciclo antes da primeira passada: na subida, a API ainda pode
        // estar aplicando as migrations.
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var auth = scope.ServiceProvider.GetRequiredService<AuthService>();

                var removidos = await auth.PurgeExpiredAsync(stoppingToken);
                if (removidos > 0)
                {
                    logger.LogInformation("{Count} pedido(s) de login vencido(s) removido(s).", removidos);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Falha ao limpar pedidos de login vencidos.");
            }

            await Task.Delay(Intervalo, stoppingToken);
        }
    }
}
