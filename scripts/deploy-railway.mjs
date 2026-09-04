#!/usr/bin/env node
/**
 * Dispara o deploy dos serviços do Railway pela API GraphQL.
 *
 * POR QUE ISTO EXISTE, SE O RAILWAY JÁ FAZ AUTO-DEPLOY
 * ----------------------------------------------------
 * O auto-deploy nativo do Railway depende de duas ligações separadas: o
 * **Railway GitHub App** instalado no repositório, e o **vínculo OAuth** entre a
 * conta do Railway e a conta do GitHub. A segunda não existe quando alguém cria
 * a conta do Railway por e-mail — e aí o Railway até clona o repositório (se for
 * público) e constrói, mas não consegue assinar os eventos de push. O sintoma é
 * "GitHub Repo not found" na tela do serviço, e a API recusa criar o gatilho com
 * "no one in the project has access to it".
 *
 * Este script inverte a direção: em vez de o Railway observar o GitHub, é o
 * GitHub Actions que avisa o Railway. Funciona com um único segredo
 * (`RAILWAY_TOKEN`) e não depende de vínculo nenhum entre as duas contas.
 *
 * O TOKEN
 * -------
 * Um token de workspace, criado em railway.com/account/tokens. Ele NÃO responde
 * às consultas de conta (`me`, `githubRepos`) — só ao que pertence ao workspace,
 * que é justamente o que este script precisa.
 *
 * USO
 * ---
 *   RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... node scripts/deploy-railway.mjs
 *
 * Opcional: `RAILWAY_ENVIRONMENT_NAME` (padrão `production`) e
 * `RAILWAY_SERVICES` (padrão: todos os serviços do ambiente).
 */

const API = "https://backboard.railway.com/graphql/v2";

const TOKEN = process.env.RAILWAY_TOKEN;
const PROJECT = process.env.RAILWAY_PROJECT_ID;
const AMBIENTE = process.env.RAILWAY_ENVIRONMENT_NAME ?? "production";
const COMMIT = process.env.GITHUB_SHA ?? null;

if (!TOKEN || !PROJECT) {
  console.error(
    "[railway] RAILWAY_TOKEN e RAILWAY_PROJECT_ID são obrigatórios.\n" +
      "          Configure-os como segredos do repositório.",
  );
  process.exit(1);
}

/** Uma chamada GraphQL. Erros do Railway chegam em `errors`, com HTTP 200. */
async function gql(query, variables) {
  const resposta = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  const corpo = await resposta.json();

  if (corpo.errors) {
    const msg = corpo.errors.map((e) => e.message).join("; ");
    throw new Error(`Railway recusou: ${msg}`);
  }

  return corpo.data;
}

const dados = await gql(
  `query ($id: String!) {
     project(id: $id) {
       name
       environments { edges { node { id name } } }
       services { edges { node { id name } } }
     }
   }`,
  { id: PROJECT },
);

const projeto = dados.project;
const ambiente = projeto.environments.edges
  .map((e) => e.node)
  .find((n) => n.name === AMBIENTE);

if (!ambiente) {
  console.error(`[railway] Ambiente "${AMBIENTE}" não existe em ${projeto.name}.`);
  process.exit(1);
}

const filtro = process.env.RAILWAY_SERVICES?.split(",").map((s) => s.trim()).filter(Boolean);
const servicos = projeto.services.edges
  .map((e) => e.node)
  .filter((s) => !filtro?.length || filtro.includes(s.name));

if (servicos.length === 0) {
  console.error("[railway] Nenhum serviço a implantar.");
  process.exit(1);
}

console.log(`[railway] ${projeto.name} / ${AMBIENTE}: ${servicos.map((s) => s.name).join(", ")}`);

let falhas = 0;

for (const servico of servicos) {
  try {
    // `latestCommit: true` importa: sem ele o Railway REIMPLANTA o commit que já
    // estava no ar, e o deploy "passa" rodando o código antigo - uma falha que
    // não dá erro nenhum e leva um bom tempo para ser notada.
    await gql(
      `mutation ($s: String!, $e: String!, $c: String) {
         serviceInstanceDeploy(serviceId: $s, environmentId: $e, commitSha: $c, latestCommit: true)
       }`,
      { s: servico.id, e: ambiente.id, c: COMMIT },
    );
    console.log(`[railway]   ${servico.name}: deploy disparado`);
  } catch (erro) {
    falhas += 1;
    console.error(`[railway]   ${servico.name}: ${erro.message}`);
  }
}

if (falhas > 0) {
  console.error(`[railway] ${falhas} serviço(s) falharam.`);
  process.exit(1);
}

console.log("[railway] Todos os deploys foram disparados.");
