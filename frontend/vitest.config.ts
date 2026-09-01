import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Configuracao de testes do frontend e do backend VINEXT.
 *
 * <b>Por que uma config separada do `vite.config.ts`.</b> A config de aplicacao
 * carrega o plugin do vinext, que monta tres ambientes (RSC, SSR e cliente) para
 * servir a aplicacao. Nos testes isso nao ajuda e atrapalha: o que se quer e
 * importar modulos e chamar funcoes. Aqui fica so o plugin do React, para os
 * testes de componente, e o mesmo alias `@/` que o app usa.
 *
 * <b>Dois projetos, dois ambientes.</b>
 *
 *   * `node`    - servicos do BFF, adapters, validacao, cripto. Rodam contra um
 *                 PostgreSQL de verdade quando `DATABASE_URL` esta definida.
 *   * `browser` - componentes React em jsdom (login com polling, seletor de
 *                 backend, dashboard).
 *
 * Separar evita carregar jsdom para testar uma funcao de hash, e evita que um
 * teste de componente enxergue acidentalmente as APIs de servidor.
 */
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),

      // Em execucao, quem resolve `next/*` e o plugin do vinext. Aqui ele nao
      // esta carregado (ver acima), entao os imports sao apontados diretamente
      // para os MESMOS shims que o plugin usaria.
      //
      // Nao sao dubles escritos para o teste: e a implementacao real do vinext,
      // a mesma que roda em producao. Um `next/navigation` falso poderia divergir
      // do comportamento verdadeiro e esconder um defeito.
      "next/navigation": "vinext/shims/navigation",
      "next/headers": "vinext/shims/headers",
      "next/server": "vinext/shims/server",
      "next/link": "vinext/shims/link",
    },
  },

  test: {
    globals: true,

    // Os arquivos rodam UM DE CADA VEZ.
    //
    // Os testes do BFF compartilham uma unica instancia de PostgreSQL e cada
    // arquivo limpa as tabelas no `beforeEach`. Em paralelo, a limpeza de um
    // arquivo apaga as linhas que o outro acabou de semear - e a suite falha de
    // forma intermitente, com um erro que aponta para o lugar errado.
    //
    // Esta opcao precisa ficar na RAIZ: declarada dentro de um bloco `projects`
    // ela e ignorada, e os arquivos continuam concorrendo.
    fileParallelism: false,

    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/node/**/*.test.ts"],
          setupFiles: ["tests/setup-node.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          environment: "jsdom",
          include: ["tests/browser/**/*.test.tsx"],
          setupFiles: ["tests/setup-browser.ts"],
          testTimeout: 20_000,
        },
      },
    ],

    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",

      // Mede o que a aplicacao executa. O que fica de fora nao e escolha de
      // conveniencia:
      //
      //   generated/  - cliente do Prisma, gerado a partir do schema.
      //   ui/         - primitivas de apresentacao (Button, Card, Table). Sao
      //                 exercitadas indiretamente pelos testes de tela; medi-las
      //                 isoladamente contaria variantes de classe CSS como
      //                 "logica testada", que e o tipo de numero inflado que a
      //                 especificacao pede para evitar.
      include: ["lib/**/*.ts", "server/**/*.ts", "components/**/*.tsx", "app/api/**/*.ts"],
      exclude: [
        "generated/**",
        "components/ui/**",
        "**/*.d.ts",
        "**/*.config.*",
      ],

      // O pipeline falha abaixo destes valores.
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
