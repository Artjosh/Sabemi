/**
 * Gera as chaves `anon` e `service_role` do Supabase a partir do JWT secret.
 *
 * POR QUE ESTE SCRIPT EXISTE
 * --------------------------
 * As duas chaves nao sao valores aleatorios: sao JWTs assinados com o
 * `SUPABASE_JWT_SECRET`, carregando `role: "anon"` ou `role: "service_role"`.
 * O Kong e o PostgREST as validam com esse mesmo segredo. Trocar o segredo sem
 * regenerar as chaves quebra a plataforma inteira com um erro obscuro de
 * assinatura.
 *
 * A maioria dos tutoriais manda copiar as chaves de demonstracao do Supabase.
 * Elas sao publicas e conhecidas - servem para experimentar, nunca para um
 * ambiente que se pretende levar a serio. Este script deixa trivial gerar as
 * suas.
 *
 * Uso:
 *   node supabase/gerar-chaves.mjs                    # segredo aleatorio novo
 *   node supabase/gerar-chaves.mjs "<seu-segredo>"    # a partir de um existente
 */

import { createHmac, randomBytes } from "node:crypto";

const base64url = (entrada) =>
  Buffer.from(entrada).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function assinarJwt(payload, segredo) {
  const cabecalho = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const corpo = base64url(JSON.stringify(payload));
  const assinatura = createHmac("sha256", segredo)
    .update(`${cabecalho}.${corpo}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${cabecalho}.${corpo}.${assinatura}`;
}

// O segredo precisa de 32+ caracteres: e a exigencia do GoTrue para HS256.
const segredo = process.argv[2] ?? randomBytes(32).toString("hex");

if (segredo.length < 32) {
  console.error("O JWT secret precisa ter ao menos 32 caracteres.");
  process.exit(1);
}

const agora = Math.floor(Date.now() / 1000);
const dezAnos = agora + 60 * 60 * 24 * 365 * 10;

const anon = assinarJwt({ role: "anon", iss: "supabase", iat: agora, exp: dezAnos }, segredo);
const service = assinarJwt(
  { role: "service_role", iss: "supabase", iat: agora, exp: dezAnos },
  segredo,
);

console.log(`
# Cole no seu .env — as tres linhas andam juntas.
# Trocar o segredo sem regenerar as chaves quebra a autenticacao da plataforma.

SUPABASE_JWT_SECRET=${segredo}
SUPABASE_ANON_KEY=${anon}
SUPABASE_SERVICE_ROLE_KEY=${service}
`);
