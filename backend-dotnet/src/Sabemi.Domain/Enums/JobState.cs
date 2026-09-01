namespace Sabemi.Domain.Enums;

/// <summary>Estado de um item na fila durable de processamento.</summary>
public enum JobState
{
    /// <summary>Aguardando ser reivindicado por um worker.</summary>
    Pendente,

    /// <summary>Reivindicado; um worker esta executando a regra de negocio.</summary>
    Processando,

    /// <summary>Executado com sucesso.</summary>
    Concluido,

    /// <summary>Esgotou <c>MaxTentativas</c>; foi para a dead-letter logica.</summary>
    Falhou
}

/// <summary>Situacao consolidada de um contrato apos os pagamentos liquidados.</summary>
public enum ContractSituation
{
    /// <summary>Recebeu pagamentos, ainda em curso.</summary>
    Ativo,

    /// <summary>Ultimo evento liquidou o contrato.</summary>
    Liquidado,

    /// <summary>Ultimo evento foi cancelado ou estornado.</summary>
    Inadimplente
}

/// <summary>Situacao informada pelo banco parceiro no campo <c>status</c>.</summary>
public enum PartnerPaymentStatus
{
    Pago,
    Pendente,
    Cancelado,
    Estornado
}
