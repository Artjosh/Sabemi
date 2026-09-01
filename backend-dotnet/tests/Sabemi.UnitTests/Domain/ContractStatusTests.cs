using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;
using Shouldly;

namespace Sabemi.UnitTests.Domain;

/// <summary>
/// Regras de consolidacao do contrato.
/// </summary>
/// <remarks>
/// E aqui que o dinheiro e somado, entao os testes cobrem cada situacao vinda do
/// parceiro. O erro que se quer impedir e o mais caro possivel: somar ao total
/// um pagamento que foi cancelado.
/// </remarks>
public class ContractStatusTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Contrato_novo_comeca_zerado_e_ativo()
    {
        var contrato = ContractStatus.Create("CTR-1");

        contrato.IdContrato.ShouldBe("CTR-1");
        contrato.ValorTotalLiquidado.ShouldBe(0m);
        contrato.PagamentosConfirmados.ShouldBe(0);
        contrato.Situacao.ShouldBe(ContractSituation.Ativo);
    }

    [Fact]
    public void Pagamento_PAGO_soma_ao_total_e_liquida()
    {
        var contrato = ContractStatus.Create("CTR-1");

        contrato.Apply(PartnerPaymentStatus.Pago, 150.50m, T0, "TRX-1", T0);

        contrato.ValorTotalLiquidado.ShouldBe(150.50m);
        contrato.PagamentosConfirmados.ShouldBe(1);
        contrato.UltimoPagamentoEm.ShouldBe(T0);
        contrato.UltimaTransacao.ShouldBe("TRX-1");
        contrato.Situacao.ShouldBe(ContractSituation.Liquidado);
    }

    [Fact]
    public void Pagamentos_sucessivos_acumulam()
    {
        var contrato = ContractStatus.Create("CTR-1");

        contrato.Apply(PartnerPaymentStatus.Pago, 100m, T0, "TRX-1", T0);
        contrato.Apply(PartnerPaymentStatus.Pago, 250.25m, T0.AddDays(1), "TRX-2", T0.AddDays(1));

        contrato.ValorTotalLiquidado.ShouldBe(350.25m);
        contrato.PagamentosConfirmados.ShouldBe(2);
        contrato.UltimaTransacao.ShouldBe("TRX-2");
    }

    [Theory]
    [InlineData(PartnerPaymentStatus.Cancelado)]
    [InlineData(PartnerPaymentStatus.Estornado)]
    public void Cancelado_e_estornado_marcam_inadimplencia_sem_somar(PartnerPaymentStatus status)
    {
        var contrato = ContractStatus.Create("CTR-1");
        contrato.Apply(PartnerPaymentStatus.Pago, 100m, T0, "TRX-1", T0);

        contrato.Apply(status, 999m, T0.AddDays(1), "TRX-2", T0.AddDays(1));

        // O ponto do teste: o valor cancelado NAO entra no total liquidado.
        contrato.ValorTotalLiquidado.ShouldBe(100m);
        contrato.PagamentosConfirmados.ShouldBe(1);
        contrato.Situacao.ShouldBe(ContractSituation.Inadimplente);
        // Ainda assim a transacao fica registrada como a ultima aplicada, para a
        // trilha de auditoria nao ter buracos.
        contrato.UltimaTransacao.ShouldBe("TRX-2");
    }

    [Fact]
    public void Status_PENDENTE_apenas_registra_o_toque()
    {
        var contrato = ContractStatus.Create("CTR-1");

        contrato.Apply(PartnerPaymentStatus.Pendente, 80m, T0, "TRX-1", T0);

        contrato.ValorTotalLiquidado.ShouldBe(0m);
        contrato.PagamentosConfirmados.ShouldBe(0);
        contrato.Situacao.ShouldBe(ContractSituation.Ativo);
        contrato.UltimaTransacao.ShouldBe("TRX-1");
    }

    [Fact]
    public void Contrato_inadimplente_volta_a_liquidado_com_novo_pagamento()
    {
        var contrato = ContractStatus.Create("CTR-1");
        contrato.Apply(PartnerPaymentStatus.Estornado, 100m, T0, "TRX-1", T0);

        contrato.Apply(PartnerPaymentStatus.Pago, 100m, T0.AddDays(1), "TRX-2", T0.AddDays(1));

        contrato.Situacao.ShouldBe(ContractSituation.Liquidado);
        contrato.ValorTotalLiquidado.ShouldBe(100m);
    }

    [Fact]
    public void AtualizadoEm_avanca_a_cada_aplicacao()
    {
        var contrato = ContractStatus.Create("CTR-1");
        var depois = T0.AddHours(5);

        contrato.Apply(PartnerPaymentStatus.Pago, 10m, T0, "TRX-1", depois);

        contrato.AtualizadoEm.ShouldBe(depois);
    }
}
