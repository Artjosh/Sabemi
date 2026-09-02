namespace Sabemi.Domain.Processing;

/// <summary>
/// As causas de falha que o sistema sabe nomear, indexadas pelo codigo.
/// </summary>
/// <remarks>
/// <b>Por que so o codigo e persistido.</b> A tabela guarda
/// <c>erro_categoria</c> e <c>erro_codigo</c>; a explicacao e a acao sugerida
/// sao derivadas daqui na hora da consulta. Melhorar a redacao de um tooltip
/// vira um deploy, nao uma migration com UPDATE em massa - e eventos antigos
/// passam a mostrar o texto novo.
///
/// <b>Por que os codigos sao estaveis.</b> Eles aparecem na API, na metrica
/// <c>sabemi_processing_failures_total</c> (rotulo <c>codigo</c>) e na UI.
/// Renomear um quebra painel e serie historica; acrescentar um novo nao quebra
/// nada. Trate esta lista como parte do contrato publico.
/// </remarks>
public static class FailureCatalog
{
    /// <summary>Falha ainda nao classificada, ou codigo desconhecido.</summary>
    public const string NaoClassificado = "ERRO_NAO_CLASSIFICADO";

    /// <summary>
    /// Payload reprovado na validacao do webhook. Nao vem de excecao: e a
    /// ingestao que o atribui, ao gravar a linha de auditoria de um corpo que
    /// nunca chegou a ser enfileirado.
    /// </summary>
    public const string PayloadInvalido = "PAYLOAD_INVALIDO";

    private static readonly FailureDiagnosis[] Todos =
    [
        // --- transitorias -----------------------------------------------------
        new(FailureCategory.Transitoria, "TIMEOUT",
            "A operacao demorou mais do que o limite e foi interrompida.",
            "Nenhuma acao necessaria: o item volta para a fila automaticamente."),

        new(FailureCategory.Transitoria, "REDE_INDISPONIVEL",
            "Nao foi possivel alcancar um servico externo pela rede.",
            "Nenhuma acao necessaria: sera retentado. Se persistir, verifique a conectividade do servico."),

        new(FailureCategory.Transitoria, "CANCELADO",
            "O processamento foi interrompido, provavelmente por um desligamento do worker.",
            "Nenhuma acao necessaria: outro worker retoma o item."),

        new(FailureCategory.Transitoria, "DEADLOCK",
            "Duas operacoes disputaram os mesmos registros e o banco desfez uma delas.",
            "Nenhuma acao necessaria: o item volta para a fila e tende a passar na proxima tentativa."),

        new(FailureCategory.Transitoria, "CONFLITO_DE_CONCORRENCIA",
            "Outro processo alterou os mesmos dados ao mesmo tempo.",
            "Nenhuma acao necessaria: sera retentado com os dados ja atualizados."),

        new(FailureCategory.Transitoria, "BANCO_INDISPONIVEL",
            "O banco de dados recusou a conexao - normalmente ele esta reiniciando ou fora do ar.",
            "Verifique se o servico do banco esta no ar. O item sera retentado sozinho."),

        new(FailureCategory.Transitoria, "POOL_ESGOTADO",
            "O banco atingiu o limite de conexoes simultaneas.",
            "Reduza a concorrencia do worker ou aumente max_connections. Sera retentado."),

        // --- permanentes ------------------------------------------------------
        new(FailureCategory.Permanente, "PAYLOAD_INVALIDO",
            "O corpo do webhook nao passou na validacao de contrato - o campo indicado esta ausente, vazio ou fora do formato.",
            "O evento fica registrado para auditoria, mas nao sera processado. Corrija na origem e reenvie com um novo id_transacao."),

        new(FailureCategory.Permanente, "DADO_INVALIDO",
            "O conteudo do evento nao pode ser interpretado pela regra de processamento.",
            "Corrija o payload na origem e reenvie o webhook com um novo id_transacao."),

        new(FailureCategory.Permanente, "REFERENCIA_INEXISTENTE",
            "O evento aponta para um registro que nao existe - por exemplo, um contrato desconhecido.",
            "Cadastre o registro referenciado e use o botao Reenfileirar, ou corrija o payload na origem."),

        new(FailureCategory.Permanente, "REGRA_DE_NEGOCIO_VIOLADA",
            "Um valor do evento fere uma regra do modelo de dados (por exemplo, valor negativo).",
            "Corrija o valor na origem e reenvie o webhook com um novo id_transacao."),

        new(FailureCategory.Permanente, "CAMPO_OBRIGATORIO_AUSENTE",
            "O evento nao trouxe um campo que e obrigatorio para consolidar o pagamento.",
            "Complete o payload na origem e reenvie com um novo id_transacao."),

        new(FailureCategory.Permanente, "VALOR_FORA_DA_FAIXA",
            "O valor informado excede a precisao aceita pelo campo (18 digitos, 2 decimais).",
            "Corrija o valor na origem e reenvie com um novo id_transacao."),

        // --- desconhecida -----------------------------------------------------
        new(FailureCategory.Desconhecida, NaoClassificado,
            "O processamento falhou por um motivo que o sistema nao soube classificar.",
            "Sera retentado automaticamente. Consulte a mensagem tecnica completa para o diagnostico."),
    ];

    private static readonly Dictionary<string, FailureDiagnosis> PorCodigo =
        Todos.ToDictionary(d => d.Code, StringComparer.Ordinal);

    /// <summary>Todos os diagnosticos conhecidos - usado nos testes de paridade.</summary>
    public static IReadOnlyList<FailureDiagnosis> All => Todos;

    /// <summary>
    /// Diagnostico de um codigo. Um codigo nao reconhecido - de uma versao mais
    /// nova que gravou algo que esta nao conhece - cai no generico em vez de
    /// estourar: a consulta de um evento antigo nao pode quebrar o painel.
    /// </summary>
    public static FailureDiagnosis Describe(string? codigo)
        => codigo is not null && PorCodigo.TryGetValue(codigo, out var d)
            ? d
            : PorCodigo[NaoClassificado];
}
