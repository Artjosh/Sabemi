using Sabemi.Domain.Enums;

namespace Sabemi.Domain.Entities;

/// <summary>
/// Log de eventos brutos: uma linha por notificacao recebida no webhook.
/// </summary>
/// <remarks>
/// Esta e a tabela de auditoria exigida pela task. Duas decisoes moldam o
/// desenho:
///
/// 1. <see cref="IdTransacao"/> tem indice UNICO no banco. A idempotencia nao
///    depende de consulta previa nem de cache em memoria - depende da restricao
///    de unicidade. Duas instancias da API recebendo a mesma reentrega em
///    paralelo: uma insere, a outra leva violacao de unicidade e responde
///    "duplicado". Ver <c>PaymentIngestionService</c>.
///
/// 2. Um payload que falha na validacao tambem vira uma linha aqui, com
///    <see cref="StatusProcessamento"/> = <see cref="ProcessingStatus.Invalido"/>
///    e o motivo em <see cref="Erro"/>. Descartar o evento invalido tornaria a
///    falha invisivel justamente quando ela mais precisa ser vista.
///
/// Os campos de negocio sao anulaveis de proposito: um payload invalido pode nao
/// trazer contrato ou valor, e ainda assim precisa ser gravado.
/// </remarks>
public class PaymentEvent
{
    public Guid Id { get; private set; } = Guid.CreateVersion7();

    /// <summary>Chave de idempotencia vinda do banco parceiro. Unica na tabela.</summary>
    public string IdTransacao { get; private set; } = string.Empty;

    public string? IdContrato { get; private set; }

    public decimal? Valor { get; private set; }

    public DateTimeOffset? DataPagamento { get; private set; }

    /// <summary>Valor cru do campo <c>status</c> enviado pelo parceiro.</summary>
    public string? StatusOrigem { get; private set; }

    public ProcessingStatus StatusProcessamento { get; private set; } = ProcessingStatus.Pendente;

    /// <summary>Motivo da reprovacao na validacao ou da falha no processamento.</summary>
    public string? Erro { get; private set; }

    /// <summary>
    /// Corpo exatamente como chegou, antes de qualquer desserializacao. E o que
    /// permite reprocessar ou periciar um evento depois que a regra mudou.
    /// </summary>
    public string PayloadBruto { get; private set; } = "{}";

    /// <summary>
    /// Registra se a requisicao trouxe uma assinatura HMAC valida. Um evento so
    /// chega ate aqui autenticado, mas guardar o fato deixa a trilha completa.
    /// </summary>
    public bool AssinaturaVerificada { get; private set; }

    public DateTimeOffset RecebidoEm { get; private set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset? ProcessadoEm { get; private set; }

    /// <summary>Espelha as tentativas do job, para o dashboard nao precisar de join.</summary>
    public int Tentativas { get; private set; }

    private PaymentEvent() { }

    /// <summary>Cria um evento valido, pronto para ser enfileirado.</summary>
    public static PaymentEvent Accepted(
        string idTransacao,
        string idContrato,
        decimal valor,
        DateTimeOffset dataPagamento,
        string statusOrigem,
        string payloadBruto,
        bool assinaturaVerificada,
        DateTimeOffset recebidoEm)
        => new()
        {
            IdTransacao = idTransacao,
            IdContrato = idContrato,
            Valor = valor,
            DataPagamento = dataPagamento,
            StatusOrigem = statusOrigem,
            PayloadBruto = payloadBruto,
            AssinaturaVerificada = assinaturaVerificada,
            RecebidoEm = recebidoEm,
            StatusProcessamento = ProcessingStatus.Pendente
        };

    /// <summary>
    /// Cria a linha de auditoria de um payload reprovado na validacao. Preserva o
    /// que deu para extrair do corpo, para o dashboard ter contexto.
    /// </summary>
    public static PaymentEvent Rejected(
        string idTransacao,
        string? idContrato,
        decimal? valor,
        DateTimeOffset? dataPagamento,
        string? statusOrigem,
        string payloadBruto,
        string erro,
        bool assinaturaVerificada,
        DateTimeOffset recebidoEm)
        => new()
        {
            IdTransacao = idTransacao,
            IdContrato = idContrato,
            Valor = valor,
            DataPagamento = dataPagamento,
            StatusOrigem = statusOrigem,
            PayloadBruto = payloadBruto,
            Erro = erro,
            AssinaturaVerificada = assinaturaVerificada,
            RecebidoEm = recebidoEm,
            StatusProcessamento = ProcessingStatus.Invalido,
            ProcessadoEm = recebidoEm
        };

    /// <summary>Marca que um worker reivindicou o evento.</summary>
    public void MarkProcessing(int tentativa)
    {
        StatusProcessamento = ProcessingStatus.Processando;
        Tentativas = tentativa;
    }

    /// <summary>Encerra o evento com sucesso.</summary>
    public void MarkSucceeded(DateTimeOffset processadoEm)
    {
        StatusProcessamento = ProcessingStatus.Sucesso;
        ProcessadoEm = processadoEm;
        Erro = null;
    }

    /// <summary>
    /// Encerra o evento em erro definitivo (tentativas esgotadas). Uma falha que
    /// ainda tera nova tentativa nao passa por aqui - continua
    /// <see cref="ProcessingStatus.Processando"/> ate o desfecho.
    /// </summary>
    public void MarkFailed(string erro, DateTimeOffset processadoEm)
    {
        StatusProcessamento = ProcessingStatus.Erro;
        Erro = Truncate(erro, 2000);
        ProcessadoEm = processadoEm;
    }

    /// <summary>Devolve o evento a fila apos uma falha transitoria.</summary>
    public void MarkRetrying(string erro, int tentativas)
    {
        StatusProcessamento = ProcessingStatus.Pendente;
        Erro = Truncate(erro, 2000);
        Tentativas = tentativas;
    }

    private static string Truncate(string value, int max)
        => value.Length <= max ? value : value[..max];
}
