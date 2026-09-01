using FluentValidation;
using Sabemi.Application.Contracts;
using Sabemi.Domain.Enums;

namespace Sabemi.Application.Validation;

/// <summary>
/// Validacao do payload do webhook.
/// </summary>
/// <remarks>
/// Roda depois da desserializacao e antes da persistencia. Reprovar aqui nao
/// descarta o evento: o chamador grava a linha com
/// <see cref="ProcessingStatus.Invalido"/> e as mensagens produzidas aqui, que e
/// o que o dashboard mostra no alerta de erro. Por isso as mensagens sao
/// escritas para um operador ler, nao para um desenvolvedor.
/// </remarks>
public sealed class PaymentWebhookRequestValidator : AbstractValidator<PaymentWebhookRequest>
{
    /// <summary>
    /// Tolerancia para <c>data_pagamento</c> no futuro. Existe para absorver
    /// relogios dessincronizados entre o parceiro e nos; sem ela, alguns
    /// segundos de deriva reprovariam eventos legitimos.
    /// </summary>
    public static readonly TimeSpan ClockSkewTolerance = TimeSpan.FromMinutes(5);

    private static readonly string[] StatusPermitidos = ["PAGO", "PENDENTE", "CANCELADO", "ESTORNADO"];

    public PaymentWebhookRequestValidator(Func<DateTimeOffset> now)
    {
        RuleFor(x => x.IdTransacao)
            .NotEmpty().WithMessage("O campo 'id_transacao' e obrigatorio.")
            .MaximumLength(128).WithMessage("O campo 'id_transacao' excede 128 caracteres.");

        RuleFor(x => x.IdContrato)
            .NotEmpty().WithMessage("O campo 'id_contrato' e obrigatorio.")
            .MaximumLength(128).WithMessage("O campo 'id_contrato' excede 128 caracteres.");

        RuleFor(x => x.Valor)
            .NotNull().WithMessage("O campo 'valor' e obrigatorio.")
            .GreaterThan(0).WithMessage("O campo 'valor' deve ser maior que zero.")
            .LessThanOrEqualTo(9_999_999_999_999.99m).WithMessage("O campo 'valor' excede o limite suportado.");

        // ApplyConditionTo.CurrentValidator e essencial aqui. Sem ele, o `When`
        // final se aplicaria a TODA a cadeia - inclusive ao NotNull -, e um
        // payload sem `data_pagamento` passaria na validacao para so entao
        // estourar no `.Value` durante a ingestao.
        RuleFor(x => x.DataPagamento)
            .NotNull().WithMessage("O campo 'data_pagamento' e obrigatorio.");

        RuleFor(x => x.DataPagamento)
            .Must(d => d!.Value <= now().Add(ClockSkewTolerance))
            .WithMessage("O campo 'data_pagamento' nao pode estar no futuro.")
            .When(x => x.DataPagamento is not null, ApplyConditionTo.CurrentValidator);

        RuleFor(x => x.Status)
            .NotEmpty().WithMessage("O campo 'status' e obrigatorio.");

        RuleFor(x => x.Status)
            .Must(s => StatusPermitidos.Contains(s!.Trim().ToUpperInvariant()))
            .WithMessage($"O campo 'status' deve ser um de: {string.Join(", ", StatusPermitidos)}.")
            .When(x => !string.IsNullOrWhiteSpace(x.Status), ApplyConditionTo.CurrentValidator);
    }

    /// <summary>Converte o <c>status</c> textual do parceiro no enum de dominio.</summary>
    public static PartnerPaymentStatus ParseStatus(string status) => status.Trim().ToUpperInvariant() switch
    {
        "PAGO" => PartnerPaymentStatus.Pago,
        "PENDENTE" => PartnerPaymentStatus.Pendente,
        "CANCELADO" => PartnerPaymentStatus.Cancelado,
        "ESTORNADO" => PartnerPaymentStatus.Estornado,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, "Status nao suportado.")
    };
}
