/**
 * Catalogo de falhas do backend VINEXT.
 *
 * <b>Este arquivo e a traducao literal de
 * `Sabemi.Domain/Processing/FailureCatalog.cs` e `FailureClassifier.cs`.</b> Os
 * codigos e os textos sao os MESMOS de proposito: a UI e uma so, e o usuario nao
 * deveria receber explicacoes diferentes para a mesma falha dependendo de qual
 * backend estava selecionado. Um teste de paridade (tests/node/failure-parity)
 * compara as duas listas e quebra o build se elas divergirem.
 *
 * <b>Por que duplicar em vez de compartilhar.</b> Compartilhar exigiria um
 * pacote comum consumido por .NET e por TypeScript - uma dependencia de build
 * entre os dois backends que existem justamente para serem independentes. A
 * duplicacao e deliberada, e o teste de paridade e o que a mantem honesta.
 *
 * <b>Por que so o codigo e persistido.</b> A tabela guarda `erro_categoria` e
 * `erro_codigo`; explicacao e acao sugerida sao derivadas daqui na consulta.
 * Melhorar a redacao de um tooltip vira um deploy, nao um UPDATE em massa - e
 * eventos antigos passam a mostrar o texto novo.
 */

/** Natureza da falha, e com ela a decisao de retentar. */
export type FailureCategory = "TRANSITORIA" | "PERMANENTE" | "DESCONHECIDA";

/** Falha traduzida para quem opera o painel. */
export interface FailureDiagnosis {
  categoria: FailureCategory;
  /** Codigo estavel - tambem rotulo de metrica. Renomear quebra serie historica. */
  codigo: string;
  /** Uma frase dizendo o que deu errado, sem jargao de excecao. */
  explicacao: string;
  /** O que a pessoa pode fazer a respeito. */
  acao_sugerida: string;
  /**
   * O sistema retenta sozinho esta causa? `false` em falha permanente - e o que
   * justifica o botao de reenfileirar aparecer, ja que ninguem mais vai tentar.
   */
  retentavel: boolean;
}

/** Codigo usado quando nada foi reconhecido. */
export const CODIGO_NAO_CLASSIFICADO = "ERRO_NAO_CLASSIFICADO";

/**
 * Payload reprovado na validacao do webhook. Nao vem de excecao: e a ingestao
 * que o atribui, ao gravar a linha de auditoria de um corpo que nunca chegou a
 * ser enfileirado.
 */
export const CODIGO_PAYLOAD_INVALIDO = "PAYLOAD_INVALIDO";

/** Monta a entrada derivando `retentavel` da categoria, para os dois nunca divergirem. */
function entrada(
  categoria: FailureCategory,
  codigo: string,
  explicacao: string,
  acao_sugerida: string,
): FailureDiagnosis {
  return {
    categoria,
    codigo,
    explicacao,
    acao_sugerida,
    retentavel: categoria !== "PERMANENTE",
  };
}

