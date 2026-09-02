using Sabemi.Domain.Enums;
using Sabemi.Domain.Processing;

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
    /// Natureza da ultima falha - ver <see cref="FailureCategory"/>. E o que
    /// diz se o retry automatico faz sentido, e o que permite filtrar no painel
    /// "o que quebrou por nossa causa" de "o que quebrou por causa do payload".
    /// </summary>
    public FailureCategory? ErroCategoria { get; private set; }

    /// <summary>
    /// Codigo estavel da causa (<c>DEADLOCK</c>, <c>REFERENCIA_INEXISTENTE</c>...).
    /// A explicacao e a acao sugeridas NAO sao gravadas: derivam daqui via
    /// <see cref="FailureCatalog"/> na hora da consulta, entao melhorar um texto
    /// nao exige tocar em linha nenhuma da tabela.
    /// </summary>
    public string? ErroCodigo { get; private set; }

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
            ProcessadoEm = recebidoEm,

            // Um evento invalido tambem tem uma causa a explicar no painel. Sem
            // isto ele seria o unico estado de erro sem tooltip - e e justamente
            // o mais frequente.
            ErroCategoria = FailureCategory.Permanente,
            ErroCodigo = FailureCatalog.PayloadInvalido
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
        ErroCategoria = null;
        ErroCodigo = null;
    }

    /// <summary>
    /// Encerra o evento em erro definitivo (tentativas esgotadas). Uma falha que
    /// ainda tera nova tentativa nao passa por aqui - continua
    /// <see cref="ProcessingStatus.Processando"/> ate o desfecho.
    /// </summary>
    public void MarkFailed(string erro, DateTimeOffset processadoEm, FailureDiagnosis? diagnostico = null)
    {
        StatusProcessamento = ProcessingStatus.Erro;
        Erro = Truncate(erro, 2000);
        ProcessadoEm = processadoEm;
        AplicarDiagnostico(diagnostico);
    }

    /// <summary>Devolve o evento a fila apos uma falha transitoria.</summary>
    public void MarkRetrying(string erro, int tentativas, FailureDiagnosis? diagnostico = null)
    {
        StatusProcessamento = ProcessingStatus.Pendente;
        Erro = Truncate(erro, 2000);
        Tentativas = tentativas;
        AplicarDiagnostico(diagnostico);
    }

    /// <summary>
    /// Grava a leitura da falha. Sem diagnostico o evento fica com o codigo
    /// generico em vez de <c>null</c>: uma falha sempre tem uma causa, e um
    /// campo vazio no painel obrigaria quem opera a decidir se aquilo significa
    /// "sem categoria" ou "ainda nao classificado".
    /// </summary>
    private void AplicarDiagnostico(FailureDiagnosis? diagnostico)
    {
        var lido = diagnostico ?? FailureCatalog.Describe(FailureCatalog.NaoClassificado);
        ErroCategoria = lido.Category;
        ErroCodigo = lido.Code;
    }

    /// <summary>
    /// O evento pode ser devolvido a fila por decisao de uma pessoa?
    /// </summary>
    /// <remarks>
    /// So <see cref="ProcessingStatus.Erro"/>. Cada recusa tem um motivo
    /// diferente, e todos importam:
    ///
    /// <list type="bullet">
    /// <item><b>Sucesso</b> - o pagamento ja foi somado ao contrato. Processar de
    /// novo somaria uma segunda vez, corrompendo o total liquidado. E a
    /// idempotencia nao protege aqui: ela impede um evento DUPLICADO de entrar,
    /// nao impede o MESMO evento de ser processado duas vezes.</item>
    /// <item><b>Pendente / Processando</b> - ja esta na fila. Reenfileirar criaria
    /// uma segunda execucao concorrente do mesmo evento.</item>
    /// <item><b>Invalido</b> - foi reprovado na validacao e nunca teve job. O
    /// payload nao muda por ser reenviado; o caminho e corrigir na origem.</item>
    /// <item><b>Duplicado</b> - nao existe como linha propria na tabela.</item>
    /// </list>
    /// </remarks>
    public bool PodeSerReenfileirado => StatusProcessamento == ProcessingStatus.Erro;

    /// <summary>
    /// Devolve o evento ao estado de fila. Preserva <see cref="Erro"/> e o
    /// diagnostico ate o proximo desfecho: apaga-los aqui destruiria o registro
    /// do que havia acontecido justo enquanto alguem investiga.
    /// </summary>
    public void MarkRequeued()
    {
        StatusProcessamento = ProcessingStatus.Pendente;
        ProcessadoEm = null;
        Tentativas = 0;
    }

    private static string Truncate(string value, int max)
        => value.Length <= max ? value : value[..max];
}
