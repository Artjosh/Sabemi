import { defineConfig } from "prisma/config";

// O Prisma 7 deixou de carregar `.env` sozinho. Sem isto, qualquer comando de
// migration falha com "Cannot resolve environment variable: DATABASE_URL" em
// uma maquina que nao exporte a variavel manualmente - exatamente o caso de
// quem acabou de clonar o repositorio.
//
// Em CI e no container a variavel ja vem do ambiente e nao ha arquivo `.env`;
// por isso a falha e ignorada em vez de interromper.
try {
  process.loadEnvFile(".env");
} catch {
  // Sem arquivo `.env`: as variaveis vem do proprio ambiente.
}

/**
 * URL da fonte de dados para as ferramentas do Prisma.
 *
 * O marcador de posicao existe porque `prisma generate` NAO abre conexao - ele
 * so le o schema e emite o cliente. Exigir uma URL real ali quebraria dois
 * fluxos legitimos: o `postinstall` de quem acabou de clonar o repositorio, e a
 * etapa de build da imagem Docker, que roda sem banco algum por perto.
 *
 * Os comandos que de fato conectam (`migrate deploy`, `migrate dev`,
 * `db push`) recebem a URL de verdade pelo ambiente. Se ela faltar ali, o erro
 * aparece na hora certa - ao tentar conectar -, e nao ao gerar o cliente.
 */
const MARCADOR = "postgresql://sabemi:sabemi@localhost:5432/sabemi?schema=vinext";

export default defineConfig({
  schema: "prisma/schema.prisma",

  datasource: {
    url: process.env.DATABASE_URL ?? MARCADOR,
  },

  migrations: {
    path: "prisma/migrations",
  },
});
