import { bffConfig } from "./config";
import { montarEmailDeAcesso } from "./login-email";

/**
 * Envia o e-mail de acesso pela API v3 da Brevo.
 *
 * <b>A MESMA conta e o MESMO endpoint do backend .NET.</b> O e-mail de acesso é o
 * mesmo produto, venha ele de qual backend vier: mesmo remetente, mesmo domínio
 * verificado, mesma reputação de envio. Duas contas dariam duas reputações a
 * cuidar e um remetente que muda conforme o backend que atendeu - justo o tipo de
 * inconsistência que faz um provedor marcar a mensagem como suspeita.
 *
 * O que não é compartilhado é o código: um é C#, o outro é este. O que os mantém
 * equivalentes é a API (mesmo endpoint, mesmo corpo) e o conteúdo
 * (`login-email.ts` / `LoginEmail.cs`, com teste de paridade).
 *
 * <b>API HTTP e não SMTP.</b> A Brevo oferece os dois. A API dá erro imediato e
 * legível - "remetente não verificado", "chave inválida" -, enquanto por SMTP a
 * mesma falha chega como um 550 genérico ou, pior, como um aceite seguido de
 * descarte silencioso. Num fluxo em que o usuário está parado na tela esperando o
 * código, saber na hora que o envio falhou é o que permite mostrar uma
 * alternativa em vez de deixá-lo esperando.
 *
 * <b>As variáveis `SMTP_*` do `.env` NÃO são usadas aqui.</b> Elas são do GoTrue,
 * que só fala SMTP e envia os e-mails da plataforma Supabase.
 */

/**
 * Resultado do envio.
 *
 * `false` = não houve envio. O serviço de autenticação usa isso para decidir o
 * que a tela mostra, e é por isso que esta função NUNCA lança: uma falha de
 * e-mail não pode virar 500 no endpoint de login. O pedido de acesso continua
 * válido no banco e o link segue no log.
 */
export async function enviarEmailDeAcesso(
  email: string,
  magicUrl: string,
  otpCode: string,
): Promise<boolean> {
  const { apiKey, senderEmail, senderName, baseUrl, timeoutMs } = bffConfig.brevo;

  if (!apiKey) {
    // Nem deveria chegar aqui - quem chama verifica antes -, mas uma chave vazia
    // enviada à Brevo devolve 401 e polui o log com um erro que não é erro.
    return false;
  }

  const conteudo = montarEmailDeAcesso(
    magicUrl,
    otpCode,
    Math.round(bffConfig.auth.magicLinkTtlMs / 60_000),
  );

  // `AbortSignal.timeout`: o `fetch` do Node não tem timeout próprio, e sem isto
  // uma Brevo lenta seguraria a resposta do login por minutos - indistinguível de
  // uma página travada para quem está olhando a tela.
  const sinal = AbortSignal.timeout(timeoutMs);

  try {
    const resposta = await fetch(`${baseUrl.replace(/\/$/, "")}/v3/smtp/email`, {
      method: "POST",
      headers: {
        // `api-key` é o header da Brevo - não é `Authorization: Bearer`. Errar
        // isto devolve 401 com uma mensagem que não diz qual header ela esperava.
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        // `to` é uma LISTA, mesmo com um destinatário só - a Brevo recusa objeto.
        to: [{ email }],
        subject: conteudo.subject,
        htmlContent: conteudo.html,
        textContent: conteudo.text,
        headers: {
          // Evita que um autoresponder de férias gere uma resposta que ninguém
          // vai ler.
          "X-Auto-Response-Suppress": "All",
          "Auto-Submitted": "auto-generated",
        },
      }),
      signal: sinal,
    });

    if (resposta.ok) {
      console.info(`[bff-brevo] e-mail de acesso enviado para ${email}`);
      return true;
    }

    // O CORPO do erro é o que diz a causa - o status sozinho não. Um 400 da
    // Brevo pode ser remetente não verificado, domínio sem autenticação ou
    // payload inválido, e cada um exige uma ação diferente de quem opera.
    const corpo = await resposta.text().catch(() => "(corpo ilegível)");

    console.error(
      `[bff-brevo] a Brevo recusou o e-mail para ${email}: HTTP ${resposta.status}. ` +
        `Resposta: ${corpo.slice(0, 500)}`,
    );

    return false;
  } catch (erro) {
    // Timeout, DNS, TLS, indisponibilidade. Nada disso pode derrubar o login: o
    // pedido de acesso continua válido e o link está no log.
    console.error(`[bff-brevo] falha ao enviar o e-mail de acesso para ${email}:`, erro);
    return false;
  }
}