const TODOS: readonly FailureDiagnosis[] = [
  // --- transitorias ---------------------------------------------------------
  entrada(
    "TRANSITORIA",
    "TIMEOUT",
    "A operacao demorou mais do que o limite e foi interrompida.",
    "Nenhuma acao necessaria: o item volta para a fila automaticamente.",
  ),
  entrada(
    "TRANSITORIA",
    "REDE_INDISPONIVEL",
    "Nao foi possivel alcancar um servico externo pela rede.",
    "Nenhuma acao necessaria: sera retentado. Se persistir, verifique a conectividade do servico.",
  ),
  entrada(
    "TRANSITORIA",
    "CANCELADO",
    "O processamento foi interrompido, provavelmente por um desligamento do worker.",
    "Nenhuma acao necessaria: outro worker retoma o item.",
  ),
  entrada(
    "TRANSITORIA",
    "DEADLOCK",
    "Duas operacoes disputaram os mesmos registros e o banco desfez uma delas.",
    "Nenhuma acao necessaria: o item volta para a fila e tende a passar na proxima tentativa.",
  ),
  entrada(
    "TRANSITORIA",
    "CONFLITO_DE_CONCORRENCIA",
    "Outro processo alterou os mesmos dados ao mesmo tempo.",
    "Nenhuma acao necessaria: sera retentado com os dados ja atualizados.",
  ),
  entrada(
    "TRANSITORIA",
    "BANCO_INDISPONIVEL",
    "O banco de dados recusou a conexao - normalmente ele esta reiniciando ou fora do ar.",
    "Verifique se o servico do banco esta no ar. O item sera retentado sozinho.",
  ),
  entrada(
    "TRANSITORIA",
    "POOL_ESGOTADO",
    "O banco atingiu o limite de conexoes simultaneas.",
    "Reduza a concorrencia do worker ou aumente max_connections. Sera retentado.",
  ),

  // --- permanentes ----------------------------------------------------------
  entrada(
    "PERMANENTE",
    "PAYLOAD_INVALIDO",
    "O corpo do webhook nao passou na validacao de contrato - o campo indicado esta ausente, vazio ou fora do formato.",
    "O evento fica registrado para auditoria, mas nao sera processado. Corrija na origem e reenvie com um novo id_transacao.",
  ),
  entrada(
    "PERMANENTE",
    "DADO_INVALIDO",
    "O conteudo do evento nao pode ser interpretado pela regra de processamento.",
    "Corrija o payload na origem e reenvie o webhook com um novo id_transacao.",
  ),
  entrada(
    "PERMANENTE",
    "REFERENCIA_INEXISTENTE",
    "O evento aponta para um registro que nao existe - por exemplo, um contrato desconhecido.",
    "Cadastre o registro referenciado e use o botao Reenfileirar, ou corrija o payload na origem.",
  ),
  entrada(
    "PERMANENTE",
    "REGRA_DE_NEGOCIO_VIOLADA",
    "Um valor do evento fere uma regra do modelo de dados (por exemplo, valor negativo).",
    "Corrija o valor na origem e reenvie o webhook com um novo id_transacao.",
  ),
  entrada(
    "PERMANENTE",
    "CAMPO_OBRIGATORIO_AUSENTE",
    "O evento nao trouxe um campo que e obrigatorio para consolidar o pagamento.",
    "Complete o payload na origem e reenvie com um novo id_transacao.",
  ),
  entrada(
    "PERMANENTE",
    "VALOR_FORA_DA_FAIXA",
    "O valor informado excede a precisao aceita pelo campo (18 digitos, 2 decimais).",
    "Corrija o valor na origem e reenvie com um novo id_transacao.",
  ),

  // --- desconhecida ---------------------------------------------------------
  entrada(
    "DESCONHECIDA",
    CODIGO_NAO_CLASSIFICADO,
    "O processamento falhou por um motivo que o sistema nao soube classificar.",
    "Sera retentado automaticamente. Consulte a mensagem tecnica completa para o diagnostico.",
  ),
];

const POR_CODIGO = new Map(TODOS.map((d) => [d.codigo, d]));

/** Todos os diagnosticos conhecidos - usado no teste de paridade com o .NET. */
export const DIAGNOSTICOS_CONHECIDOS = TODOS;

/**
 * Diagnostico de um codigo. Um codigo nao reconhecido - gravado por uma versao
 * mais nova - cai no generico em vez de estourar: a consulta de um evento antigo
 * nao pode quebrar o painel.
 */
export function descrever(codigo: string | null | undefined): FailureDiagnosis {
  return (codigo && POR_CODIGO.get(codigo)) || POR_CODIGO.get(CODIGO_NAO_CLASSIFICADO)!;
}

/**
 * Agulhas de texto, da mais especifica para a mais generica. A ordem importa:
 * "statement timeout" tambem casaria com uma regra generica de "timeout".
 *
 * Mesma lista do `FailureClassifier.PorTexto` do backend .NET.
 */
const POR_TEXTO: readonly (readonly [string, string])[] = [
  ["deadlock", "DEADLOCK"],
  ["could not serialize", "CONFLITO_DE_CONCORRENCIA"],
  ["connection refused", "BANCO_INDISPONIVEL"],
  ["econnrefused", "BANCO_INDISPONIVEL"],
  ["too many clients", "POOL_ESGOTADO"],
  ["timeout", "TIMEOUT"],
  ["etimedout", "TIMEOUT"],
  ["violates foreign key", "REFERENCIA_INEXISTENTE"],
  ["violates check constraint", "REGRA_DE_NEGOCIO_VIOLADA"],
  ["violates not-null", "CAMPO_OBRIGATORIO_AUSENTE"],
  ["numeric field overflow", "VALOR_FORA_DA_FAIXA"],
];

/**
 * Codigos de erro do PostgreSQL que o Prisma expoe em `error.code` (P-codes) e
 * o driver `pg` em `error.code` (SQLSTATE). Olhar o codigo antes do texto e mais
 * confiavel: a mensagem muda entre versoes e entre locales do servidor.
 */
