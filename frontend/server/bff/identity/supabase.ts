import { bffConfig } from "../config";

import type { ChallengeResult, IdentityProvider, OtpVerification } from "./types";

/**
 * Delega o desafio de acesso ao GoTrue (Supabase Auth).
 *
 * <b>Espelho de `SupabaseIdentityProvider.cs`.</b> Mesmos endpoints, mesmo
 * `redirect_to`, mesma leitura dos status - os dois backends compartilham a
 * tabela de pedidos, então precisam concordar sobre o que aprova um pedido.
 *
 * <b>O que o GoTrue passa a fazer.</b> Gerar o magic link, gerar o código OTP,
 * enviar o e-mail (pelo SMTP dele) e validar o código. O que continua aqui é o
 * pedido de login com `selector` - e é ele que sustenta o polling cross-device,
 * que o GoTrue não tem.
 *
 * <b>Como o clique no celular aprova o pedido do desktop.</b> O `redirect_to`
 * enviado ao GoTrue carrega o `selector`. O usuário abre o e-mail no celular, o
 * GoTrue valida o token e redireciona para `/api/bff/auth/supabase/confirm?selector=…`.
 * Essa página lê o token do fragmento da URL, o envia por POST, e o servidor o
 * valida antes de aprovar. O polling que roda no desktop recebe a sessão no
 * ciclo seguinte.
 *
 * <b>Por que o link não é devolvido na resposta.</b> Ele é montado dentro do
 * GoTrue e nunca passa por este código. É a diferença prática entre os dois
 * modos: no local, a demonstração sem SMTP funciona porque temos o link em mãos;
 * aqui, sem SMTP configurado, o link fica no LOG DO CONTAINER do GoTrue.
 */

/** Timeout do `fetch`, que não tem um por padrão no Node. */
function sinalDeTimeout(): AbortSignal {
  return AbortSignal.timeout(bffConfig.supabase.timeoutMs);
}

function cabecalhos(): Record<string, string> {
  return {
    // `apikey` é o header que o Kong exige antes de encaminhar ao GoTrue. A
    // chave `anon` basta: o fluxo de acesso não precisa da `service_role`, e
    // manter a chave privilegiada fora do caminho quente reduz o estrago de um
    // log vazado.
    apikey: bffConfig.supabase.anonKey,
    "content-type": "application/json",
  };
}

