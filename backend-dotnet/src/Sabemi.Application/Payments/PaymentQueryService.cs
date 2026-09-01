using Microsoft.EntityFrameworkCore;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Contracts;
using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;

namespace Sabemi.Application.Payments;

/// <summary>
/// Consultas do dashboard administrativo (somente leitura).
/// </summary>
/// <remarks>
/// Separado de <see cref="PaymentIngestionService"/> porque as duas metades tem
/// perfis opostos: a ingestao e escrita, transacional e no caminho critico do
/// parceiro; a consulta e leitura, sem rastreamento do EF, e chamada em polling
/// por cada aba aberta do dashboard. Mante-las juntas amarraria uma a outra
/// sem necessidade.
/// </remarks>
public sealed class PaymentQueryService(IAppDbContext db)
{
    /// <summary>
    /// Lista paginada, com os filtros exigidos pela task: situacao e contrato.
    /// </summary>
    /// <remarks>
    /// Os filtros sao compostos no <c>IQueryable</c> e traduzidos em uma unica
    /// consulta SQL - nada e filtrado em memoria. A ordenacao por
    /// <c>RecebidoEm</c> descendente e desempatada por <c>Id</c> (UUID v7, que e
    /// monotonico no tempo) para a paginacao ser estavel quando dois eventos
    /// chegam no mesmo instante.
    /// </remarks>
    public async Task<PagedResult<PaymentEventDto>> ListAsync(PaymentQuery query, CancellationToken ct = default)
    {
        var q = db.PaymentEvents.AsNoTracking().AsQueryable();

        if (query.Status is { } status)
        {
            q = q.Where(e => e.StatusProcessamento == status);
        }

        if (!string.IsNullOrWhiteSpace(query.ContractId))
        {
            q = q.Where(e => e.IdContrato == query.ContractId);
        }

        var total = await q.CountAsync(ct);

        var items = await q
            .OrderByDescending(e => e.RecebidoEm)
            .ThenByDescending(e => e.Id)
            .Skip((query.Page - 1) * query.PageSize)
            .Take(query.PageSize)
            .Select(e => Map(e))
            .ToListAsync(ct);

        return new PagedResult<PaymentEventDto>
        {
            Items = items,
            Page = query.Page,
            PageSize = query.PageSize,
            Total = total
        };
    }

    /// <summary>Detalhe de um evento, incluindo o corpo cru recebido.</summary>
    public async Task<PaymentEventDetailDto?> GetByTransactionIdAsync(string idTransacao, CancellationToken ct = default)
    {
        var e = await db.PaymentEvents.AsNoTracking()
            .FirstOrDefaultAsync(x => x.IdTransacao == idTransacao, ct);

        if (e is null) return null;

        return new PaymentEventDetailDto
        {
            Id = e.Id,
            IdTransacao = e.IdTransacao,
            IdContrato = e.IdContrato,
            Valor = e.Valor,
            DataPagamento = e.DataPagamento,
            StatusOrigem = e.StatusOrigem,
            StatusProcessamento = e.StatusProcessamento.ToString().ToUpperInvariant(),
            Erro = e.Erro,
            RecebidoEm = e.RecebidoEm,
            ProcessadoEm = e.ProcessadoEm,
            Tentativas = e.Tentativas,
            PayloadBruto = e.PayloadBruto
        };
    }

    public async Task<ContractStatusDto?> GetContractAsync(string idContrato, CancellationToken ct = default)
    {
        var c = await db.ContractStatuses.AsNoTracking()
            .FirstOrDefaultAsync(x => x.IdContrato == idContrato, ct);

        if (c is null) return null;

        return new ContractStatusDto
        {
            IdContrato = c.IdContrato,
            ValorTotalLiquidado = c.ValorTotalLiquidado,
            PagamentosConfirmados = c.PagamentosConfirmados,
            UltimoPagamentoEm = c.UltimoPagamentoEm,
            UltimaTransacao = c.UltimaTransacao,
            Situacao = c.Situacao.ToString().ToUpperInvariant(),
            AtualizadoEm = c.AtualizadoEm
        };
    }

    /// <summary>
    /// Contadores dos cartoes do dashboard.
    /// </summary>
    /// <remarks>
    /// Agrega no banco (<c>GROUP BY</c>) e depois preenche com zero as situacoes
    /// sem ocorrencia, para o contrato sempre trazer o conjunto completo de
    /// chaves. Assim o frontend renderiza os cartoes sem tratar chave ausente.
    /// </remarks>
    public async Task<PaymentSummaryDto> GetSummaryAsync(CancellationToken ct = default)
    {
        var agrupado = await db.PaymentEvents.AsNoTracking()
            .GroupBy(e => e.StatusProcessamento)
            .Select(g => new { Status = g.Key, Count = g.Count() })
            .ToListAsync(ct);

        var porStatus = Enum.GetValues<ProcessingStatus>()
            .ToDictionary(
                s => s.ToString().ToUpperInvariant(),
                s => agrupado.FirstOrDefault(a => a.Status == s)?.Count ?? 0);

        return new PaymentSummaryDto
        {
            Total = agrupado.Sum(a => a.Count),
            PorStatus = porStatus
        };
    }

    private static PaymentEventDto Map(PaymentEvent e) => new()
    {
        Id = e.Id,
        IdTransacao = e.IdTransacao,
        IdContrato = e.IdContrato,
        Valor = e.Valor,
        DataPagamento = e.DataPagamento,
        StatusOrigem = e.StatusOrigem,
        StatusProcessamento = e.StatusProcessamento.ToString().ToUpperInvariant(),
        Erro = e.Erro,
        RecebidoEm = e.RecebidoEm,
        ProcessadoEm = e.ProcessadoEm,
        Tentativas = e.Tentativas
    };
}
