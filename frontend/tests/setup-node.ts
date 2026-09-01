/**
 * Preparacao dos testes de servidor.
 *
 * Roda ANTES de qualquer import de modulo do BFF: `server/bff/config.ts` le
 * `process.env` no momento em que e carregado, entao definir uma variavel
 * dentro de um teste chegaria tarde demais.
 */

// O que veio do SHELL, capturado antes de qualquer `.env` entrar em cena.
//
// A distincao importa: uma variavel definida na linha de comando (ou pelo CI) e
// uma instrucao deliberada e deve vencer. Uma que veio do `.env` e configuracao
// de DESENVOLVIMENTO, e nao pode arrastar a suite para o banco de trabalho.
const doShell = { DATABASE_URL: process.env.DATABASE_URL };

// O Vitest nao carrega `.env` sozinho. Carregar aqui mantem o ambiente coerente
// com o resto do projeto, mas ele nao decide nada critico - ver abaixo.
try {
  process.loadEnvFile(".env");
} catch {
  // Sem `.env`: as variaveis vem do proprio ambiente.
}

// `NODE_ENV` e declarado readonly nos tipos do Node, mas e gravavel em
// execucao. O alias tipado permite a atribuicao sem recorrer a `any`.
const env = process.env as Record<string, string | undefined>;

env.NODE_ENV ??= "test";

/**
 * Valores FIXOS da suite - atribuicao direta, nao `??=`.
 *
 * A diferenca importa. Estes valores sao fixtures: os testes comparam contra
 * eles literalmente (`"chave-de-teste"` aparece nas asserções). Se o `.env` da
 * maquina pudesse sobrescreve-los, a suite passaria para uns e falharia para
 * outros conforme a configuracao local - e o mesmo commit teria resultados
 * diferentes em cada maquina.
 *
 * `DATABASE_URL` e a excecao deliberada logo abaixo: ela e a unica que depende
 * de onde o PostgreSQL esta rodando.
 */

// Mesmos segredos do backend .NET nos testes, para exercitar a equivalencia de
// contrato entre os dois.
env.JWT_SECRET = "segredo-de-teste-com-mais-de-32-caracteres-aqui";
env.WEBHOOK_API_KEY = "chave-de-teste";
env.WEBHOOK_SIGNATURE_SECRET = "segredo-de-teste";
env.WEBHOOK_REQUIRE_SIGNATURE = "false";

// A regra "pesada" fica instantanea: o que se verifica e o fluxo, nao o
// funcionamento do setTimeout. O teste de latencia do webhook restaura a
// duracao real por conta propria.
env.PROCESSING_SIMULATED_WORK_MS = "0";
env.PROCESSING_BASE_RETRY_DELAY_MS = "0";
env.PROCESSING_BATCH_SIZE = "5";

// O laco em processo fica desligado: os testes chamam runProcessingCycle()
// diretamente, e um laco de fundo consumindo a fila em paralelo tornaria os
// resultados nao deterministicos.
env.BFF_WORKER_ENABLED = "false";

env.BFF_PUBLIC_BASE_URL = "http://localhost:3000";

/**
 * A unica variavel que o ambiente PODE definir: onde o PostgreSQL esta.
 * Depende da maquina (porta, host, credenciais), e nao da suite.
 *
 * <b>Repare no banco: `sabemi_test`, e nao `sabemi`.</b> Isso nao e detalhe.
 *
 * Com a stack no ar, o container do frontend roda o laco de processamento do
 * BFF contra o schema `vinext` do banco de desenvolvimento. Se a suite usasse o
 * mesmo banco, aquele worker reivindicaria os jobs que os testes acabaram de
 * enfileirar - e as verificacoes de fila falhariam de forma intermitente, com o
 * erro apontando para o codigo em vez de para a interferencia.
 *
 * A precedencia e: shell > banco de teste. O `.env` fica de fora de proposito -
 * ele aponta para o banco de trabalho, e deixa-lo vencer traria de volta a
 * interferencia que este isolamento existe para evitar.
 *
 * O banco e preparado automaticamente pelo `pretest`; para faze-lo a mao:
 *   pnpm db:test:setup
 */
env.DATABASE_URL =
  doShell.DATABASE_URL ?? "postgresql://sabemi:sabemi@localhost:5432/sabemi_test?schema=vinext";