export const provedorSupabase: IdentityProvider = {
  kind: "SUPABASE",

  async iniciarDesafio(email: string, selector: string): Promise<ChallengeResult> {
    const base = bffConfig.auth.publicBaseUrl.replace(/\/$/, "");

    // O selector viaja no `redirect_to`: é o que liga o clique no celular ao
    // pedido que está sendo pollado no desktop.
    const redirect =
      `${base}/api/bff/auth/supabase/confirm?selector=${encodeURIComponent(selector)}`;

    // Sem link nem código em mãos: eles vivem dentro do GoTrue.
    const semSegredos = {
      magicTokenHash: null,
      otpCodeHash: null,
      magicUrl: null,
      otpCode: null,
    };

    try {
      const url =
        `${bffConfig.supabase.url.replace(/\/$/, "")}` +
        `/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`;

      const resposta = await fetch(url, {
        method: "POST",
        headers: cabecalhos(),
        body: JSON.stringify({
          email,
          // `true`: não há tela de cadastro neste sistema - o primeiro acesso
          // com um e-mail cria a conta, igual ao modo local. Com `false`, um
          // e-mail novo receberia erro em vez de um convite.
          create_user: true,
        }),
        signal: sinalDeTimeout(),
      });

      if (resposta.ok) {
        console.info(`[bff-auth] desafio delegado ao GoTrue para ${email}`);

        // `true` = o GoTrue ACEITOU o pedido. Ele envia o e-mail de forma
        // assíncrona, então isto não é confirmação de entrega - e é o máximo que
        // se pode afirmar sem inventar.
        return { ...semSegredos, emailEnviado: true };
      }

      const corpo = await resposta.text().catch(() => "(corpo ilegível)");

      console.error(
        `[bff-auth] o GoTrue recusou o desafio para ${email}: HTTP ${resposta.status}. ` +
          `Resposta: ${corpo.slice(0, 500)}`,
      );

      return { ...semSegredos, emailEnviado: false };
    } catch (erro) {
      // Quem chama vai persistir o pedido de todo modo. Parece contraintuitivo
      // gravar um pedido cujo desafio falhou, mas é o certo: o selector já foi
      // entregue ao cliente, que já está pollando. Um pedido ausente daria 404 e
      // a tela diria "seu acesso expirou" - quando o que houve foi falha de
      // envio.
      console.error(`[bff-auth] falha ao falar com o GoTrue para ${email}:`, erro);
      return { ...semSegredos, emailEnviado: false };
    }
  },

  async verificarOtp(
    email: string,
    _otpCodeHash: string | null,
    code: string,
  ): Promise<OtpVerification> {
    try {
      const resposta = await fetch(
        `${bffConfig.supabase.url.replace(/\/$/, "")}/auth/v1/verify`,
        {
          method: "POST",
          headers: cabecalhos(),
          body: JSON.stringify({
            email,
            token: code.trim(),
            // `email` é o tipo do OTP de acesso do GoTrue. `magiclink` valida o
            // token longo do link, que não é o que o usuário digita.
            type: "email",
          }),
          signal: sinalDeTimeout(),
        },
      );

      if (resposta.ok) return "valido";

      // 400/401/403 = o GoTrue respondeu e disse que o código não serve.
      // Qualquer outro status é problema DELE, não do código - e a distinção
      // importa: contar tentativa por indisponibilidade consumiria o orçamento
      // do usuário por uma falha que não é dele.
      if ([400, 401, 403].includes(resposta.status)) return "invalido";

      const corpo = await resposta.text().catch(() => "(corpo ilegível)");

      console.error(
        `[bff-auth] o GoTrue falhou ao verificar o código de ${email}: ` +
          `HTTP ${resposta.status}. Resposta: ${corpo.slice(0, 500)}`,
      );

      return "indisponivel";
    } catch (erro) {
      console.error(`[bff-auth] falha ao verificar o código de ${email} no GoTrue:`, erro);
      return "indisponivel";
    }
  },

  async verificarTokenDeAcesso(accessToken: string): Promise<string | null> {
    if (!accessToken) return null;

    // `GET /auth/v1/user` com o token: é o GoTrue quem diz se o token vale e de
    // quem ele é.
    //
    // Por que perguntar a ele em vez de validar a assinatura aqui: validar
    // localmente com o segredo do JWT seria mais rápido e dispensaria rede - mas
    // aceitaria um token JÁ REVOGADO. Um logout no GoTrue, ou um usuário banido,
    // continuaria autenticando por todo o tempo de vida do JWT. Para o passo que
    // decide "esta pessoa abriu o e-mail e pode entrar", a resposta autoritativa
    // vale a chamada.
    try {
      const resposta = await fetch(
        `${bffConfig.supabase.url.replace(/\/$/, "")}/auth/v1/user`,
        {
          headers: { ...cabecalhos(), authorization: `Bearer ${accessToken}` },
          signal: sinalDeTimeout(),
        },
      );

      if (!resposta.ok) {
        console.warn(
          `[bff-auth] token de acesso recusado pelo GoTrue: HTTP ${resposta.status}`,
        );
        return null;
      }

      const usuario = (await resposta.json()) as { email?: string };

      // Um usuário sem e-mail não serve: é por e-mail que este sistema identifica
      // o operador, e é com ele que a comparação com o pedido é feita.
      return usuario.email ? usuario.email.trim().toLowerCase() : null;
    } catch (erro) {
      // `null` = não autenticado. Não há caminho de "talvez" aqui: na dúvida, o
      // acesso é negado.
      console.error("[bff-auth] falha ao validar o token de acesso no GoTrue:", erro);
      return null;
    }
  },
};
