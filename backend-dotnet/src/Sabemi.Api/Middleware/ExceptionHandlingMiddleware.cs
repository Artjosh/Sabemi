using System.Text.Json;
using Sabemi.Application.Contracts;

namespace Sabemi.Api.Middleware;

/// <summary>
/// Converte excecoes nao tratadas no <c>ProblemDetails</c> do contrato.
/// </summary>
/// <remarks>
/// <para>Duas responsabilidades. A primeira e nao vazar detalhes internos: em
/// producao, o cliente recebe uma mensagem generica com um identificador de
/// correlacao, enquanto a excecao completa vai para o log. Devolver
/// <c>ex.ToString()</c> entregaria caminhos de arquivo, nomes de tabela e,
/// eventualmente, a string de conexao.</para>
///
/// <para>A segunda e manter a uniformidade prometida no contrato: o frontend le
/// <c>detail</c> em toda falha, venha ela de uma validacao, de um 404 ou de uma
/// excecao inesperada. Sem isto, um erro nao tratado devolveria HTML e a tela
/// mostraria uma mensagem sem sentido.</para>
/// </remarks>
public sealed class ExceptionHandlingMiddleware(
    RequestDelegate next,
    ILogger<ExceptionHandlingMiddleware> logger,
    IHostEnvironment environment)
{
    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await next(context);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            // O cliente desistiu (fechou a aba, timeout). Nao e um erro do
            // servidor e nao deve poluir o log de erros.
            logger.LogDebug("Requisicao {Path} cancelada pelo cliente.", context.Request.Path);
        }
        catch (Exception ex)
        {
            var correlationId = context.TraceIdentifier;

            logger.LogError(ex,
                "Excecao nao tratada em {Method} {Path}. Correlacao: {CorrelationId}",
                context.Request.Method, context.Request.Path, correlationId);

            if (context.Response.HasStarted)
            {
                // A resposta ja comecou a ser escrita; sobrescrever o status
                // agora lancaria outra excecao e mascararia a original.
                logger.LogWarning("Resposta ja iniciada; nao foi possivel formatar o erro.");
                return;
            }

            context.Response.Clear();
            context.Response.StatusCode = StatusCodes.Status500InternalServerError;
            context.Response.ContentType = "application/json";

            var detail = environment.IsProduction()
                ? $"Erro interno. Informe a correlacao {correlationId} ao suporte."
                : ex.Message;

            await context.Response.WriteAsync(JsonSerializer.Serialize(
                ProblemDetailsDto.Of(detail, "internal_error")));
        }
    }
}
