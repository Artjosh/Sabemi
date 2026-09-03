#!/usr/bin/env node

/**
 * Verifica, de ponta a ponta, que o e-mail de acesso realmente sai.
 *
 *   node scripts/verificar-email.mjs voce@exemplo.com
 *
 * POR QUE NÃO É UM TESTE DA SUÍTE
 * -------------------------------
 * Três motivos, e cada um bastaria:
 *
 *   1. A suíte E2E ABORTA quando detecta provedor de e-mail ativo, porque ela
 *      autentica com endereços inventados e cada um viraria um hard bounce. Um
 *      teste de envio dentro dela nunca rodaria - os dois se anulam.
 *
 *   2. Não seria determinístico: depende de rede, de cota (300/dia no plano
 *      free) e de um terceiro. Um teste que falha por indisponibilidade da
 *      Brevo ensina a equipe a ignorar falhas, que é o pior que um teste pode
 *      fazer.
 *
 *   3. Tem efeito colateral irreversível. Todo push no CI mandaria e-mail de
 *      verdade para alguém.
 *
 * O QUE ELE FAZ QUE UM TESTE NÃO FARIA
 * ------------------------------------
 * Diagnostica. Um teste diria "falhou"; este script separa as quatro causas
 * possíveis - chave errada, IP não autorizado, remetente não verificado,
 * destinatário na blocklist - e diz o que fazer em cada uma. Foram exatamente
 * essas quatro que apareceram ao configurar a integração pela primeira vez, e
 * as mensagens da Brevo não deixam nenhuma delas óbvia.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BREVO = "https://api.brevo.com/v3";

/**
 * Preenchida por `main()`. Fica no escopo do módulo porque `brevo()` a usa, e
 * passá-la em cada chamada só acrescentaria ruído a um script de um arquivo.
 */
let CHAVE;

const cor = process.stdout.isTTY
  ? { ok: "[32m", erro: "[31m", info: "[36m", fraco: "[90m", fim: "[0m" }
  : { ok: "", erro: "", info: "", fraco: "", fim: "" };

const passo = (t) => console.log(`\n${cor.info}▸${cor.fim} ${t}`);
const ok = (t) => console.log(`${cor.ok}  ✓${cor.fim} ${t}`);
const nota = (t) => console.log(`${cor.fraco}    ${t}${cor.fim}`);

/**
 * Erro que já foi explicado ao usuário. O `main` o captura e sai em silêncio.
 *
 * <b>Por que não `process.exit()` aqui.</b> Sair no meio de uma chamada `fetch`
 * deixa sockets do undici abertos, e o Node no Windows dispara uma assertion do
 * libuv DEPOIS da mensagem - a última coisa na tela vira um crash em vez da
 * instrução de como resolver.
 */
class FalhaExplicada extends Error {}

function falhar(titulo, ...comoResolver) {
  console.error(`
${cor.erro}  ✗ ${titulo}${cor.fim}
`);
  for (const linha of comoResolver) console.error(`    ${linha}`);
  console.error("");
  throw new FalhaExplicada(titulo);
}

/** Lê uma variável do ambiente ou do `.env` da raiz. */
function variavel(nome) {
  if (process.env[nome]) return process.env[nome];

  const arquivo = join(RAIZ, ".env");
  if (!existsSync(arquivo)) return undefined;

  // Parsing explícito, sem expressão regular.
  //
  // A versão anterior montava a regex por interpolação
  // (`new RegExp(\`^\s*${nome}...\`)`) e não encontrava nada: dependia de dois
  // níveis de escape - o do template literal e o da regex - e um deles se
  // perdia. O sintoma era o pior possível: a variável existia no arquivo, o
  // script dizia "não configurada", e a mensagem mandava configurar de novo.
  //
  // Comparar strings não tem nível de escape nenhum.
  for (const bruta of readFileSync(arquivo, "utf8").split("\n")) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith("#")) continue;

    const igual = linha.indexOf("=");
    if (igual === -1) continue;
    if (linha.slice(0, igual).trim() !== nome) continue;

    const valor = linha.slice(igual + 1).trim().replace(/^["']|["']$/g, "");
    if (valor) return valor;
  }

  return undefined;
}

