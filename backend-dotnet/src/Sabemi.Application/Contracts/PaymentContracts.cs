using System.Text.Json.Serialization;
using Sabemi.Domain.Enums;

namespace Sabemi.Application.Contracts;

/// <summary>
/// Payload do webhook, exatamente como o banco parceiro envia.
/// </summary>
/// <remarks>
/// Os nomes em <c>snake_case</c> vem do contrato do parceiro e sao fixados aqui
/// com <see cref="JsonPropertyNameAttribute"/> em vez de uma politica global de
/// serializacao: o resto da API usa o mesmo estilo por escolha nossa, mas este
/// tipo especifico e uma obrigacao externa e precisa ficar imune a qualquer
/// mudanca futura na convencao interna.
///
/// Todos os campos sao anulaveis de proposito. "Ausente" e um erro de validacao
/// que precisa ser reportado com uma mensagem util e persistido para auditoria -
/// nao um <c>400</c> generico do model binder, que perderia o payload bruto.
/// </remarks>
public sealed record PaymentWebhookRequest
{
    [JsonPropertyName("id_transacao")]
    public string? IdTransacao { get; init; }

    [JsonPropertyName("id_contrato")]
    public string? IdContrato { get; init; }

    [JsonPropertyName("valor")]
    public decimal? Valor { get; init; }

    [JsonPropertyName("data_pagamento")]
    public DateTimeOffset? DataPagamento { get; init; }

    [JsonPropertyName("status")]
    public string? Status { get; init; }
}

/// <summary>Resposta do webhook. Curta de proposito: o parceiro so precisa do "recebi".</summary>
public sealed record WebhookAck
{
    [JsonPropertyName("id_transacao")]
    public required string IdTransacao { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    /// <summary>true quando o <c>id_transacao</c> ja existia - nada foi reprocessado.</summary>
    [JsonPropertyName("duplicate")]
    public required bool Duplicate { get; init; }

    [JsonPropertyName("received_at")]
    public required DateTimeOffset ReceivedAt { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }
}

/// <summary>Linha da tabela do dashboard.</summary>
/// <remarks>
/// Nao e <c>sealed</c> porque <see cref="PaymentEventDetailDto"/> a estende com
/// o payload bruto - o detalhe e a linha da lista mais um campo, e herdar
/// mantem os dois em sincronia automaticamente.
/// </remarks>
public record PaymentEventDto
{
    [JsonPropertyName("id")]
    public required Guid Id { get; init; }

    [JsonPropertyName("id_transacao")]
    public required string IdTransacao { get; init; }

    [JsonPropertyName("id_contrato")]
    public string? IdContrato { get; init; }

    [JsonPropertyName("valor")]
    public decimal? Valor { get; init; }

    [JsonPropertyName("data_pagamento")]
    public DateTimeOffset? DataPagamento { get; init; }

    [JsonPropertyName("status_origem")]
    public string? StatusOrigem { get; init; }

    [JsonPropertyName("status_processamento")]
    public required string StatusProcessamento { get; init; }

    [JsonPropertyName("erro")]
    public string? Erro { get; init; }

    [JsonPropertyName("recebido_em")]
    public required DateTimeOffset RecebidoEm { get; init; }

    [JsonPropertyName("processado_em")]
    public DateTimeOffset? ProcessadoEm { get; init; }

    [JsonPropertyName("tentativas")]
    public required int Tentativas { get; init; }
}

/// <summary>Detalhe de um evento: a linha do dashboard mais o corpo cru recebido.</summary>
public sealed record PaymentEventDetailDto : PaymentEventDto
{
    [JsonPropertyName("payload_bruto")]
    public required string PayloadBruto { get; init; }
}

/// <summary>Pagina de eventos. Paginacao por offset - simples e igual nos dois backends.</summary>
public sealed record PagedResult<T>
{
    [JsonPropertyName("items")]
    public required IReadOnlyList<T> Items { get; init; }

    [JsonPropertyName("page")]
    public required int Page { get; init; }

    [JsonPropertyName("page_size")]
    public required int PageSize { get; init; }

    [JsonPropertyName("total")]
    public required int Total { get; init; }
}

/// <summary>Filtros do dashboard, ja normalizados.</summary>
/// <param name="Status">Situacao do processamento; <c>null</c> = todas.</param>
/// <param name="ContractId">Filtro exato por <c>id_contrato</c>; <c>null</c> = todos.</param>
public sealed record PaymentQuery(
    ProcessingStatus? Status,
    string? ContractId,
    int Page,
    int PageSize)
{
    public const int MaxPageSize = 100;
    public const int DefaultPageSize = 20;

    /// <summary>
    /// Constroi a consulta a partir da query string, saneando os limites. Valores
    /// fora de faixa sao corrigidos em vez de rejeitados: um <c>pageSize=5000</c>
    /// vira 100 (o teto) e nao um 400 na cara do operador.
    /// </summary>
    public static PaymentQuery From(string? status, string? contractId, int? page, int? pageSize)
    {
        ProcessingStatus? parsed = null;
        if (!string.IsNullOrWhiteSpace(status)
            && Enum.TryParse<ProcessingStatus>(status, ignoreCase: true, out var s))
        {
            parsed = s;
        }

        var contrato = string.IsNullOrWhiteSpace(contractId) ? null : contractId.Trim();

        return new PaymentQuery(
            parsed,
            contrato,
            Math.Max(1, page ?? 1),
            Math.Clamp(pageSize ?? DefaultPageSize, 1, MaxPageSize));
    }
}

/// <summary>Estado consolidado de um contrato.</summary>
public sealed record ContractStatusDto
{
    [JsonPropertyName("id_contrato")]
    public required string IdContrato { get; init; }

    [JsonPropertyName("valor_total_liquidado")]
    public required decimal ValorTotalLiquidado { get; init; }

    [JsonPropertyName("pagamentos_confirmados")]
    public required int PagamentosConfirmados { get; init; }

    [JsonPropertyName("ultimo_pagamento_em")]
    public DateTimeOffset? UltimoPagamentoEm { get; init; }

    [JsonPropertyName("ultima_transacao")]
    public string? UltimaTransacao { get; init; }

    [JsonPropertyName("situacao")]
    public required string Situacao { get; init; }

    [JsonPropertyName("atualizado_em")]
    public required DateTimeOffset AtualizadoEm { get; init; }
}

/// <summary>Contadores dos cartoes do topo do dashboard.</summary>
public sealed record PaymentSummaryDto
{
    [JsonPropertyName("total")]
    public required int Total { get; init; }

    /// <summary>
    /// Contagem por situacao. Sempre traz TODAS as chaves de
    /// <see cref="ProcessingStatus"/>, inclusive as zeradas, para o dashboard nao
    /// precisar tratar chave ausente.
    /// </summary>
    [JsonPropertyName("por_status")]
    public required IReadOnlyDictionary<string, int> PorStatus { get; init; }
}
