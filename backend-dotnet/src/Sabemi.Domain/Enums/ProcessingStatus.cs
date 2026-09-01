namespace Sabemi.Domain.Enums;

/// <summary>
/// Ciclo de vida de uma notificacao de pagamento, do recebimento ao desfecho.
/// </summary>
/// <remarks>
/// A task pede apenas "Sucesso" e "Erro" nos filtros do dashboard. Os demais
/// estados existem porque o processamento e assincrono: sem eles o operador nao
/// consegue distinguir "ainda nao processou" de "processou e deu errado", que
/// exigem acoes completamente diferentes.
///
/// Persistido como <c>string</c> (ver <c>PaymentEventConfiguration</c>): o valor
/// aparece legivel no banco e a ordem dos membros deixa de ser parte do
/// contrato de dados.
/// </remarks>
public enum ProcessingStatus
{
    /// <summary>Persistido e enfileirado; nenhum worker o reivindicou ainda.</summary>
    Pendente,

    /// <summary>Reivindicado por um worker, regra de negocio em execucao.</summary>
    Processando,

    /// <summary>Regra de negocio concluida e estado do contrato atualizado.</summary>
    Sucesso,

    /// <summary>Falhou apos esgotar as tentativas com backoff.</summary>
    Erro,

    /// <summary>
    /// Reprovado na validacao de payload. Nunca chegou a ser enfileirado, mas e
    /// persistido assim mesmo para ficar auditavel no dashboard.
    /// </summary>
    Invalido,

    /// <summary>
    /// Reentrega de um <c>id_transacao</c> ja conhecido. Registrado apenas na
    /// resposta ao banco parceiro; nao gera uma segunda linha no log.
    /// </summary>
    Duplicado
}
