using Sabemi.Application.Contracts;
using Sabemi.Application.Validation;
using Sabemi.Domain.Enums;
using Shouldly;

namespace Sabemi.UnitTests.Application;

/// <summary>
/// Validacao do payload do webhook.
/// </summary>
/// <remarks>
/// Cada regra vira uma linha de erro no dashboard, entao os testes conferem
/// tambem a MENSAGEM - nao so a reprovacao. Uma mensagem generica ("payload
/// invalido") obrigaria o operador a abrir o payload bruto para descobrir o que
/// esta errado.
/// </remarks>
public class ValidationTests
{
    private static readonly DateTimeOffset Agora = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    private static PaymentWebhookRequestValidator Validador() => new(() => Agora);

    private static PaymentWebhookRequest Valido() => new()
    {
        IdTransacao = "TRX-001",
        IdContrato = "CTR-001",
        Valor = 100.50m,
        DataPagamento = Agora.AddHours(-2),
        Status = "PAGO",
    };

    [Fact]
    public void Payload_completo_e_aprovado()
    {
        var resultado = Validador().Validate(Valido());

        resultado.IsValid.ShouldBeTrue();
    }

    [Theory]
    [InlineData("PAGO")]
    [InlineData("PENDENTE")]
    [InlineData("CANCELADO")]
    [InlineData("ESTORNADO")]
    [InlineData("pago")]      // minusculas
    [InlineData("  PAGO  ")]  // com espacos
    public void Status_aceitos_pelo_contrato(string status)
    {
        var resultado = Validador().Validate(Valido() with { Status = status });

        resultado.IsValid.ShouldBeTrue();
    }

