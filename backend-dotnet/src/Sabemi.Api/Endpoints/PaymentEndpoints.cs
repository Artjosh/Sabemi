using Sabemi.Application.Contracts;
using Sabemi.Application.Payments;

namespace Sabemi.Api.Endpoints;

/// <summary>
/// Consultas do dashboard administrativo.
/// </summary>
/// <remarks>
/// Todo este grupo exige sessao. O webhook nao - ele tem o proprio esquema de
/// autenticacao (ApiKey/HMAC), porque quem chama la e um sistema parceiro e nao
/// um operador logado.
/// </remarks>
public static class PaymentEndpoints
{
    public static IEndpointRouteBuilder MapPaymentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/payments")
            .WithTags("payments")
            .RequireAuthorization();

        group.MapGet("/", ListarPagamentos)
            .WithSummary("Lista os eventos recebidos, com filtros de situacao e contrato")
            .Produces<PagedResult<PaymentEventDto>>();

        group.MapGet("/summary", ObterResumo)
            .WithSummary("Contadores por situacao")
            .Produces<PaymentSummaryDto>();

        group.MapGet("/{transactionId}", ObterPagamento)
            .WithSummary("Detalhe de um evento, com o payload bruto")
            .Produces<PaymentEventDetailDto>()
            .Produces<ProblemDetailsDto>(StatusCodes.Status404NotFound);

        app.MapGet("/contracts/{contractId}", ObterContrato)
            .WithTags("payments")
            .RequireAuthorization()
            .WithSummary("Estado consolidado de um contrato")
            .Produces<ContractStatusDto>()
            .Produces<ProblemDetailsDto>(StatusCodes.Status404NotFound);

        return app;
    }

    /// <summary>
    /// Lista paginada com os filtros do dashboard.
    /// </summary>
    /// <remarks>
    /// Os parametros sao saneados em <see cref="PaymentQuery.From"/>: um
    /// <c>status</c> desconhecido e ignorado (lista tudo) em vez de virar 400, e
    /// <c>pageSize</c> fora de faixa e ajustado ao teto. Para uma tela de
    /// consulta, degradar para um resultado util e melhor do que devolver erro
    /// por causa de um parametro de URL digitado errado.
    /// </remarks>
    private static async Task<IResult> ListarPagamentos(
        string? status,
        string? contractId,
        int? page,
        int? pageSize,
        PaymentQueryService queries,
        CancellationToken ct)
    {
        var query = PaymentQuery.From(status, contractId, page, pageSize);
        return Results.Ok(await queries.ListAsync(query, ct));
    }

    private static async Task<IResult> ObterResumo(PaymentQueryService queries, CancellationToken ct)
        => Results.Ok(await queries.GetSummaryAsync(ct));

    private static async Task<IResult> ObterPagamento(
        string transactionId, PaymentQueryService queries, CancellationToken ct)
    {
        var evento = await queries.GetByTransactionIdAsync(transactionId, ct);

        return evento is null
            ? Results.Json(
                ProblemDetailsDto.Of("Evento nao encontrado.", "payment_event_not_found"),
                statusCode: StatusCodes.Status404NotFound)
            : Results.Ok(evento);
    }

    private static async Task<IResult> ObterContrato(
        string contractId, PaymentQueryService queries, CancellationToken ct)
    {
        var contrato = await queries.GetContractAsync(contractId, ct);

        return contrato is null
            ? Results.Json(
                ProblemDetailsDto.Of("Contrato nao encontrado.", "contract_not_found"),
                statusCode: StatusCodes.Status404NotFound)
            : Results.Ok(contrato);
    }
}
