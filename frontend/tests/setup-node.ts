/**
 * Preparacao dos testes de servidor.
 *
 * Define as variaveis de ambiente ANTES de qualquer import de modulo do BFF:
 * `server/bff/config.ts` le `process.env` no momento em que e carregado, entao
 * defini-las dentro de um teste chegaria tarde demais.
 */

// `NODE_ENV` e declarado readonly nos tipos do Node, mas e gravavel em
// execucao. O alias tipado permite a atribuicao sem recorrer a `any`.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ??= "test";

// Mesmos segredos do backend .NET nos testes, para exercitar a equivalencia de
// contrato entre os dois.
process.env.JWT_SECRET ??= "segredo-de-teste-com-mais-de-32-caracteres-aqui";
process.env.WEBHOOK_API_KEY ??= "chave-de-teste";
process.env.WEBHOOK_SIGNATURE_SECRET ??= "segredo-de-teste";
process.env.WEBHOOK_REQUIRE_SIGNATURE ??= "false";

// A regra "pesada" fica instantanea: o que se verifica e o fluxo, nao o
// funcionamento do setTimeout. O teste de latencia do webhook restaura a
// duracao real.
process.env.PROCESSING_SIMULATED_WORK_MS ??= "0";
process.env.PROCESSING_BASE_RETRY_DELAY_MS ??= "0";

// O laco em processo fica desligado: os testes chamam runProcessingCycle()
// diretamente, e um laco de fundo consumindo a fila em paralelo tornaria os
// resultados nao deterministicos.
process.env.BFF_WORKER_ENABLED ??= "false";

process.env.BFF_PUBLIC_BASE_URL ??= "http://localhost:3000";
