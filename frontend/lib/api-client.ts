import type {
  BackendId,
  ContractStatusDto,
  HealthDto,
  MagicLinkStartDto,
  PagedResult,
  PaymentEventDetailDto,
  PaymentEventDto,
  PaymentFilters,
  PaymentSummaryDto,
  ProblemDetails,
  UserDto,
} from "./contracts";

/**
 * Cliente da API usado pela interface.
 *
 * <b>A propriedade que sustenta a troca de backend.</b> Nao ha nenhuma mencao a
 * ".NET" ou "VINEXT" neste arquivo. Toda chamada vai para `/api/gateway/*`
 * (same-origin) e o servidor decide qual implementacao atende. Trocar de backend
 * nao muda uma linha daqui para cima - e o que significa, na pratica, "trocar a
 * implementacao sem reescrever a interface".
 *
 * <b>Nao ha token aqui.</b> A sessao vive num cookie httpOnly enviado
 * automaticamente pelo browser. Este modulo nao le, nao guarda e nao sabe
 * manipular tokens - nao ha o que vazar.
 */

/** Erro de API com o status HTTP preservado. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errors?: Record<string, string[]>;

  constructor(message: string, status: number, code?: string, errors?: Record<string, string[]>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.errors = errors;
  }

  /**
   * Distingue "o pedido de login acabou" de uma falha qualquer.
   *
   * O polling usa isto para encerrar: um `404` significa que o pedido foi
   * consumido ou expirou, e insistir nao mudaria nada.
   */
  get isGone(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      // Envia o cookie httpOnly de sessao. Same-origin: nao ha CORS envolvido.
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // Rede fora, servidor caido: vira um ApiError como qualquer outro, para a
    // UI ter um unico caminho de tratamento de erro.
    throw new ApiError(
      "Não foi possível conectar ao servidor. Verifique sua conexão.",
      0,
      "network_error",
    );
  }

  if (response.status === 204) return undefined as T;

  const texto = await response.text();
  const dados: unknown = texto ? safeParse(texto) : null;

  if (!response.ok) {
    const problema = dados as ProblemDetails | null;
    throw new ApiError(
      problema?.detail ?? "Erro ao processar a requisição.",
      response.status,
      problema?.code,
      problema?.errors,
    );
  }

  return dados as T;
}

function safeParse(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

// ------------------------------------------------------------------- auth

/** Inicia o login e devolve o `selector` que alimenta o polling. */
export function startLogin(email: string) {
  return request<MagicLinkStartDto>("/api/auth/login?step=start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/**
 * Um ciclo de polling.
 *
 * Quando aprovado, o SERVIDOR grava o cookie de sessao e devolve so o usuario -
 * o token nunca chega aqui. Ver `app/api/auth/login/route.ts`.
 */
export function pollLogin(selector: string) {
  return request<{ status: "pending" | "approved"; authenticated: boolean; user?: UserDto | null }>(
    "/api/auth/login?step=poll",
    { method: "POST", body: JSON.stringify({ selector }) },
  );
}

/** Valida o codigo de 6 digitos. Mesmo desfecho do polling aprovado. */
export function verifyOtp(selector: string, code: string) {
  return request<{ status: string; authenticated: boolean; user?: UserDto | null }>(
    "/api/auth/login?step=otp",
    { method: "POST", body: JSON.stringify({ selector, code }) },
  );
}

/** Restaura a sessao a partir do cookie httpOnly (usado no F5). */
export function getSession() {
  return request<{ user: UserDto; backend: BackendId }>("/api/auth/session");
}

export function clearSession() {
  return request<{ ok: boolean }>("/api/auth/session", { method: "DELETE" });
}

// --------------------------------------------------------------- backends

export interface BackendInfo {
  id: BackendId;
  label: string;
  description: string;
  online: boolean;
}

export function getBackends() {
  return request<{ active: BackendId; default: BackendId; backends: BackendInfo[] }>("/api/backend");
}

/** Troca o backend ativo. A sessao e encerrada quando o backend muda. */
export function switchBackend(backend: BackendId) {
  return request<{ active: BackendId; previous: BackendId; session_cleared: boolean }>(
    "/api/backend",
    { method: "POST", body: JSON.stringify({ backend }) },
  );
}

/** Confirma qual backend respondeu - usado para exibir o estado real na tela. */
export function getHealth() {
  return request<HealthDto>("/api/gateway/health");
}

// --------------------------------------------------------------- payments

export function listPayments(filters: PaymentFilters = {}) {
  const params = new URLSearchParams();

  if (filters.status) params.set("status", filters.status);
  if (filters.contractId) params.set("contractId", filters.contractId);
  if (filters.page) params.set("page", String(filters.page));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));

  const query = params.toString();
  return request<PagedResult<PaymentEventDto>>(`/api/gateway/payments${query ? `?${query}` : ""}`);
}

export function getPaymentSummary() {
  return request<PaymentSummaryDto>("/api/gateway/payments/summary");
}

export function getPaymentDetail(idTransacao: string) {
  return request<PaymentEventDetailDto>(
    `/api/gateway/payments/${encodeURIComponent(idTransacao)}`,
  );
}

export function getContract(idContrato: string) {
  return request<ContractStatusDto>(`/api/gateway/contracts/${encodeURIComponent(idContrato)}`);
}
