using Sabemi.Domain.Enums;

namespace Sabemi.Domain.Entities;

/// <summary>
/// Estado consolidado de um contrato - a segunda tabela exigida pela task.
/// </summary>
/// <remarks>
/// Enquanto <see cref="PaymentEvent"/> e um log imutavel (append-only), esta
/// entidade e mutavel e representa "onde o contrato esta agora". O worker a
/// atualiza dentro da mesma transacao em que conclui o job, entao o par
/// "evento processado / contrato atualizado" nunca fica pela metade.
///
/// A chave primaria e o proprio <see cref="IdContrato"/>: nao ha razao para uma
/// chave sintetica quando o identificador de negocio ja e unico e estavel, e
/// isso torna o upsert do worker trivial.
/// </remarks>
public class ContractStatus
{
    public string IdContrato { get; private set; } = string.Empty;

    /// <summary>Soma dos pagamentos efetivamente liquidados (status PAGO).</summary>
    public decimal ValorTotalLiquidado { get; private set; }

    public int PagamentosConfirmados { get; private set; }

    public DateTimeOffset? UltimoPagamentoEm { get; private set; }

    /// <summary>Ultima transacao aplicada - facilita rastrear do contrato ao evento.</summary>
    public string? UltimaTransacao { get; private set; }

    public ContractSituation Situacao { get; private set; } = ContractSituation.Ativo;

    public DateTimeOffset AtualizadoEm { get; private set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// Token de concorrencia otimista mapeado para o <c>xmin</c> do PostgreSQL.
    /// Dois workers que tentem atualizar o mesmo contrato ao mesmo tempo: o
    /// segundo leva <c>DbUpdateConcurrencyException</c> e o job volta para a
    /// fila, em vez de sobrescrever silenciosamente o total do primeiro.
    /// </summary>
    public uint Version { get; private set; }

    private ContractStatus() { }

    public static ContractStatus Create(string idContrato) => new() { IdContrato = idContrato };

    /// <summary>
    /// Aplica um pagamento liquidado ao contrato.
    /// </summary>
    /// <remarks>
    /// So <c>PAGO</c> soma ao total. <c>CANCELADO</c> e <c>ESTORNADO</c> marcam o
    /// contrato como inadimplente sem mexer no acumulado, e <c>PENDENTE</c>
    /// apenas registra o toque. A idempotencia desta soma e garantida um nivel
    /// acima: o job so roda uma vez por <c>id_transacao</c>.
    /// </remarks>
    public void Apply(PartnerPaymentStatus statusOrigem, decimal valor, DateTimeOffset dataPagamento, string idTransacao, DateTimeOffset agora)
    {
        switch (statusOrigem)
        {
            case PartnerPaymentStatus.Pago:
                ValorTotalLiquidado += valor;
                PagamentosConfirmados += 1;
                UltimoPagamentoEm = dataPagamento;
                Situacao = ContractSituation.Liquidado;
                break;

            case PartnerPaymentStatus.Cancelado:
            case PartnerPaymentStatus.Estornado:
                Situacao = ContractSituation.Inadimplente;
                break;

            case PartnerPaymentStatus.Pendente:
                Situacao = ContractSituation.Ativo;
                break;
        }

        UltimaTransacao = idTransacao;
        AtualizadoEm = agora;
    }
}
