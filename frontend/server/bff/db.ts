import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Cliente Prisma do backend alternativo.
 *
 * <b>Adapter explicito.</b> No Prisma 7 o cliente nao le mais a URL do schema:
 * a conexao chega por um driver adapter. Aqui e o `pg` nativo, que roda em
 * Node - o alvo de deploy escolhido para este projeto (ver `vite.config.ts`,
 * plataforma `node`).
 *
 * <b>Singleton.</b> Em desenvolvimento o HMR reavalia modulos a cada alteracao.
 * Sem guardar a instancia em `globalThis`, cada recarga abriria um novo pool de
 * conexoes e o PostgreSQL rejeitaria novas conexoes depois de alguns minutos de
 * trabalho - um erro que aparece como "too many clients" e parece nao ter causa.
 */

const globalForPrisma = globalThis as unknown as {
  __sabemiPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL nao configurada. O backend VINEXT precisa dela para acessar o schema 'vinext'.",
    );
  }

  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({
    adapter,
    // Em desenvolvimento, avisos e erros do banco no console poupam muito tempo
    // de diagnostico. Em producao, o log estruturado do host ja cobre isso.
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.__sabemiPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__sabemiPrisma = prisma;
}
