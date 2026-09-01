/**
 * Configuracao do backend alternativo (VINEXT / BFF).
 *
 * Tudo aqui e lido do ambiente do SERVIDOR. Nenhum destes valores pode ser
 * prefixado com `NEXT_PUBLIC_`: sao segredos (chave do webhook, segredo do JWT)
 * e um prefixo publico os empacotaria no bundle do browser.
 */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const isProduction = process.env.NODE_ENV === "production";

export const bffConfig = {
  isProduction,

  /** Autenticacao do webhook - o mesmo esquema do backend .NET. */
  webhook: {
    apiKey: env("WEBHOOK_API_KEY", "sabemi-dev-api-key"),
    /** Vazio desliga a verificacao de assinatura. */
    signatureSecret: env("WEBHOOK_SIGNATURE_SECRET", "sabemi-dev-signature-secret"),
    /** Quando ha segredo, exige o header - salvo se desligado explicitamente. */
    requireSignature: env("WEBHOOK_REQUIRE_SIGNATURE", "false") === "true",
  },

  /** Sessao do painel. */
  jwt: {
    secret: env("JWT_SECRET", "troque-este-segredo-em-producao-com-no-minimo-32-caracteres"),
    issuer: env("JWT_ISSUER", "sabemi-webhooks"),
    audience: env("JWT_AUDIENCE", "sabemi-dashboard"),
  },

  auth: {
    /** Validade do pedido de login - tambem o teto do polling. */
    magicLinkTtlMs: envInt("AUTH_MAGIC_LINK_TTL_MINUTES", 15) * 60_000,
    otpMaxAttempts: envInt("AUTH_OTP_MAX_ATTEMPTS", 5),
    sessionTtlSeconds: envInt("AUTH_SESSION_TTL_HOURS", 24) * 3600,

    /**
     * Devolve link e OTP no corpo, para a demonstracao rodar sem SMTP.
     *
     * Falha fechada: em producao e sempre `false`, qualquer que seja a
     * configuracao. A decisao e do servidor e nenhum campo da requisicao a
     * altera.
     */
    exposeLoginCodes: !isProduction && env("AUTH_EXPOSE_LOGIN_CODES", "true") === "true",

    /** Base publica para montar o link de confirmacao. */
    publicBaseUrl: env("BFF_PUBLIC_BASE_URL", "http://localhost:3000"),
  },

  processing: {
    maxTentativas: envInt("PROCESSING_MAX_ATTEMPTS", 3),
    baseRetryDelayMs: envInt("PROCESSING_BASE_RETRY_DELAY_MS", 5_000),
    /** A regra pesada exigida pela task (~2s). */
    simulatedWorkMs: envInt("PROCESSING_SIMULATED_WORK_MS", 2_000),
    batchSize: envInt("PROCESSING_BATCH_SIZE", 5),
    pollIntervalMs: envInt("PROCESSING_POLL_INTERVAL_MS", 1_000),
    /** Prazo para concluir um item reivindicado antes de ser considerado orfao. */
    visibilityTimeoutMs: envInt("PROCESSING_VISIBILITY_TIMEOUT_MS", 120_000),
    /** Liga o laco de processamento em processo. Desligado nos testes. */
    workerEnabled: env("BFF_WORKER_ENABLED", "true") === "true",
  },
} as const;

export type BffConfig = typeof bffConfig;
