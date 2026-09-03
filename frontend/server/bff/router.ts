import type { ProblemDetails, ProcessingStatus } from "@/lib/contracts";
import { PROCESSING_STATUSES } from "@/lib/contracts";

import { bffConfig } from "./config";
import { verifySessionToken } from "./crypto";
import type { AuthFailure } from "./auth-service";
import {
  aprovarComTokenDoProvedor,
  confirmMagicLink,
  getUserById,
  pollLoginStatus,
  startLogin,
  verifyOtp,
} from "./auth-service";
import {
  authenticateWebhook,
  getContract,
  getPaymentDetail,
  getSummary,
  ingestPayment,
  listPayments,
} from "./payments-service";
import { ensureWorkerStarted } from "./processing-service";
import { reenfileirar } from "./requeue-service";
import { iniciarTelemetria } from "./telemetry-setup";

/**
 * Roteador do backend VINEXT.
 *
 * <b>Por que um roteador proprio, e nao um arquivo de rota por endpoint.</b>
 * Este backend precisa ser alcancavel de duas maneiras:
 *
 *   1. por HTTP, em `/api/bff/*` - e como o banco parceiro entrega o webhook e
 *      como se demonstra o backend isoladamente;
 *   2. por chamada direta em processo, a partir do gateway, quando o operador
 *      seleciona "VINEXT" no seletor de backend.
 *
 * Concentrando o despacho aqui, os dois caminhos executam exatamente o mesmo
 * codigo. Se cada endpoint fosse um route handler, o caminho em processo teria
 * de reimplementa-los ou dar uma volta pela rede falando consigo mesmo - e as
 * duas opcoes criam formas de os dois divergirem.
 *
 * A resposta e um objeto simples (`status` + `body`) em vez de um `Response`:
 * assim o gateway a repassa sem serializar e desserializar de novo, e os testes
 * inspecionam o corpo sem precisar de um servidor no ar.
 */

export interface BffRequest {
  method: string;
  /** Caminho ja sem o prefixo, ex.: `payments`, `webhooks/pagamento`. */
  path: string;
  searchParams: URLSearchParams;
  /** Corpo bruto - preservado porque a assinatura HMAC e calculada sobre ele. */
  rawBody: string;
  headers: Headers;
  /** JWT da sessao, injetado pelo gateway a partir do cookie httpOnly. */
  token: string | null;
}

export interface BffResponse {
  status: number;
  body: unknown;
  /** Preenchido pelas respostas HTML (a pagina de confirmacao do link). */
  contentType?: string;
}

function problem(status: number, detail: string, code?: string, errors?: Record<string, string[]>): BffResponse {
  const body: ProblemDetails = { detail, ...(code ? { code } : {}), ...(errors ? { errors } : {}) };
  return { status, body };
}

const UNAUTHORIZED = () => problem(401, "Sessao ausente ou expirada.", "unauthorized");

/**
 * Despacha uma requisicao para o handler correspondente.
 *
 * Envolve o despacho num tratamento de erro global, equivalente ao
 * `ExceptionHandlingMiddleware` do backend .NET. Sem ele, uma excecao nao
 * tratada subia ate o runtime do VINEXT e virava um 500 SEM CORPO E SEM LOG -
 * o pior modo de falha possivel para diagnosticar, porque nao ha o que ler nem
 * no cliente nem no servidor.
 */
export async function handleBffRequest(request: BffRequest): Promise<BffResponse> {
  try {
    return await despachar(request);
  } catch (erro) {
    const correlacao = crypto.randomUUID();

    console.error(
      `[bff] Excecao nao tratada em ${request.method} /${request.path}. ` +
        `Correlacao: ${correlacao}`,
      erro,
    );

    // Em producao o cliente recebe apenas a correlacao: a mensagem original
    // pode carregar nome de tabela, caminho de arquivo ou string de conexao.
    const detalhe = bffConfig.isProduction
      ? `Erro interno. Informe a correlacao ${correlacao} ao suporte.`
      : erro instanceof Error
        ? erro.message
        : String(erro);

    return problem(500, detalhe, "internal_error");
  }
}

