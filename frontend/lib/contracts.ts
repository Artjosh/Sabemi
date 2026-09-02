/**
 * Tipos do contrato compartilhado (`contracts/openapi.yaml`).
 *
 * Este arquivo e o unico lugar onde a forma dos dados e declarada, e ele e
 * consumido pelos tres lados:
 *
 *   * a UI, que renderiza o dashboard;
 *   * o backend VINEXT, que produz estas respostas;
 *   * os adapters, que garantem que o backend .NET produza as mesmas.
 *
 * E o que torna a troca de backend verificavel pelo compilador: se um dos lados
 * divergir do contrato, o TypeScript acusa antes de chegar ao browser.
 *
 * Os nomes em `snake_case` vem do contrato e sao preservados de proposito - o
 * backend .NET fala assim, e traduzir no meio do caminho so criaria um ponto a
 * mais onde os dois podem divergir sem ninguem perceber.
 */

/** Ciclo de vida de um evento. Precisa bater com os dois backends. */
export type ProcessingStatus =
  | "PENDENTE"
  | "PROCESSANDO"
  | "SUCESSO"
  | "ERRO"
  | "INVALIDO"
  | "DUPLICADO";

/** Situacao informada pelo banco parceiro. */
export type PartnerStatus = "PAGO" | "PENDENTE" | "CANCELADO" | "ESTORNADO";

export const PROCESSING_STATUSES: readonly ProcessingStatus[] = [
  "PENDENTE",
  "PROCESSANDO",
  "SUCESSO",
  "ERRO",
  "INVALIDO",
  "DUPLICADO",
] as const;

/** Identificador do backend ativo. */
export type BackendId = "dotnet" | "vinext";

/** Natureza da falha - decide se o sistema retenta sozinho. */
export type FailureCategory = "TRANSITORIA" | "PERMANENTE" | "DESCONHECIDA";

/**
 * Falha traduzida para quem opera o painel.
 *
 * Vem do BACKEND, e nao de um catalogo aqui no cliente, de proposito: os dois
 * backends implementam o mesmo contrato e precisam explicar a mesma falha com as
 * mesmas palavras. Um catalogo duplicado na UI divergiria na primeira vez que so
 * um dos lados fosse atualizado.
 */
export interface FailureDiagnosisDto {
  categoria: FailureCategory;
  /** Codigo estavel da causa - tambem usado como rotulo de metrica. */
  codigo: string;
  /** Uma frase dizendo o que deu errado, sem stack trace. */
  explicacao: string;
  /** O que a pessoa pode fazer a respeito. */
  acao_sugerida: string;
  /** O sistema retenta sozinho? `false` justifica oferecer o reenfileiramento. */
  retentavel: boolean;
}

export interface PaymentEventDto {
  id: string;
  id_transacao: string;
  id_contrato: string | null;
  valor: number | null;
  data_pagamento: string | null;
  status_origem: string | null;
  status_processamento: ProcessingStatus;
  /** Mensagem tecnica crua, como veio da excecao. */
  erro: string | null;
  /** Leitura da falha para a UI. Nulo quando o evento nunca falhou. */
  diagnostico: FailureDiagnosisDto | null;
  recebido_em: string;
  processado_em: string | null;
  tentativas: number;
}

/** Resposta do reenfileiramento manual. */
export interface RequeueResultDto {
  id_transacao: string;
  /** PENDENTE - o evento voltou para a fila. */
  status_processamento: ProcessingStatus;
  reenfileirado_em: string;
  /** Texto pronto para mostrar ao operador. */
  message: string;
}

export interface PaymentEventDetailDto extends PaymentEventDto {
  /** Corpo exatamente como recebido, para auditoria. */
  payload_bruto: string;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
}

export interface ContractStatusDto {
  id_contrato: string;
  valor_total_liquidado: number;
  pagamentos_confirmados: number;
  ultimo_pagamento_em: string | null;
  ultima_transacao: string | null;
  situacao: "ATIVO" | "LIQUIDADO" | "INADIMPLENTE";
  atualizado_em: string;
}

export interface PaymentSummaryDto {
  total: number;
  /** Sempre traz todas as chaves de `ProcessingStatus`, inclusive as zeradas. */
  por_status: Record<string, number>;
}

export interface WebhookAck {
  id_transacao: string;
  status: string;
  /** `true` quando o `id_transacao` ja existia - nada foi reprocessado. */
  duplicate: boolean;
  received_at: string;
  message?: string;
}

export interface UserDto {
  id: string;
  email: string;
  criado_em: string;
}

/** Resposta ao inicio do login. O `selector` alimenta o polling. */
export interface MagicLinkStartDto {
  selector: string;
  email: string;
  email_sent: boolean;
  /** Apenas em desenvolvimento; `null` em producao. */
  dev_magic_url: string | null;
  /** Apenas em desenvolvimento; `null` em producao. */
  dev_otp_code: string | null;
  message: string;
}

/** Resposta do polling e do OTP. */
export interface LoginStatusDto {
  status: "pending" | "approved";
  authenticated: boolean;
  /**
   * Presente apenas quando aprovado.
   *
   * Nunca chega ao browser: o gateway o intercepta e grava em cookie httpOnly.
   * Ver `app/api/auth/login/route.ts`.
   */
  access_token?: string | null;
  expires_in?: number | null;
  user?: UserDto | null;
}

/** Formato de erro uniforme nos dois backends (RFC 7807 enxuto). */
export interface ProblemDetails {
  detail: string;
  code?: string;
  errors?: Record<string, string[]>;
}

/** Resposta de `/health`, usada para confirmar qual backend respondeu. */
export interface HealthDto {
  status: "healthy" | "degraded";
  backend: BackendId;
  version?: string;
  environment?: string;
}

/** Filtros do dashboard. */
export interface PaymentFilters {
  status?: ProcessingStatus | null;
  contractId?: string | null;
  page?: number;
  pageSize?: number;
}

/** Rotulo em portugues para cada situacao, usado na UI. */
export const STATUS_LABELS: Record<ProcessingStatus, string> = {
  PENDENTE: "Pendente",
  PROCESSANDO: "Processando",
  SUCESSO: "Sucesso",
  ERRO: "Erro",
  INVALIDO: "Invalido",
  DUPLICADO: "Duplicado",
};
