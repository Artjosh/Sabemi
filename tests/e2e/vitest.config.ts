import { defineConfig } from "vitest/config";

/**
 * Testes ponta a ponta contra a stack em execucao.
 *
 * Pre-requisito:
 *   AUTH_RATE_LIMIT=500 docker compose up -d --wait
 *
 * O teto de login precisa ser maior que o de producao: a suite faz dezenas de
 * autenticacoes do mesmo IP em segundos, e o limite real (10/min) a derrubaria.
 * Ver o README desta pasta.
 *
 * Rodam em SERIE. Os arquivos compartilham a mesma stack e o mesmo banco; em
 * paralelo, o worker de um teste consumiria a fila de outro e os totais
 * consolidados dos contratos ficariam nao deterministicos.
 *
 * Os prazos sao generosos de proposito: cada verificacao espera um worker de
 * OUTRO container concluir um trabalho de ~2s.
 */
export default defineConfig({
  test: {
    include: ["**/*.e2e.test.ts"],

    // Consulta o `/health` dos dois backends ANTES da coleta, para os testes de
    // autenticacao poderem ser pulados quando ha provedor de e-mail ativo - ver
    // global-setup.ts. Tambem falha cedo, com o comando certo na mensagem, se a
    // stack nao estiver no ar.
    globalSetup: ["./global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,

    // Um arquivo por vez, e uma thread so dentro de cada um.
    fileParallelism: false,
    maxWorkers: 1,

    reporters: ["verbose"],
  },
});
