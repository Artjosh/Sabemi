/**
 * Verifica a stack ANTES de coletar os testes.
 *
 * <b>Por que isto existe.</b> A suíte autentica com endereços inventados
 * (`e2e-dotnet-1788405946722@sabemi.com.br`). Se a stack tiver provedor de
 * e-mail configurado, ela envia para eles de verdade, e cada um vira um hard
 * bounce na conta — 26 aconteceram antes desta verificação existir, e o efeito
 * na reputação de envio é acumulativo e não se desfaz.
 *
 * <b>Por que não descobrir enviando.</b> Seria autodestrutivo: para saber se
 * envia, envia. Daí o campo `email_provider` no `/health` dos dois backends —
 * um rótulo (`brevo` / `none`), sem chave nem remetente, que responde à única
 * pergunta que importa aqui.
 *
 * <b>Por que no `globalSetup`, e não em cada teste.</b> Uma consulta, no
 * processo principal, antes da coleta. Assim os testes que dependem de login
 * podem ser PULADOS em vez de falharem — um alarme falso ensina a ignorar
 * alarmes — e a decisão vale para a suíte inteira, sem 14 requisições repetidas
 * ao `/health`.
 *
 * <b>Por que o CI não pula.</b> Pular é a resposta certa para a máquina do
 * desenvolvedor, onde o provedor está ligado de propósito e a alternativa seria
 * queimar reputação de envio. No CI é a resposta errada: lá a suíte responde
 * pela cobertura de autenticação, e um job verde com 47 testes pulados afirmaria
 * algo falso. Com `CI` no ambiente, provedor ativo é erro.
 */

const WEB = process.env.E2E_WEB_URL ?? "http://localhost:3000";
const API = process.env.E2E_API_URL ?? "http://localhost:8080";

/** Nome da variável que os arquivos de teste leem para decidir o skip. */
export const VARIAVEL_EMAIL_ATIVO = "E2E_EMAIL_PROVIDER_ATIVO";

interface Saude {
  status?: string;
  backend?: string;
  email_provider?: string;
}

async function consultar(url: string): Promise<Saude | null> {
  try {
    const resposta = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return resposta.ok ? ((await resposta.json()) as Saude) : null;
  } catch {
    return null;
  }
}

export default async function setup() {
  const [bff, dotnet] = await Promise.all([
    consultar(`${WEB}/api/bff/health`),
    consultar(`${API}/health`),
  ]);

  // A stack fora do ar é um erro, não um motivo para pular: sem ela nada aqui
  // faz sentido, e a mensagem precisa dizer o comando que resolve.
  if (!bff || !dotnet) {
    const quais = [!dotnet && `API .NET (${API})`, !bff && `BFF (${WEB})`]
      .filter(Boolean)
      .join(" e ");

    throw new Error(
      `A stack não respondeu: ${quais}.\n\n` +
        "Suba antes de rodar a suíte:\n" +
        "  AUTH_RATE_LIMIT=500 BREVO_API_KEY= SMTP_HOST= docker compose up -d --wait",
    );
  }

  // Um provedor ativo em QUALQUER um dos dois já basta: os testes de login
  // rodam contra os dois backends.
  const comProvedor = [
    dotnet.email_provider !== "none" && dotnet.email_provider !== undefined
      ? `.NET (${dotnet.email_provider})`
      : null,
    bff.email_provider !== "none" && bff.email_provider !== undefined
      ? `VINEXT (${bff.email_provider})`
      : null,
  ].filter(Boolean);

  if (comProvedor.length === 0) {
    process.env[VARIAVEL_EMAIL_ATIVO] = "0";
    return;
  }

  // No CI, pular NÃO serve. Lá a suíte responde pela cobertura de autenticação,
  // e 47 testes pulados com o job verde seria uma afirmação falsa: ninguém
  // olharia o log para descobrir que a metade que importa não rodou.
  //
  // O caso concreto que isto previne: alguém expõe um secret `BREVO_API_KEY` ao
  // job de E2E. Sem esta guarda, o pipeline continuaria passando enquanto
  // deixava de exercitar login, polling cross-device, troca de backend,
  // reenfileiramento e a equivalência entre os dois backends.
  if (process.env.CI) {
    throw new Error(
      `Provedor de e-mail ATIVO no CI: ${comProvedor.join(", ")}.\n\n` +
        "No CI a suíte não pula esses testes - ela responde pela cobertura de " +
        "autenticação, e um job verde com 47 testes pulados seria uma " +
        "afirmação falsa.\n\n" +
        "Suba a stack do job sem provedor (BREVO_API_KEY e SMTP_HOST vazios).",
    );
  }

  process.env[VARIAVEL_EMAIL_ATIVO] = "1";

  // Ruidoso de propósito. Um teste pulado em silêncio é pior do que um teste
  // falhando: a suíte termina verde e ninguém sabe que 47 verificações não
  // rodaram.
  const barra = "─".repeat(72);
  console.warn(
    [
      "",
      barra,
      "  ATENÇÃO: os testes de autenticação vão ser PULADOS.",
      "",
      `  Provedor de e-mail ATIVO em: ${comProvedor.join(", ")}`,
      "",
      "  Esta suíte autentica com endereços inventados. Com provedor ativo, a",
      "  stack envia para eles de verdade e cada login vira um hard bounce na",
      "  conta - o que corrói a reputação de envio de forma acumulativa.",
      "",
      "  Para rodar a suíte COMPLETA, suba a stack sem provedor:",
      "",
      "    AUTH_RATE_LIMIT=500 BREVO_API_KEY= SMTP_HOST= \\",
      "      docker compose up -d --wait",
      "",
      "  Para verificar o envio de e-mail (o que estes testes NÃO fazem):",
      "",
      "    node scripts/verificar-email.mjs voce@exemplo.com",
      barra,
      "",
    ].join("\n"),
  );
}