    [Theory]
    [InlineData("APROVADO")]
    [InlineData("PAID")]
    [InlineData("xpto")]
    public void Status_fora_do_contrato_e_reprovado(string status)
    {
        var resultado = Validador().Validate(Valido() with { Status = status });

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.ShouldContain(e => e.ErrorMessage.Contains("'status' deve ser um de"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void IdTransacao_e_obrigatorio(string? id)
    {
        var resultado = Validador().Validate(Valido() with { IdTransacao = id });

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.ShouldContain(e => e.ErrorMessage.Contains("'id_transacao' e obrigatorio"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void IdContrato_e_obrigatorio(string? id)
    {
        var resultado = Validador().Validate(Valido() with { IdContrato = id });

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.ShouldContain(e => e.ErrorMessage.Contains("'id_contrato' e obrigatorio"));
    }

    [Fact]
    public void IdTransacao_acima_de_128_caracteres_e_reprovado()
    {
        // O limite espelha a coluna: aceitar aqui produziria uma falha de banco.
        var resultado = Validador().Validate(Valido() with { IdTransacao = new string('a', 129) });

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.ShouldContain(e => e.ErrorMessage.Contains("excede 128"));
    }

    [Fact]
    public void Valor_e_obrigatorio()
    {
        var resultado = Validador().Validate(Valido() with { Valor = null });

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.ShouldContain(e => e.ErrorMessage.Contains("'valor' e obrigatorio"));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(-0.01)]
    public void Valor_precisa_ser_positivo(decimal valor)
    {
        var resultado = Validador().Validate(Valido() with { Valor = valor });

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.ShouldContain(e => e.ErrorMessage.Contains("maior que zero"));
    }

    [Fact]
    public void DataPagamento_e_obrigatoria()
    {
        var resultado = Validador().Validate(Valido() with { DataPagamento = null });

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.ShouldContain(e => e.ErrorMessage.Contains("'data_pagamento' e obrigatorio"));
    }

    [Fact]
    public void DataPagamento_no_futuro_e_reprovada()
    {
        var resultado = Validador().Validate(Valido() with { DataPagamento = Agora.AddDays(1) });

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.ShouldContain(e => e.ErrorMessage.Contains("nao pode estar no futuro"));
    }

    [Fact]
    public void Pequena_deriva_de_relogio_e_tolerada()
    {
        // Sem essa folga, alguns segundos de dessincronia entre o parceiro e nos
        // reprovariam eventos perfeitamente legitimos.
        var dentroDaTolerancia = Agora.Add(PaymentWebhookRequestValidator.ClockSkewTolerance)
            .AddSeconds(-1);

        var resultado = Validador().Validate(Valido() with { DataPagamento = dentroDaTolerancia });

        resultado.IsValid.ShouldBeTrue();
    }

    [Fact]
    public void Deriva_alem_da_tolerancia_e_reprovada()
    {
        var foraDaTolerancia = Agora.Add(PaymentWebhookRequestValidator.ClockSkewTolerance)
            .AddMinutes(1);

        var resultado = Validador().Validate(Valido() with { DataPagamento = foraDaTolerancia });

        resultado.IsValid.ShouldBeFalse();
    }

    [Fact]
    public void Payload_vazio_reporta_TODOS_os_campos_faltantes()
    {
        // Reportar um erro por vez obrigaria o parceiro a varias rodadas de
        // tentativa para descobrir tudo o que falta.
        var resultado = Validador().Validate(new PaymentWebhookRequest());

        resultado.IsValid.ShouldBeFalse();
        resultado.Errors.Select(e => e.PropertyName).Distinct().Count().ShouldBe(5);
    }

    [Theory]
    [InlineData("PAGO", PartnerPaymentStatus.Pago)]
    [InlineData("pendente", PartnerPaymentStatus.Pendente)]
    [InlineData(" Cancelado ", PartnerPaymentStatus.Cancelado)]
    [InlineData("ESTORNADO", PartnerPaymentStatus.Estornado)]
    public void ParseStatus_normaliza_caixa_e_espacos(string entrada, PartnerPaymentStatus esperado)
    {
        PaymentWebhookRequestValidator.ParseStatus(entrada).ShouldBe(esperado);
    }

    [Fact]
    public void ParseStatus_recusa_valor_desconhecido()
    {
        Should.Throw<ArgumentOutOfRangeException>(
            () => PaymentWebhookRequestValidator.ParseStatus("INVENTADO"));
    }
}

/// <summary>
/// Saneamento dos parametros de consulta do dashboard.
/// </summary>
/// <remarks>
/// A decisao testada aqui e de produto: parametro estranho na URL degrada para
/// um resultado util em vez de virar erro. Numa tela de consulta, um `400` por
/// causa de um `pageSize` digitado errado atrapalha mais do que ajuda.
/// </remarks>
public class PaymentQueryTests
{
    [Fact]
    public void Sem_parametros_usa_os_padroes()
    {
        var query = PaymentQuery.From(null, null, null, null);

        query.Status.ShouldBeNull();
        query.ContractId.ShouldBeNull();
        query.Page.ShouldBe(1);
        query.PageSize.ShouldBe(PaymentQuery.DefaultPageSize);
    }

    [Theory]
    [InlineData("SUCESSO", ProcessingStatus.Sucesso)]
    [InlineData("sucesso", ProcessingStatus.Sucesso)]
    [InlineData("ERRO", ProcessingStatus.Erro)]
    [InlineData("Invalido", ProcessingStatus.Invalido)]
    public void Status_e_interpretado_sem_diferenciar_caixa(string entrada, ProcessingStatus esperado)
    {
        PaymentQuery.From(entrada, null, null, null).Status.ShouldBe(esperado);
    }

    [Fact]
    public void Status_desconhecido_vira_sem_filtro()
    {
        PaymentQuery.From("BANANA", null, null, null).Status.ShouldBeNull();
    }

    [Fact]
    public void PageSize_acima_do_teto_e_ajustado()
    {
        // Protege o banco: sem o teto, `pageSize=100000` viraria uma consulta que
        // varre a tabela inteira a cada 5 segundos de polling.
        PaymentQuery.From(null, null, null, 5000).PageSize.ShouldBe(PaymentQuery.MaxPageSize);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-10)]
    public void PageSize_nao_positivo_vira_um(int pageSize)
    {
        PaymentQuery.From(null, null, null, pageSize).PageSize.ShouldBe(1);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    public void Pagina_nao_positiva_vira_a_primeira(int page)
    {
        PaymentQuery.From(null, null, page, null).Page.ShouldBe(1);
    }

    [Fact]
    public void Contrato_em_branco_vira_sem_filtro()
    {
        PaymentQuery.From(null, "   ", null, null).ContractId.ShouldBeNull();
    }

    [Fact]
    public void Contrato_tem_espacos_removidos()
    {
        // Copiar e colar um id costuma trazer espacos junto; sem o trim, o filtro
        // simplesmente nao encontraria nada.
        PaymentQuery.From(null, "  CTR-1 ", null, null).ContractId.ShouldBe("CTR-1");
    }
}