async function despachar(request: BffRequest): Promise<BffResponse> {
  // O laco de processamento e a telemetria sobem junto com o primeiro uso do
  // backend. Nao ha um "processo de inicializacao" separado num servidor Node
  // sob demanda - as duas funcoes sao idempotentes e retornam de imediato a
  // partir da segunda chamada.
  ensureWorkerStarted();
  iniciarTelemetria();

  const path = request.path.replace(/^\/+|\/+$/g, "");
  const method = request.method.toUpperCase();

  // ---------------------------------------------------------------- health
  if (path === "health" && method === "GET") {
    return {
      status: 200,
      body: {
        status: "healthy",
        // O dashboard usa este campo para confirmar, na tela, qual
        // implementacao esta de fato respondendo depois de uma troca.
        backend: "vinext",
        version: "1.0.0",
        environment: bffConfig.isProduction ? "Production" : "Development",

        // Ha provedor de e-mail configurado? Um booleano em forma de rotulo, e
        // nao a chave nem o remetente: quem consulta precisa saber SE envia, nao
        // com o que.
        //
        // Existe para a suite ponta a ponta poder decidir se roda. Ela autentica
        // com enderecos inventados, e com provedor ativo cada login vira um hard
        // bounce na conta - 26 deles aconteceram antes de isto existir. A
        // alternativa seria descobrir enviando, o que e autodestrutivo: para
        // saber se envia, envia.
        email_provider: bffConfig.brevo.apiKey ? "brevo" : "none",
      },
    };
  }

  // --------------------------------------------------------------- webhook
  if (path === "webhooks/pagamento" && method === "POST") {
    return handleWebhook(request);
  }

  // ------------------------------------------------------------------ auth
  if (path === "auth/magic-link" && method === "POST") {
    const body = safeJson(request.rawBody);
    const resultado = await startLogin((body as { email?: unknown })?.email);

    return resultado.ok
      ? { status: 200, body: resultado.value }
      : problem(400, resultado.message, "invalid_email");
  }

  if (path === "auth/confirm" && method === "GET") {
    const ok = await confirmMagicLink(request.searchParams.get("token"));
    return {
      status: ok ? 200 : 400,
      body: renderConfirmationPage(ok),
      contentType: "text/html; charset=utf-8",
    };
  }

  // ------------------------------------------------- modo Supabase
  //
  // Estas duas rotas existem apenas quando AUTH_PROVIDER=supabase. No modo local
  // a aprovacao falha - o provedor local devolve `null` na validacao de token
  // externo - e a pagina mostra "link invalido", que e o correto: aquele link
  // nao pertence a este fluxo.
  if (path === "auth/supabase/confirm" && method === "GET") {
    // A pagina precisa de JavaScript porque o GoTrue devolve o token no
    // FRAGMENTO da URL, que nao e enviado ao servidor - e essa a razao de ele
    // ser usado para credenciais. So o navegador o ve.
    return {
      status: 200,
      body: renderSupabaseConfirmationPage(request.searchParams.get("selector") ?? ""),
      contentType: "text/html; charset=utf-8",
    };
  }

  if (path === "auth/supabase/aprovar" && method === "POST") {
    const body = safeJson(request.rawBody) as
      | { selector?: unknown; access_token?: unknown }
      | null;

    const aprovado = await aprovarComTokenDoProvedor(body?.selector, body?.access_token);

    // 401 para tudo que nao passa, sem distinguir "selector inexistente" de
    // "token invalido" ou "e-mail divergente": essa granularidade so ajudaria
    // quem esta sondando.
    return aprovado
      ? { status: 204, body: null }
      : problem(401, "Nao foi possivel confirmar este acesso.", "supabase_approval_failed");
  }

  if (path === "auth/verify-otp" && method === "POST") {
    const body = safeJson(request.rawBody) as { selector?: unknown; code?: unknown } | null;
    const resultado = await verifyOtp(body?.selector, body?.code);

    if (resultado.ok) return { status: 200, body: resultado.value };

    return problem(
      statusAuth(resultado.failure),
      resultado.message,
      mapAuthCode(resultado.failure),
    );
  }

  if (path === "auth/login-status" && method === "POST") {
    // O selector chega pela query string (igual ao backend .NET) e tambem e
    // aceito no corpo, para o cliente poder escolher.
    const body = safeJson(request.rawBody) as { selector?: unknown } | null;
    const selector = request.searchParams.get("selector") ?? body?.selector;

    const resultado = await pollLoginStatus(selector);

    return resultado.ok
      ? { status: 200, body: resultado.value }
      : problem(404, resultado.message, "login_request_not_found");
  }

  if (path === "auth/me" && method === "GET") {
    const claims = await requireSession(request);
    if (!claims) return UNAUTHORIZED();

    const user = await getUserById(claims.sub);
    return user
      ? { status: 200, body: user }
      : problem(401, "Usuario nao encontrado.", "user_not_found");
  }

  // -------------------------------------------------------------- payments
  if (path === "payments" && method === "GET") {
    const claims = await requireSession(request);
    if (!claims) return UNAUTHORIZED();

    const page = await listPayments({
      status: parseStatus(request.searchParams.get("status")),
      contractId: emptyToNull(request.searchParams.get("contractId")),
      page: parseIntOr(request.searchParams.get("page"), 1),
      pageSize: parseIntOr(request.searchParams.get("pageSize"), 20),
    });

    return { status: 200, body: page };
  }

  if (path === "payments/summary" && method === "GET") {
    const claims = await requireSession(request);
    if (!claims) return UNAUTHORIZED();

    return { status: 200, body: await getSummary() };
  }

  // Antes da rota GET generica de `payments/`: aquela captura qualquer sufixo,
  // entao uma rota mais especifica precisa vir primeiro para ser alcancada.
  if (path.startsWith("payments/") && path.endsWith("/reenfileirar") && method === "POST") {
    const claims = await requireSession(request);
    if (!claims) return UNAUTHORIZED();

    const idTransacao = decodeURIComponent(
      path.slice("payments/".length, -"/reenfileirar".length),
    );

    const resultado = await reenfileirar(idTransacao);

    if (resultado.ok) {
      return { status: 200, body: resultado.value };
    }

    // 409, e nao 400: o pedido esta correto; o que impede e o ESTADO atual do
    // evento. Um 400 mandaria quem chama procurar erro no proprio pedido - e a
    // mensagem do 409 e justamente o que o painel mostra ao operador.
    return resultado.failure === "not_found"
      ? problem(404, resultado.message, "payment_event_not_found")
      : problem(409, resultado.message, "requeue_not_allowed");
  }

  if (path.startsWith("payments/") && method === "GET") {
    const claims = await requireSession(request);
    if (!claims) return UNAUTHORIZED();

    const idTransacao = decodeURIComponent(path.slice("payments/".length));
    const detalhe = await getPaymentDetail(idTransacao);

    return detalhe
      ? { status: 200, body: detalhe }
      : problem(404, "Evento nao encontrado.", "payment_event_not_found");
  }

  if (path.startsWith("contracts/") && method === "GET") {
    const claims = await requireSession(request);
    if (!claims) return UNAUTHORIZED();

    const idContrato = decodeURIComponent(path.slice("contracts/".length));
    const contrato = await getContract(idContrato);

    return contrato
      ? { status: 200, body: contrato }
      : problem(404, "Contrato nao encontrado.", "contract_not_found");
  }

  return problem(404, `Rota nao encontrada: ${method} /${path}`, "route_not_found");
}