const POR_CODIGO_DO_BANCO: Readonly<Record<string, string>> = {
  // SQLSTATE do PostgreSQL
  "40P01": "DEADLOCK",
  "40001": "CONFLITO_DE_CONCORRENCIA",
  "23503": "REFERENCIA_INEXISTENTE",
  "23514": "REGRA_DE_NEGOCIO_VIOLADA",
  "23502": "CAMPO_OBRIGATORIO_AUSENTE",
  "22003": "VALOR_FORA_DA_FAIXA",
  "53300": "POOL_ESGOTADO",
  "57014": "TIMEOUT",

  // Codigos do Prisma
  P1001: "BANCO_INDISPONIVEL",
  P1002: "TIMEOUT",
  P1008: "TIMEOUT",
  P1017: "BANCO_INDISPONIVEL",
  P2003: "REFERENCIA_INEXISTENTE",
  P2011: "CAMPO_OBRIGATORIO_AUSENTE",
  P2020: "VALOR_FORA_DA_FAIXA",
};

/** Concatena a cadeia de causas: o detalhe util costuma estar na interna. */
function textoCompleto(erro: unknown): string {
  const partes: string[] = [];
  let atual: unknown = erro;

  // Limite de profundidade: uma cadeia ciclica de `cause` travaria o worker.
  for (let i = 0; atual instanceof Error && i < 8; i += 1) {
    partes.push(atual.message);
    atual = atual.cause;
  }

  if (partes.length === 0) partes.push(String(erro));
  return partes.join(" | ");
}

/**
 * Nomes de erro que sao, por definicao, permanentes.
 *
 * `PrismaClientValidationError` e o caso concreto que motivou esta lista: ele
 * significa que a CHAMADA esta errada - um campo obrigatorio ausente no `where`,
 * um tipo incompativel. Nenhuma repeticao conserta isso, e antes de reconhece-lo
 * o classificador o tratava como desconhecido, ou seja, retentava tres vezes um
 * erro de programacao antes de desistir.
 */
const NOMES_PERMANENTES: ReadonlySet<string> = new Set([
  "PrismaClientValidationError",
  "PrismaClientUnknownRequestError",
]);

/** Procura na cadeia de causas um erro cujo NOME ja decide a categoria. */
function nomePermanente(erro: unknown): boolean {
  let atual: unknown = erro;

  for (let i = 0; atual instanceof Error && i < 8; i += 1) {
    if (NOMES_PERMANENTES.has(atual.name)) return true;
    atual = atual.cause;
  }

  return false;
}

/** Primeiro `code` encontrado na cadeia de causas. */
function codigoDoBanco(erro: unknown): string | undefined {
  let atual: unknown = erro;

  for (let i = 0; atual instanceof Error && i < 8; i += 1) {
    const code = (atual as { code?: unknown }).code;
    if (typeof code === "string" && code in POR_CODIGO_DO_BANCO) {
      return POR_CODIGO_DO_BANCO[code];
    }
    atual = atual.cause;
  }

  return undefined;
}

/**
 * Le um erro e devolve o diagnostico que decide o retry e alimenta o tooltip.
 *
 * O padrao e RETENTAR: uma causa nao reconhecida vira `DESCONHECIDA`, que e
 * retentavel. Errar retentando custa uma espera; errar desistindo custa um
 * pagamento que nunca consolidou.
 */
export function classificar(erro: unknown): FailureDiagnosis {
  // O codigo do banco primeiro: e mais confiavel que a mensagem, que muda entre
  // versoes do PostgreSQL e entre locales do servidor.
  const porCodigo = codigoDoBanco(erro);
  if (porCodigo) return descrever(porCodigo);

  // Depois o nome do erro, para os que ja se classificam sozinhos.
  if (nomePermanente(erro)) return descrever("DADO_INVALIDO");

  const texto = textoCompleto(erro).toLowerCase();

  for (const [agulha, codigo] of POR_TEXTO) {
    if (texto.includes(agulha)) return descrever(codigo);
  }

  // Erros de programacao: retentar apenas repete o mesmo caminho de codigo.
  if (erro instanceof TypeError || erro instanceof RangeError || erro instanceof SyntaxError) {
    return descrever("DADO_INVALIDO");
  }

  return descrever(CODIGO_NAO_CLASSIFICADO);
}
