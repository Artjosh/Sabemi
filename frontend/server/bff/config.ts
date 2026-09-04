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

    /**
     * Espera minima entre dois pedidos de acesso para o MESMO e-mail.
     *
     * Sem isto, quem nao recebe o e-mail clica "enviar" repetidamente e cada
     * clique vira uma mensagem de verdade - e um endereco inexistente vira uma
     * sequencia de hard bounces, que e o que corroi reputacao de envio.
     *
     * Um minuto e o mesmo valor que o GoTrue usa por padrao
     * (`GOTRUE_SMTP_MAX_FREQUENCY`), entao os dois modos de autenticacao se
     * comportam igual. Zero desliga.
     */
    resendCooldownMs:
      Number(env("AUTH_RESEND_COOLDOWN_SECONDS", "60")) * 1000,

    /**
     * Pedidos de autenticacao por minuto, por IP.
     *
     * A MESMA variavel que alimenta o `RateLimit:AuthPermitLimit` do backend
     * .NET - o limite nao deveria depender de qual implementacao atendeu. O
     * padrao acompanha o do compose: folgado em desenvolvimento, apertado em
     * producao.
     *
     * Zero desliga. Ver `rate-limit.ts` para o que este limite alcanca neste
     * runtime, que nao e o mesmo que o .NET alcanca.
     */
    rateLimit: Number(env("AUTH_RATE_LIMIT", isProduction ? "10" : "500")),

    /** Base publica para montar o link de confirmacao. */
    publicBaseUrl: env("BFF_PUBLIC_BASE_URL", "http://localhost:3000"),
  },

  /**
   * GoTrue (Supabase Auth), usado quando `AUTH_PROVIDER=supabase`.
   *
   * A unica coisa que muda entre o GoTrue local (docker-compose.supabase.yml) e
   * um projeto hospedado e a URL e a chave - a mesma propriedade que a conexao
   * do banco tem.
   */
  supabase: {
    /**
     * Base do gateway: `http://localhost:54321` local, ou
     * `https://SEU_REF.supabase.co` remoto. Os caminhos do GoTrue ficam sob
     * `/auth/v1`.
     */
    url: env("SUPABASE_URL", ""),

    /**
     * Chave `anon`. Vai no header `apikey`, que o Kong exige antes de encaminhar
     * ao GoTrue. E publica por desenho - existe para ser embutida em cliente de
     * browser; o que autoriza de fato e o proprio fluxo do GoTrue (posse da
     * caixa de e-mail).
     *
     * A `service_role` NAO e usada no fluxo de login: ela ignora RLS e permite
     * administrar usuarios, e o acesso nao precisa disso.
     */
    anonKey: env("SUPABASE_ANON_KEY", ""),

    /** 10s, pelo mesmo motivo da Brevo: quem espera e o usuario na tela. */
    timeoutMs: envInt("SUPABASE_TIMEOUT_MS", 10_000),
  },

  /**
   * Envio do e-mail de acesso pela Brevo.
   *
   * A MESMA conta que o backend .NET usa: o e-mail de acesso e o mesmo produto,
   * venha de qual backend vier. Duas contas dariam duas reputacoes de envio a
   * cuidar e um remetente que muda conforme quem atendeu.
   *
   * Chave vazia desliga o envio real - e o que permite avaliar o projeto sem
   * uma conta na Brevo, com o link indo para o log e para a tela.
   */
  brevo: {
    apiKey: env("BREVO_API_KEY", ""),

    /**
     * Precisa ser um endereco de um dominio VERIFICADO na conta. A Brevo recusa
     * o envio com 400 caso contrario, e a mensagem de erro dela nao deixa isso
     * obvio.
     */
    senderEmail: env("BREVO_SENDER_EMAIL", "nao-responda@sabemi.com.br"),
    senderName: env("BREVO_SENDER_NAME", "Sabemi"),

    /** Configuravel para os testes apontarem para um servidor local. */
    baseUrl: env("BREVO_BASE_URL", "https://api.brevo.com"),

    /**
     * 10s. Quem espera e o usuario, olhando a tela de login: uma espera longa e
     * indistinguivel de uma pagina travada. Estourado o prazo, o backend
     * registra a falha e a UI oferece o link direto.
     */
    timeoutMs: envInt("BREVO_TIMEOUT_MS", 10_000),
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

// Qual provedor de identidade esta ativo. A diferenca entre os dois modos e
// grande - no modo supabase o link de acesso vive dentro do GoTrue e nao aparece
// na resposta - e descobri-la lendo o log e melhor do que descobri-la pedindo
// acesso e nao entendendo o que voltou.
{
  const provedor = (process.env.AUTH_PROVIDER ?? "local").trim().toLowerCase();

  console.info(
    provedor === "supabase"
      ? `[bff-config] Provedor de identidade: supabase (GoTrue em ${bffConfig.supabase.url}).`
      : "[bff-config] Provedor de identidade: local (magic link e OTP proprios).",
  );
}

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
