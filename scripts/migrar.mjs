#!/usr/bin/env node

/**
 * Aplica as migrations no banco apontado por `DATABASE_URL` — local ou remoto.
 *
 * USO
 * ---
 *   node scripts/migrar.mjs                  # usa a DATABASE_URL do `.env`
 *   node scripts/migrar.mjs --url "postgresql://..."
 *   node scripts/migrar.mjs --verificar      # só confere, não aplica
 *
 * POR QUE UM SCRIPT, E NÃO `dotnet ef database update`
 * ----------------------------------------------------
 * Três coisas precisam acontecer juntas, e nessa ordem:
 *
 *   1. as migrations do EF Core (o único dono do schema) são aplicadas;
 *   2. o modelo do Prisma é conferido contra o resultado — se divergir, o
 *      backend VINEXT vai ler colunas que não existem, e o erro só apareceria
 *      em runtime, longe da causa;
 *   3. os dois passos valem igual para o Postgres do Compose e para um Supabase
 *      remoto, porque é a mesma `DATABASE_URL`.
 *
 * Chamar `dotnet ef` direto faz só o passo 1, e obriga quem trabalha no frontend
 * a ter o SDK do .NET instalado. Este script usa o SDK quando ele existe e cai
 * para `backend-dotnet/schema.sql` — gerado por
 * `dotnet ef migrations script --idempotent`, versionado e verificado no CI —
 * quando não existe.
 *
 * POR QUE NÃO HÁ MIGRATIONS DO PRISMA
 * -----------------------------------
 * Os dois backends compartilham o schema `sabemi`. Duas ferramentas emitindo DDL
 * para as mesmas tabelas produziriam divergência silenciosa: cada uma acharia
 * que é a dona, e a última a rodar venceria. O EF Core migra; o Prisma descreve.
 * O passo 2 é o que mantém a descrição honesta.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = join(RAIZ, "backend-dotnet");
const FRONTEND = join(RAIZ, "frontend");
const SCHEMA_SQL = join(BACKEND, "schema.sql");

const args = process.argv.slice(2);
const apenasVerificar = args.includes("--verificar");
const urlDoArgumento = args.includes("--url") ? args[args.indexOf("--url") + 1] : undefined;

/**
 * Forca o caminho do `schema.sql`, mesmo com o SDK do .NET instalado.
 *
 * Existe por dois motivos: permite exercitar esse caminho numa maquina que TEM o
 * SDK (senao ele so seria testado por quem nao tem, ou seja, nunca por quem o
 * mantem), e serve a quem quer aplicar o schema sem depender do .NET.
 */
const forcarSql = args.includes("--sql");

/** Cores só quando a saída é um terminal — num log de CI viram lixo. */
const cor = process.stdout.isTTY
  ? { ok: "[32m", erro: "[31m", info: "[36m", fim: "[0m" }
  : { ok: "", erro: "", info: "", fim: "" };

const passo = (texto) => console.log(`${cor.info}▸${cor.fim} ${texto}`);
const ok = (texto) => console.log(`${cor.ok}✓${cor.fim} ${texto}`);

function falhar(texto, detalhe) {
  console.error(`\n${cor.erro}✗${cor.fim} ${texto}\n`);
  if (detalhe) console.error(`${detalhe}\n`);
  process.exit(1);
}

/**
 * Descobre a URL de conexão.
 *
 * A precedência coloca o ambiente ANTES do `.env`: no CI e no container não há
 * arquivo, e num shell onde alguém exportou a variável de propósito ela deve
 * vencer o arquivo — o contrário faria o script ignorar um `export` explícito.
 */