async function brevo(caminho, init = {}) {
  // `AbortController` com timer `unref()` em vez de `AbortSignal.timeout()`.
  //
  // O `timeout()` cria um temporizador que segura o event loop, e sair com
  // `process.exit()` enquanto ele vive dispara uma assertion do libuv no
  // Windows ("!(handle->flags & UV_HANDLE_CLOSING)"). O erro é cosmético, mas
  // aparece DEPOIS da mensagem de diagnóstico - e a última coisa na tela passa
  // a ser um crash em vez da instrução de como resolver.
  const controlador = new AbortController();
  const prazo = setTimeout(() => controlador.abort(), 20_000);
  prazo.unref();

  try {
    const resposta = await fetch(`${BREVO}${caminho}`, {
      ...init,
      headers: { "api-key": CHAVE, accept: "application/json", ...(init.headers ?? {}) },
      signal: controlador.signal,
    });

    const texto = await resposta.text();
    let corpo = null;
    try {
      corpo = texto ? JSON.parse(texto) : null;
    } catch {
      corpo = { message: texto };
    }

    return { status: resposta.status, ok: resposta.ok, corpo };
  } finally {
    clearTimeout(prazo);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const destinatario = process.argv[2];

  if (!destinatario || !destinatario.includes("@")) {
    falhar(
      "Informe o destinatário.",
      "node scripts/verificar-email.mjs voce@exemplo.com",
      "",
      "O endereço é obrigatório e não tem default de propósito: este script ENVIA",
      "um e-mail de verdade, e um destinatário implícito seria uma surpresa.",
    );
  }

  CHAVE = variavel("BREVO_API_KEY");

  if (!CHAVE) {
    falhar(
      "BREVO_API_KEY não configurada.",
      "Pegue em https://app.brevo.com/settings/keys/api e ponha no .env.",
      "",
      "Atenção: é a chave da API (xkeysib-), NÃO a de SMTP (xsmtpsib-).",
      "A de SMTP serve ao GoTrue e devolve 'Key not found' aqui.",
    );
  }

  if (CHAVE.startsWith("xsmtpsib-")) {
    falhar(
      "Essa é a chave de SMTP, não a da API.",
      "A API v3 precisa de uma chave que começa com `xkeysib-`.",
      "Pegue em https://app.brevo.com/settings/keys/api (aba API keys, não SMTP).",
    );
  }

  console.log(`\n${cor.info}Verificação do envio de e-mail pela Brevo${cor.fim}`);
  nota(`destinatário: ${destinatario}`);

  // ------------------------------------------------------- 1) a chave vale?

  passo("A chave é aceita pela API?");

  const conta = await brevo("/account");

  if (!conta.ok) {
    const msg = conta.corpo?.message ?? "";

    if (/unrecognised IP|unauthorised IP/i.test(msg)) {
      const ip = /(\d+\.\d+\.\d+\.\d+|[0-9a-f:]{6,})/i.exec(msg)?.[1] ?? "(veja acima)";

      falhar(
        "A chave é válida, mas o IP não está autorizado.",
        `IP recusado: ${ip}`,
        "",
        "Libere em https://app.brevo.com/security/authorised_ips",
        "",
        "Autorize o IP que aparece NESTA mensagem, não o que o navegador mostra:",
        "eles costumam ser diferentes (o navegador pode sair por IPv6 e o container",
        "pelo IPv4 público), e a Brevo trata os dois como endereços distintos.",
        "",
        "A restrição vale só para a API - o relay SMTP (GoTrue) não é afetado.",
      );
    }

    falhar(
      `A Brevo recusou a chave (HTTP ${conta.status}).`,
      `Resposta: ${msg}`,
      "",
      "Confirme que é a chave da API (xkeysib-) e que ela não foi revogada.",
    );
  }

  ok(`conta: ${conta.corpo.email}`);
  const plano = conta.corpo.plan?.[0];
  if (plano) nota(`plano ${plano.type} · ${plano.credits ?? "?"} créditos`);

  // --------------------------------------------- 2) o remetente é verificado?

  const remetente = variavel("BREVO_SENDER_EMAIL") ?? "nao-responda@sabemi.com.br";

  passo(`O remetente ${remetente} está verificado?`);

  const senders = await brevo("/senders");

  if (!senders.ok) {
    falhar(
      `Não foi possível listar os remetentes (HTTP ${senders.status}).`,
      `Resposta: ${senders.corpo?.message ?? ""}`,
    );
  }

  const lista = senders.corpo?.senders ?? [];
  const encontrado = lista.find((s) => s.email?.toLowerCase() === remetente.toLowerCase());

  if (!encontrado) {
    falhar(
      `O remetente ${remetente} não existe nesta conta.`,
      "A Brevo recusaria o envio com HTTP 400, e a mensagem dela não diz isso claramente.",
      "",
      lista.length
        ? `Remetentes disponíveis: ${lista.map((s) => s.email).join(", ")}`
        : "Não há remetente algum cadastrado.",
      "",
      "Ajuste BREVO_SENDER_EMAIL no .env, ou cadastre o endereço em",
      "https://app.brevo.com/senders",
    );
  }

  if (encontrado.active === false) {
    falhar(
      `O remetente ${remetente} existe mas está INATIVO.`,
      "Confirme o e-mail de verificação que a Brevo enviou para ele.",
    );
  }

  ok(`${remetente} está verificado e ativo`);

  // -------------------------------------- 3) o destinatário está bloqueado?

  passo("O destinatário está na blocklist?");

  const bloqueados = await brevo(
    `/smtp/blockedContacts?limit=50&senders[]=${encodeURIComponent(remetente)}`,
  );

  const bloqueado = (bloqueados.corpo?.contacts ?? []).find(
    (c) => c.email?.toLowerCase() === destinatario.toLowerCase(),
  );

  if (bloqueado) {
    falhar(
      `${destinatario} está na blocklist (${bloqueado.reason?.code ?? "?"}).`,
      "A Brevo aceita o pedido e descarta a mensagem - ela nunca chega, e o log",
      "do backend não acusa nada.",
      "",
      "Remova em https://app.brevo.com/transactional/blocked-contacts",
    );
  }

  ok("não está bloqueado");

  // ------------------------------------------------------------- 4) enviar

  passo("Enviando pela MESMA rota que os backends usam (/v3/smtp/email)…");

  const marcador = `verificacao-${Date.now()}`;

  const envio = await brevo("/smtp/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sender: {
        email: remetente,
        name: variavel("BREVO_SENDER_NAME") ?? "Sabemi",
      },
      to: [{ email: destinatario }],
      subject: "Verificação de envio — Sabemi Webhooks",
      htmlContent:
        "<p>Se esta mensagem chegou, o envio de e-mail está funcionando.</p>" +
        `<p style="color:#64748b;font-size:12px">Marcador: ${marcador}</p>`,
      textContent:
        "Se esta mensagem chegou, o envio de e-mail está funcionando.\n\n" +
        `Marcador: ${marcador}`,
      headers: { "X-Auto-Response-Suppress": "All", "Auto-Submitted": "auto-generated" },
    }),
  });

  if (!envio.ok) {
    falhar(
      `A Brevo recusou o envio (HTTP ${envio.status}).`,
      `Resposta: ${JSON.stringify(envio.corpo)}`,
      "",
      "Os três motivos acima já foram descartados, então isto é algo novo -",
      "vale ler a mensagem inteira.",
    );
  }

  const idDaMensagem = envio.corpo?.messageId;
  ok(`aceito · messageId ${idDaMensagem ?? "(sem id)"}`);

  if (!idDaMensagem) {
    // Sem o id nao ha como distinguir este envio de um anterior para o mesmo
    // endereco. Melhor parar aqui do que confirmar por semelhanca.
    console.log("");
    console.log(`${cor.ok}  ✓${cor.fim} A Brevo aceitou a mensagem.`);
    nota("Sem messageId na resposta, a entrega nao pode ser confirmada por aqui.");
    nota("Cheque a caixa e o painel: https://app.brevo.com/transactional/statistics/events");
    console.log("");
    return;
  }

  // ------------------------------------------------ 5) a Brevo entregou?

  passo("Aguardando a confirmação de entrega…");

  let entregue = false;

  // A Brevo leva de segundos a alguns minutos para registrar o evento. Sondar é
  // melhor do que um sleep fixo: entrega rápida termina rápido, e uma lenta
  // ainda é apanhada.
  //
  // 20 × 6s = 2 minutos. Trinta segundos, que era o valor anterior, expirava
  // antes de uma entrega perfeitamente normal - e a saída "não confirmou" para
  // um envio bem-sucedido é justamente o tipo de falso alarme que faz alguém
  // parar de confiar no verificador.
  for (let tentativa = 1; tentativa <= 20 && !entregue; tentativa += 1) {
    await new Promise((r) => setTimeout(r, 6000));

    // Filtrado por `messageId`, e NAO so por destinatario.
    //
    // Filtrar so pelo endereco produzia falso positivo: um `delivered` de horas
    // antes, de outro envio para a mesma pessoa, era lido como confirmacao deste.
    // O script anunciava sucesso com um horario que nao batia com o envio - e um
    // verificador que confirma o que nao aconteceu e pior do que nao ter
    // verificador.
    const eventos = await brevo(
      `/smtp/statistics/events?limit=20&sort=desc&messageId=${encodeURIComponent(
        idDaMensagem,
      )}`,
    );

    for (const e of eventos.corpo?.events ?? []) {
      if (e.event === "delivered") {
        entregue = true;
        ok(`entregue em ${e.date?.slice(0, 19) ?? "?"}`);
        break;
      }

      if (["hardBounce", "softBounce", "blocked", "error"].includes(e.event)) {
        falhar(
          `A Brevo aceitou, mas a entrega falhou: ${e.event}.`,
          `Motivo: ${e.reason ?? "(não informado)"}`,
          "",
          "O endereço existe? Um bounce o coloca na blocklist, e as próximas",
          "tentativas serão descartadas em silêncio.",
        );
      }
    }

    if (!entregue) nota(`ainda sem evento (${tentativa}/20)…`);
  }

  if (!entregue) {
    console.log("");
    console.log(`${cor.ok}  ✓${cor.fim} A Brevo ACEITOU a mensagem.`);
    nota("A confirmação de entrega não chegou em 2 minutos - isso acontece e não");
    nota("indica falha. Cheque a caixa (inclusive spam) e o painel:");
    nota("https://app.brevo.com/transactional/statistics/events");
    console.log("");
    return;
  }

  console.log("");
  console.log(`${cor.ok}O envio de e-mail está funcionando.${cor.fim}`);
  nota(`Procure o assunto "Verificação de envio — Sabemi Webhooks" em ${destinatario}.`);
  console.log("");
}

try {
  await main();
} catch (erro) {
  // Uma falha já explicada sai em silêncio: a mensagem útil foi impressa por
  // `falhar()`, e um stack trace depois dela só afastaria a instrução do fim
  // da tela. Qualquer outro erro é inesperado e merece o rastro completo.
  if (!(erro instanceof FalhaExplicada)) console.error(erro);
  process.exitCode = 1;
}
