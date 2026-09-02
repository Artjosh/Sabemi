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
     * Devolve link e OTP no corpo da resposta, em vez de so por e-mail.
     *
     * <b>Falha fechada, com uma saida explicita.</b> O padrao acompanha o
     * ambiente - ligado fora de producao, desligado em producao. Nenhum campo da
     * requisicao a influencia: a decisao e inteiramente do servidor.
     *
     * A saida existe porque a versao anterior travava em `!isProduction` e isso
     * era um beco sem saida: uma imagem de producao sem provedor de e-mail
     * ficava sem NENHUM caminho de login - o usuario pedia acesso, recebia
     * `null`, e nao havia como entrar. Quem opera precisa poder dizer "esta
     * stack e uma demonstracao, entregue o codigo na resposta".
     *
     * Ligar em producao e uma decisao consciente e ruidosa: `AUTH_EXPOSE_LOGIN_CODES=true`
     * escrito a mao, e um aviso a cada inicializacao (ver o alerta abaixo).
     * `docker-compose.prod.yml` fixa `false`.
     */
    exposeLoginCodes: env("AUTH_EXPOSE_LOGIN_CODES", isProduction ? "false" : "true") === "true",

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

// Expor codigo de acesso em producao e legitimo para uma stack de demonstracao,
// mas nunca deve passar despercebido: se alguem promover esta configuracao a um
// ambiente real, o aviso esta no primeiro bloco de log da inicializacao.
if (bffConfig.isProduction && bffConfig.auth.exposeLoginCodes) {
  console.warn(
    "[bff-config] AVISO: AUTH_EXPOSE_LOGIN_CODES=true em producao. O link e o " +
      "codigo de acesso vao no CORPO da resposta de login - qualquer um que " +
      "chame /auth/acesso com um e-mail entra como aquele e-mail. Use apenas " +
      "em ambiente de demonstracao.",
  );
}

export type BffConfig = typeof bffConfig;