async function handleWebhook(request: BffRequest): Promise<BffResponse> {
  const auth = authenticateWebhook(
    request.headers.get("x-api-key"),
    request.headers.get("x-signature"),
    request.rawBody,
  );

  // Autenticacao falha nao persiste nada: gravar o que chega de qualquer origem
  // nao autenticada transformaria a tabela de auditoria em alvo de enchimento.
  if (!auth.ok) {
    if (auth.reason === "invalid_api_key") {
      return problem(401, "Credencial invalida.", "invalid_api_key");
    }
    if (auth.reason === "missing_signature") {
      return problem(403, "Header X-Signature obrigatorio.", "missing_signature");
    }
    return problem(403, "Assinatura invalida para o corpo recebido.", "invalid_signature");
  }

  const resultado = await ingestPayment(request.rawBody, auth.signatureVerified);

  // O codigo de resposta carrega significado: 202 aceito e enfileirado, 200 ja
  // conhecido (nada reprocessado), 400 invalido mas registrado.
  if (resultado.kind === "accepted") return { status: 202, body: resultado.ack };
  if (resultado.kind === "duplicate") return { status: 200, body: resultado.ack };

  return problem(
    400,
    resultado.ack.message ?? "Payload invalido.",
    "validation_failed",
    resultado.errors,
  );
}

async function requireSession(request: BffRequest) {
  return request.token ? verifySessionToken(request.token) : null;
}