function descobrirUrl() {
  if (urlDoArgumento) return { url: urlDoArgumento, origem: "--url" };
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, origem: "ambiente" };

  const arquivo = join(RAIZ, ".env");
  if (existsSync(arquivo)) {
    // Parsing explícito, sem expressão regular.
    //
    // A versão anterior usava `/^\s*DATABASE_URL\s*=\s*(.*)$/` e NUNCA leu o
    // `.env` no Windows. A causa é sutil: o arquivo tem CRLF, e em JavaScript
    // o `.` não casa `\r` (assim como não casa `\n`). Depois do `split("\n")`
    // sobra um `\r` no fim da linha que `(.*)` não consome e `$` não alcança -
    // então a regex simplesmente não casava.
    //
    // O sintoma era silencioso e enganoso: a variável estava no arquivo, o
    // script caía no default e anunciava `origem: padrão de desenvolvimento`.
    // Quem apontasse o `.env` para um Supabase remoto migraria o banco LOCAL
    // achando que tinha migrado o remoto.
    for (const bruta of readFileSync(arquivo, "utf8").split("\n")) {
      const linha = bruta.trim();
      if (!linha || linha.startsWith("#")) continue;

      const igual = linha.indexOf("=");
      if (igual === -1) continue;
      if (linha.slice(0, igual).trim() !== "DATABASE_URL") continue;

      const valor = linha
        .slice(igual + 1)
        .trim()
        .replace(/^["']|["']$/g, "");

      if (valor) return { url: valor, origem: ".env" };
    }
  }

  // O default do `docker-compose.yml`, mas com `localhost`: quem roda ESTE script
  // está fora da rede do Compose, onde o nome `postgres` não resolve.
  return {
    url: "postgresql://sabemi_app:sabemi@localhost:5432/postgres",
    origem: "padrão de desenvolvimento",
  };
}

/** Esconde a senha antes de imprimir. */
function mascarar(url) {
  return url.replace(/\/\/([^:/@]+):([^@]+)@/, "//$1:***@");
}

/** O host é local? Decide o aviso de "você está mexendo em produção". */
function ehLocal(url) {
  try {
    const host = new URL(url).hostname;
    return ["localhost", "127.0.0.1", "::1", "postgres", "db", "supabase-db"].includes(host);
  } catch {
    return false;
  }
}

/** O comando existe no PATH? */
function existeComando(comando, ...argumentos) {
  const r = spawnSync(comando, argumentos, { stdio: "ignore" });
  return r.status === 0;
}

// ---------------------------------------------------------------------------

const { url, origem } = descobrirUrl();

console.log("");
passo(`Banco:  ${mascarar(url)}`);
passo(`Origem: ${origem}`);

if (!ehLocal(url)) {
  // Um script de migration apontado sem perceber para o banco de produção é o
  // tipo de acidente que não tem desfazer. O aviso não bloqueia - só garante que
  // apareça no scrollback de quem rodou.
  console.log(
    `\n${cor.erro}!${cor.fim} Este host NÃO é local. As migrations serão aplicadas em um banco remoto.\n`,
  );
}

// ---------------------------------------------------------- 1) EF Core

if (!apenasVerificar) {
  const temSdk = !forcarSql && existeComando("dotnet", "--version");

  if (temSdk) {
    passo("Aplicando as migrations com o EF Core (dotnet ef)…");

    // `dotnet tool restore` antes: o `dotnet-ef` é uma ferramenta LOCAL
    // (backend-dotnet/.config/dotnet-tools.json), e sem restaurar o comando não
    // existe - com uma mensagem que sugere instalar globalmente, o que criaria
    // divergência de versão entre máquinas.
    try {
      execFileSync("dotnet", ["tool", "restore"], { cwd: BACKEND, stdio: "inherit" });

      execFileSync(
        "dotnet",
        [
          "ef", "database", "update",
          "--project", "src/Sabemi.Infrastructure",
          "--startup-project", "src/Sabemi.Infrastructure",
        ],
        {
          cwd: BACKEND,
          stdio: "inherit",
          // A fábrica de design-time lê esta variável. É a mesma que os dois
          // backends usam em execução.
          env: { ...process.env, DATABASE_URL: url },
        },
      );

      ok("Migrations aplicadas.");
    } catch {
      falhar(
        "O `dotnet ef database update` falhou.",
        "Veja a saída acima. Causas comuns: banco inacessível, credencial sem\n" +
          "permissão de DDL, ou (num Supabase remoto) uso da porta 6543 do pooler,\n" +
          "que não suporta migration - use a 5432.",
      );
    }
  } else {
    // Caminho de quem não tem o SDK do .NET: o script SQL idempotente gerado a
    // partir das mesmas migrations. O CI verifica que ele está atualizado, então
    // não pode divergir em silêncio.
    passo(
      forcarSql
        ? "Aplicando `backend-dotnet/schema.sql` (--sql)…"
        : "SDK do .NET ausente; aplicando `backend-dotnet/schema.sql`…",
    );

    if (!existsSync(SCHEMA_SQL)) {
      falhar(
        "backend-dotnet/schema.sql não encontrado.",
        "Gere com:\n" +
          "  cd backend-dotnet && dotnet tool restore && dotnet ef migrations script \\\n" +
          "    --idempotent --project src/Sabemi.Infrastructure \\\n" +
          "    --startup-project src/Sabemi.Infrastructure --output schema.sql",
      );
    }

    // O `pg` vive em frontend/node_modules, e a raiz não tem package.json - daí
    // o `createRequire` a partir do package.json do frontend.
    //
    // Um caminho literal (`node_modules/pg/lib/index.js`) NÃO funciona: o pnpm
    // guarda os pacotes em `node_modules/.pnpm/pg@8.23.0/node_modules/pg` e liga
    // por symlink, com a VERSÃO no caminho. Resolver pelo require encontra o
    // pacote sem que este script saiba nada disso.
    let Client;
    try {
      const exigir = createRequire(join(FRONTEND, "package.json"));
      ({ Client } = exigir("pg"));
    } catch {
      falhar(
        "O driver `pg` não foi encontrado.",
        "Instale as dependências do frontend primeiro:\n  cd frontend && pnpm install",
      );
    }

    // O BOM que o `dotnet ef` escreve no início do arquivo faz o PostgreSQL
    // recusar o primeiro comando.
    const sql = readFileSync(SCHEMA_SQL, "utf8").replace(/^﻿/, "");

    const cliente = new Client({ connectionString: url });
    try {
      await cliente.connect();
      await cliente.query(sql);
      ok("Schema aplicado (script idempotente).");
    } catch (erro) {
      falhar("Falha ao aplicar o schema.", String(erro));
    } finally {
      await cliente.end().catch(() => {});
    }
  }
}

// ------------------------------------------------- 2) drift do Prisma

passo("Conferindo o modelo do Prisma contra o banco…");

// O CLI do Prisma é invocado pelo NODE, e não por `npx`.
//
// `npx` no Windows é um `.cmd`, que só executa com `shell: true` - e passar
// argumentos com shell ligado dispara DEP0190, porque eles são concatenados sem
// escape. Chamar o entrypoint com o mesmo `node` que roda este script evita as
// duas coisas, e garante que a versão usada é a do lockfile do projeto, e não
// qualquer uma que o `npx` decida baixar.
const prismaCli = (() => {
  try {
    const exigir = createRequire(join(FRONTEND, "package.json"));
    // O pacote não expõe um `main` resolvível por `require.resolve("prisma")`,
    // então o entrypoint do CLI é montado a partir do package.json dele.
    return join(dirname(exigir.resolve("prisma/package.json")), "build/index.js");
  } catch {
    falhar(
      "O CLI do Prisma não foi encontrado.",
      "Instale as dependências do frontend primeiro:\n  cd frontend && pnpm install",
    );
  }
})();

const diff = spawnSync(
  process.execPath,
  [
    prismaCli,
    "migrate", "diff",
    "--config", "prisma.config.diff.ts",
    "--from-schema", "prisma/schema.prisma",
    "--to-config-datasource",
    "--exit-code",
  ],
  {
    cwd: FRONTEND,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
  },
);

if (diff.status === 0) {
  ok("O modelo do Prisma corresponde ao banco.");
} else if (diff.status === 2) {
  falhar(
    "O modelo do Prisma DIVERGE do banco.",
    (diff.stdout ?? "") +
      "\nO EF Core é o dono do schema; o Prisma apenas o descreve. Alinhe\n" +
      "`frontend/prisma/schema.prisma` com o que as migrations criaram, ou rode\n" +
      "`cd frontend && pnpm db:pull` para reintrospectar.",
  );
} else {
  falhar("Não foi possível comparar o schema.", (diff.stderr ?? "") + (diff.stdout ?? ""));
}

console.log("");
ok(apenasVerificar ? "Verificação concluída." : "Banco pronto para os dois backends.");
console.log("");
