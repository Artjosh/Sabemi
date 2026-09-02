import { defineConfig } from "prisma/config";

// Mesmo carregamento de `.env` da config principal: o Prisma 7 nao o faz
// sozinho, e sem isto o comando falharia numa maquina recem-clonada.
try {
  process.loadEnvFile(".env");
} catch {
  // Sem arquivo `.env`: as variaveis vem do proprio ambiente (CI, container).
}

/**
 * Config usada APENAS por `pnpm db:check`, nunca por `prisma generate`.
 *
 * <b>Por que um segundo arquivo.</b> O `prisma migrate diff` do Prisma 7 nao
 * aceita mais `--to-url`; para comparar o modelo com um banco real e preciso
 * `--to-config-datasource`, que le a datasource da config. Mas por em
 * `prisma.config.ts` a datasource que o diff precisa reintroduziria o problema
 * que aquele arquivo documenta: o `prisma generate` do build Docker EMBUTE a URL
 * no cliente gerado, e o container passa a conectar com as credenciais que
 * estavam ali no momento do build - foi assim que apareceu o
 * `password authentication failed for user "sabemi"` que custou horas.
 *
 * Separando os dois, `generate` continua sem datasource alguma e o diff tem a
 * sua. Nada aqui entra em imagem: este arquivo so e lido por um comando de
 * verificacao.
 *
 * <b>Por que sem valor padrao.</b> Se `DATABASE_URL` faltar, o comando deve
 * falhar dizendo isso. Uma URL de marcador faria o diff comparar o modelo com um
 * banco que nao e o nosso e reportar "sem diferencas" por engano - o pior
 * resultado possivel para uma verificacao.
 *
 * Uso:  pnpm db:check
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
