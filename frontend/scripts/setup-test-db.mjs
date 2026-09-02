/**
 * Prepara o banco isolado usado pela suite de testes.
 *
 * POR QUE UM BANCO SEPARADO
 * -------------------------
 * Com a stack no ar, o container do frontend roda o laco de processamento do
 * BFF contra o schema `sabemi` do banco de DESENVOLVIMENTO. Se a suite usasse o
 * mesmo banco, aquele worker reivindicaria os jobs que os testes acabaram de
 * enfileirar - e as verificacoes de fila falhariam de forma intermitente, com o
 * erro apontando para o codigo em vez de para a interferencia.
 *
 * POR QUE UM SCRIPT SQL, E NAO `prisma migrate`
 * ---------------------------------------------
 * Os dois backends compartilham o schema `sabemi`, e quem e dono das migrations
 * e o EF Core - o Prisma apenas descreve o mesmo modelo para poder consultar
 * (ver prisma/schema.prisma). Entao quem cria as tabelas do banco de teste
 * tambem precisa ser o EF Core.
 *
 * Chamar `dotnet ef` daqui obrigaria quem trabalha no frontend a ter o SDK do
 * .NET instalado. Em vez disso, o pipeline versiona `backend-dotnet/schema.sql`
 * - gerado por `dotnet ef migrations script --idempotent` - e este script o
 * aplica. O CI regenera e compara, entao ele nao pode ficar desatualizado.
 *
 * Roda no `pretest`, entao `pnpm test` funciona sem passo manual, e e
 * idempotente: com o banco ja criado e migrado, nao faz nada.
 *
 * Uso direto:  pnpm db:test:setup
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = resolve(AQUI, "../../backend-dotnet/schema.sql");

const URL_PADRAO = "postgresql://sabemi_app:sabemi@localhost:5432/sabemi_test";

// Respeita `DATABASE_URL` quando o ambiente ja a define (CI, por exemplo).
const url = new URL(process.env.DATABASE_URL ?? URL_PADRAO);
const nomeDoBanco = url.pathname.replace(/^\//, "");

/** Conecta ao banco administrativo para poder criar o de teste. */
function urlAdministrativa() {
  const admin = new URL(url.toString());
  admin.pathname = "/postgres";
  admin.search = "";
  return admin.toString();
}

async function garantirBanco() {
  const cliente = new Client({ connectionString: urlAdministrativa() });

  try {
    await cliente.connect();
  } catch (erro) {
    console.error(
      `\n[setup-test-db] Nao foi possivel conectar ao PostgreSQL em ${url.host}.\n` +
        `Suba o banco com:  docker compose up -d postgres\n`,
    );
    throw erro;
  }

  try {
    const { rowCount } = await cliente.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [nomeDoBanco],
    );

    if (rowCount === 0) {
      // O nome vem da nossa propria URL, nao de entrada externa; ainda assim e
      // interpolado com aspas para o caso de conter maiusculas ou hifen.
      await cliente.query(`CREATE DATABASE "${nomeDoBanco}"`);
      console.log(`[setup-test-db] Banco "${nomeDoBanco}" criado.`);
    }
  } finally {
    await cliente.end();
  }
}

async function aplicarSchema() {
  let sql;
  try {
    // O BOM que o `dotnet ef` escreve no inicio do arquivo faz o PostgreSQL
    // recusar o primeiro comando; removido aqui.
    sql = readFileSync(SCHEMA_SQL, "utf8").replace(/^﻿/, "");
  } catch {
    console.error(
      `\n[setup-test-db] ${SCHEMA_SQL} nao encontrado.\n` +
        `Gere com:  cd backend-dotnet && dotnet ef migrations script --idempotent ` +
        `--project src/Sabemi.Infrastructure --output schema.sql\n`,
    );
    throw new Error("schema.sql ausente");
  }

  const cliente = new Client({ connectionString: url.toString() });
  await cliente.connect();

  try {
    // O script e idempotente (`--idempotent`): aplica so o que falta.
    await cliente.query(sql);
  } finally {
    await cliente.end();
  }
}

await garantirBanco();
await aplicarSchema();

console.log(`[setup-test-db] Pronto: ${nomeDoBanco} (schema sabemi).`);