function mapAuthCode(failure: AuthFailure): string {
  switch (failure) {
    case "not_found":
      return "login_request_not_found";
    case "too_many_attempts":
      return "too_many_attempts";
    case "invalid_email":
      return "invalid_email";
    case "provider_unavailable":
      return "identity_provider_unavailable";
    default:
      return "invalid_code";
  }
}

/**
 * Status HTTP de uma falha de autenticacao.
 *
 * Os mesmos do backend .NET (AuthEndpoints). O 503 importa: o cliente nao errou
 * nada quando o provedor de identidade esta fora do ar, e um 400 mandaria quem
 * chama procurar erro no proprio pedido - com a UI dizendo "codigo incorreto"
 * para um codigo que pode estar perfeitamente certo.
 */
function statusAuth(failure: AuthFailure): number {
  switch (failure) {
    case "not_found":
      return 404;
    case "too_many_attempts":
      return 429;
    case "provider_unavailable":
      return 503;
    default:
      return 400;
  }
}

function safeJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Um `status` desconhecido vira "sem filtro" em vez de erro.
 *
 * Para uma tela de consulta, degradar para um resultado util e melhor do que
 * devolver 400 por causa de um parametro de URL digitado errado.
 */
function parseStatus(value: string | null): ProcessingStatus | null {
  if (!value) return null;
  const upper = value.toUpperCase() as ProcessingStatus;
  return PROCESSING_STATUSES.includes(upper) ? upper : null;
}

function emptyToNull(value: string | null): string | null {
  return value && value.trim() !== "" ? value.trim() : null;
}

