import type { ProblemDetails, ProcessingStatus } from "@/lib/contracts";
import { PROCESSING_STATUSES } from "@/lib/contracts";

import { bffConfig } from "./config";
import { verifySessionToken } from "./crypto";
import {
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

  if (path === "auth/verify-otp" && method === "POST") {
    const body = safeJson(request.rawBody) as { selector?: unknown; code?: unknown } | null;
    const resultado = await verifyOtp(body?.selector, body?.code);

    if (resultado.ok) return { status: 200, body: resultado.value };

    const status =
      resultado.failure === "not_found" ? 404 : resultado.failure === "too_many_attempts" ? 429 : 400;

    return problem(status, resultado.message, mapAuthCode(resultado.failure));
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

function mapAuthCode(failure: "not_found" | "invalid_code" | "too_many_attempts" | "invalid_email"): string {
  switch (failure) {
    case "not_found":
      return "login_request_not_found";
    case "too_many_attempts":
      return "too_many_attempts";
    case "invalid_email":
      return "invalid_email";
    default:
      return "invalid_code";
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
