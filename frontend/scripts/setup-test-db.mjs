/**
 * Prepara o banco isolado usado pela suite de testes.
 *
 * POR QUE UM BANCO SEPARADO
 * -------------------------
 * Com a stack no ar, o container do frontend roda o laco de processamento do
 * BFF contra o schema `vinext` do banco de DESENVOLVIMENTO. Se a suite usasse o
 * mesmo banco, aquele worker reivindicaria os jobs que os testes acabaram de
 * enfileirar - e as verificacoes de fila falhariam de forma intermitente, com o
 * erro apontando para o codigo em vez de para a interferencia.
 *
 * Este script roda no `pretest`, entao `pnpm test` funciona sem passo manual.
 * Ele e idempotente: se o banco ja existe e esta migrado, nao faz nada.
 *
 * Uso direto:  pnpm db:test:setup
 */

import { execSync } from "node:child_process";
import { Client } from "pg";

const URL_PADRAO = "postgresql://sabemi:sabemi@localhost:5432/sabemi_test?schema=vinext";

// Respeita `DATABASE_URL` quando o ambiente ja a define (CI, por exemplo).
const url = new URL(process.env.DATABASE_URL ?? URL_PADRAO);
const nomeDoBanco = url.pathname.replace(/^\//, "");

/** Conecta ao banco administrativo `postgres` para poder criar o de teste. */
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

function aplicarMigrations() {
  // `execSync` com a linha ja montada: o comando e fixo e nao recebe entrada
  // externa. `execFileSync` com `shell: true` emitiria DEP0190 no Node 24.
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url.toString() },
  });
}

await garantirBanco();
aplicarMigrations();

console.log(`[setup-test-db] Pronto: ${nomeDoBanco} (schema vinext).`);