function parseIntOr(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Pagina mostrada depois de clicar o link do e-mail.
 *
 * HTML e nao JSON porque quem a abre e um navegador vindo do aplicativo de
 * e-mail, possivelmente em outro aparelho. A unica informacao necessaria e
 * "pode voltar para a outra aba" - a aba de origem entra sozinha no proximo
 * ciclo de polling.
 */
function renderConfirmationPage(ok: boolean): string {
  const cor = ok ? "#16a34a" : "#dc2626";
  const icone = ok ? "&#10003;" : "&#10007;";
  const titulo = ok ? "Acesso confirmado" : "Link invalido";
  const mensagem = ok
    ? "Pode voltar para a aba onde voce iniciou o login. Ela entrara sozinha em alguns segundos."
    : "Este link expirou ou ja foi utilizado. Solicite um novo acesso.";

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sabemi - Acesso</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #0f172a; color: #e2e8f0;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .card {
      max-width: 26rem; padding: 2.5rem 2rem; border-radius: 1rem; text-align: center;
      background: #1e293b; border: 1px solid #334155;
    }
    .badge {
      width: 3.5rem; height: 3.5rem; border-radius: 999px; margin: 0 auto 1.25rem;
      display: grid; place-items: center; font-size: 1.75rem; font-weight: 700;
      background: ${cor}22; color: ${cor};
    }
    h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
    p { color: #94a3b8; line-height: 1.6; margin: 0; font-size: .95rem; }
    .tag {
      display:inline-block; margin-top:1.25rem; padding:.25rem .625rem; border-radius:999px;
      background:#334155; color:#cbd5e1; font-size:.7rem; letter-spacing:.05em; text-transform:uppercase;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${icone}</div>
    <h1>${titulo}</h1>
    <p>${mensagem}</p>
    <span class="tag">Backend VINEXT</span>
  </div>
</body>
</html>`;
}

/**
 * Pagina que o GoTrue abre depois de validar o magic link (modo Supabase).
 *
 * <b>Espelho de `Sabemi.Api/Endpoints/SupabaseConfirmationPage.cs`.</b>
 *
 * <b>Por que existe uma pagina, e nao um redirect direto.</b> O GoTrue devolve o
 * token de acesso no FRAGMENTO da URL (`#access_token=...`), e fragmento nao e
 * enviado ao servidor - e essa a razao de ele ser usado para credenciais. So o
 * navegador o ve. Entao a pagina le o fragmento, o envia por POST, e o servidor
 * valida o token contra o GoTrue antes de aprovar o pedido.
 *
 * <b>Alternativa considerada.</b> O fluxo PKCE entrega o codigo na QUERY, o que
 * dispensaria JavaScript - mas exigiria guardar um `code_verifier` por pedido,
 * com mais uma coluna e mais um estado a expirar. Para um alvo de redirect que
 * sempre roda em um navegador, o custo nao se justifica.
 *
 * <b>O que ela apaga.</b> O fragmento sai da barra de enderecos com
 * `history.replaceState`. Sem isso, o token ficaria no historico do aparelho -
 * que costuma ser o celular de alguem, as vezes compartilhado.
 */
function renderSupabaseConfirmationPage(selector: string): string {
  // `JSON.stringify` produz o literal COM as aspas e com todo escape necessario.
  // Concatenar com aspas simples seria uma injecao de script esperando um
  // selector com `'` dentro.
  const selectorJs = JSON.stringify(selector);

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sabemi - Acesso</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #0f172a; color: #e2e8f0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
    }
    .card {
      max-width: 26rem; padding: 2.5rem 2rem; border-radius: 1rem; text-align: center;
      background: #1e293b; border: 1px solid #334155;
    }
    .badge {
      width: 3.5rem; height: 3.5rem; border-radius: 999px; margin: 0 auto 1.25rem;
      display: grid; place-items: center; font-size: 1.75rem; font-weight: 700;
    }
    .aguardando { background: #1d4ed822; color: #60a5fa; }
    .ok         { background: #16a34a22; color: #16a34a; }
    .erro       { background: #dc262622; color: #dc2626; }
    h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
    p { color: #94a3b8; line-height: 1.6; margin: 0; font-size: .95rem; }
    .tag {
      display: inline-block; margin-top: 1.5rem; padding: .25rem .625rem;
      border-radius: 999px; font-size: .6875rem; letter-spacing: .04em;
      text-transform: uppercase; background: #0f766e22; color: #2dd4bf;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge aguardando" id="badge">&hellip;</div>
    <h1 id="titulo">Confirmando o acesso</h1>
    <p id="mensagem">Um instante.</p>
    <span class="tag">Backend VINEXT</span>
  </div>

  <script>
    (function () {
      var selector = ${selectorJs};

      function mostrar(estado, titulo, mensagem) {
        var badge = document.getElementById("badge");
        badge.className = "badge " + estado;
        badge.innerHTML = estado === "ok" ? "&#10003;" : "&#10007;";
        document.getElementById("titulo").textContent = titulo;
        document.getElementById("mensagem").textContent = mensagem;
      }

      // O token vem no fragmento, que so o navegador ve.
      var fragmento = new URLSearchParams(window.location.hash.substring(1));
      var token = fragmento.get("access_token");

      // O GoTrue tambem usa o fragmento para reportar erro - um link ja usado,
      // por exemplo. Ler isso primeiro evita mostrar "token ausente" quando a
      // causa e conhecida.
      var erroDoProvedor = fragmento.get("error_description") || fragmento.get("error");

      // Apaga o fragmento da barra de enderecos: sem isso o token ficaria no
      // historico do aparelho.
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch (e) {
        // Navegador sem history API: o token no historico e um problema menor do
        // que nao confirmar o acesso.
      }

      if (erroDoProvedor) {
        mostrar("erro", "Link invalido", erroDoProvedor);
        return;
      }

      if (!token || !selector) {
        mostrar(
          "erro",
          "Link invalido",
          "Este link expirou ou ja foi utilizado. Solicite um novo acesso."
        );
        return;
      }

      fetch("/api/bff/auth/supabase/aprovar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selector: selector, access_token: token })
      })
        .then(function (r) {
          if (r.ok) {
            mostrar(
              "ok",
              "Acesso confirmado",
              "Pode voltar para a aba onde voce iniciou o login. Ela entrara sozinha em alguns segundos."
            );
          } else {
            mostrar(
              "erro",
              "Link invalido",
              "Este link expirou ou ja foi utilizado. Solicite um novo acesso."
            );
          }
        })
        .catch(function () {
          // A mensagem NAO manda recarregar: o fragmento com o token ja foi
          // apagado, entao um F5 chegaria aqui sem token e mostraria "link
          // invalido". Voltar ao e-mail funciona - o link do GoTrue continua
          // valido enquanto nao for consumido.
          mostrar(
            "erro",
            "Falha de conexao",
            "Nao foi possivel confirmar agora. Abra o link do e-mail novamente."
          );
        });
    })();
  </script>
</body>
</html>`;
}
