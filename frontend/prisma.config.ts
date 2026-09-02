import { defineConfig } from "prisma/config";

// O Prisma 7 deixou de carregar `.env` sozinho. Sem isto, um comando que
// precise da URL falha com "Cannot resolve environment variable: DATABASE_URL"
// em uma maquina que nao exporte a variavel manualmente - exatamente o caso de
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
 * Configuracao do Prisma 7.
 *
 * <b>NAO ha bloco `datasource` aqui, e isso e deliberado.</b>
 *
 * O que aconteceu quando havia: `prisma generate` roda no build da imagem
 * Docker, onde nao existe `DATABASE_URL`. Para nao quebrar, a config trazia uma
 * URL de marcador. O Prisma 7 EMBUTE essa URL no cliente gerado - e o container
 * subia conectando com o usuario do marcador em vez do configurado, falhando
 * com `password authentication failed for user "sabemi"` enquanto o ambiente
 * dizia `sabemi_app`. O erro apontava para credenciais, e a causa era um
 * artefato de build.
 *
 * Sem `datasource`, `prisma generate` continua funcionando (ele so le o schema)
 * e o cliente nao carrega URL alguma. Quem define a conexao e o driver adapter,
 * em `server/bff/db.ts`, a partir do ambiente de EXECUCAO - que e onde essa
 * decisao pertence.
 *
 * Os comandos que de fato conectam recebem a URL explicitamente:
 *
 *   pnpm db:check    compara este schema com o banco (usa --to-url)
 *   pnpm db:pull     reintrospeccao (usa --url)
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
});
