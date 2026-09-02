import type { LoginStatusDto, MagicLinkStartDto, UserDto } from "@/lib/contracts";

import { bffConfig } from "./config";
import { uuidV7 } from "./ids";
import { prisma } from "./db";
import { enviarEmailDeAcesso } from "./brevo";
import {
  fixedTimeEquals,
  generateOtp,
  generateToken,
  issueSessionToken,
  sha256,
} from "./crypto";

/**
 * Login passwordless com confirmacao cross-device por polling - implementacao
 * VINEXT.
 *
 * Reproduz o mesmo fluxo do backend .NET (`AuthService`), com a mesma separacao
 * entre o identificador publico e os segredos:
 *
 *   * `selector` - publico, repetido a cada ciclo de polling. Nao aprova nada,
 *     so pergunta. Por isso pode trafegar dezenas de vezes sem risco.
 *   * `magicTokenHash` - segredo do link, aberto em QUALQUER aparelho. E o que
 *     torna o fluxo cross-device: pede-se no desktop, confirma-se no celular.
 *   * `otpCodeHash` - codigo curto, para quem prefere nao sair da aba.
 *
 * Os dois segredos ficam apenas como SHA-256. Um vazamento do banco nao entrega
 * logins ativos.
 *
 * O pedido e de uso unico: ao virar sessao, e destruido. O polling seguinte
 * recebe `not_found`, e e assim que o cliente sabe parar - em vez de girar ate
 * o timeout.
 */

export type AuthFailure = "not_found" | "invalid_code" | "too_many_attempts" | "invalid_email";

export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: AuthFailure; message: string };

function fail<T>(failure: AuthFailure, message: string): AuthResult<T> {
  return { ok: false, failure, message };
}

/**
 * Checagem sintatica basica de e-mail.
 *
 * Validar e-mail por regex e um beco sem saida conhecido; a verificacao real e
 * a entrega - so entra quem abre a mensagem.
 */
function isPlausibleEmail(email: string): boolean {
  const at = email.indexOf("@");
  return (
    at > 0 &&
    at < email.length - 1 &&
    email.indexOf("@", at + 1) < 0 &&
    email.lastIndexOf(".") > at + 1 &&
    !email.includes(" ")
  );
}

/** Inicia um pedido de login e devolve o selector para o polling. */
export async function startLogin(rawEmail: unknown): Promise<AuthResult<MagicLinkStartDto>> {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";

  if (!email || !isPlausibleEmail(email)) {
    return fail("invalid_email", "Informe um e-mail valido.");
  }

  const agora = new Date();

  // Um novo pedido invalida os anteriores do mesmo e-mail: sem isso, links
  // antigos continuariam validos e quem pediu duas vezes teria dois codigos
  // funcionando ao mesmo tempo.
  await prisma.loginRequest.deleteMany({ where: { email } });

  const selector = generateToken(24);
  const magicToken = generateToken(32);
  const otpCode = generateOtp();

  // Os valores que antes vinham de `@default(...)` agora sao explicitos: com o
  // schema compartilhado, quem os define e a aplicacao (o EF Core sempre fez
  // assim). Ter duas fontes de valor para a mesma coluna seria pedir
  // divergencia entre os dois backends.
  await prisma.loginRequest.create({
    data: {
      id: uuidV7(),
      email,
      selector,
      magicTokenHash: sha256(magicToken),
      otpCodeHash: sha256(otpCode),
      otpTentativas: 0,
      status: "PENDENTE",
      criadoEm: agora,
      expiraEm: new Date(agora.getTime() + bffConfig.auth.magicLinkTtlMs),
    },
  });

  const base = bffConfig.auth.publicBaseUrl.replace(/\/$/, "");
  const magicUrl = `${base}/api/bff/auth/confirm?token=${encodeURIComponent(magicToken)}`;

  // O link vai para o log SEMPRE, inclusive quando o e-mail e enviado de
  // verdade. Custa nada e e a diferenca entre um suporte de dois minutos e um de
  // meia hora quando alguem diz "nao recebi".
  console.info(`[bff-auth] ACESSO ${email} | link: ${magicUrl} | OTP: ${otpCode}`);

  // O envio e AGUARDADO, e nao disparado em segundo plano.
  //
  // Sem esperar, `email_sent` seria um chute e a tela nao teria como escolher
  // entre "confira seu e-mail" e "use o codigo abaixo". Uma promessa errada aqui
  // manda o usuario procurar um e-mail que nunca vai chegar - e o timeout curto
  // (10s) existe justamente para que essa espera tenha teto.
  //
  // Uma falha NAO invalida o pedido: ele continua no banco, o polling continua
  // funcionando, e o link esta no log.
  const emailEnviado = bffConfig.brevo.apiKey
    ? await enviarEmailDeAcesso(email, magicUrl, otpCode)
    : false;

  const expoe = bffConfig.auth.exposeLoginCodes;

  return {
    ok: true,
    value: {
      selector,
      email,
      email_sent: emailEnviado,
      dev_magic_url: expoe ? magicUrl : null,
      dev_otp_code: expoe ? otpCode : null,
      // Os textos sao os MESMOS do backend .NET (AuthService.StartAsync): a tela
      // de login e uma so, e a mensagem nao deveria mudar conforme o backend
      // selecionado.
      message: emailEnviado
        ? "Enviamos um link e um codigo de acesso para o seu e-mail."
        : expoe
          ? "Use o link ou o codigo abaixo para entrar."
          : "Nao foi possivel enviar o e-mail agora. Tente novamente em instantes.",
    },
  };
}

/**
 * Aprova o pedido a partir do token do link.
 *
 * Chamado pelo aparelho que abriu o e-mail - que pode nao ser o que iniciou o
 * login. A aba de origem descobre no proximo ciclo de polling.
 */
export async function confirmMagicLink(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token === "") return false;

  const pedido = await prisma.loginRequest.findUnique({
    where: { magicTokenHash: sha256(token) },
  });

  if (!pedido) return false;

  if (pedido.expiraEm < new Date()) {
    await prisma.loginRequest.delete({ where: { id: pedido.id } });
    return false;
  }

  // A conta e criada no ato da confirmacao, e nao ao pedir o link: caso
  // contrario bastaria digitar e-mails para popular a tabela de usuarios com
  // contas que nunca provaram posse da caixa.
  await getOrCreateUser(pedido.email);

  await prisma.loginRequest.update({
    where: { id: pedido.id },
    data: { status: "APROVADO" },
  });

  return true;
}

/** Valida o codigo de 6 digitos e emite a sessao na hora. */
export async function verifyOtp(
  selector: unknown,
  code: unknown,
): Promise<AuthResult<LoginStatusDto>> {
  if (typeof selector !== "string" || typeof code !== "string" || !selector || !code) {
    return fail("not_found", "Pedido de login invalido.");
  }

  const pedido = await prisma.loginRequest.findUnique({ where: { selector } });

  if (!pedido || pedido.expiraEm < new Date()) {
    if (pedido) await prisma.loginRequest.delete({ where: { id: pedido.id } });
    return fail("not_found", "Pedido de login nao encontrado ou expirado.");
  }

  if (pedido.otpTentativas >= bffConfig.auth.otpMaxAttempts) {
    await prisma.loginRequest.delete({ where: { id: pedido.id } });
    return fail("too_many_attempts", "Muitas tentativas. Solicite um novo acesso.");
  }

  if (!pedido.otpCodeHash || !fixedTimeEquals(pedido.otpCodeHash, sha256(code.trim()))) {
    await prisma.loginRequest.update({
      where: { id: pedido.id },
      data: { otpTentativas: { increment: 1 } },
    });
    return fail("invalid_code", "Codigo incorreto.");
  }

  const user = await getOrCreateUser(pedido.email);
  const sessao = await buildSession(user);

  // Uso unico: o pedido morre junto com a emissao da sessao.
  await prisma.loginRequest.delete({ where: { id: pedido.id } });

  return { ok: true, value: sessao };
}

/**
 * O polling. Devolve "pending" enquanto ninguem confirmou; quando confirmado,
 * troca o pedido por uma sessao e o consome.
 */
export async function pollLoginStatus(selector: unknown): Promise<AuthResult<LoginStatusDto>> {
  if (typeof selector !== "string" || !selector) {
    return fail("not_found", "Pedido de login nao encontrado.");
  }

  const pedido = await prisma.loginRequest.findUnique({ where: { selector } });

  // Ausente, expirado e ja consumido caem no mesmo desfecho, de proposito: sao
  // indistinguiveis de fora, e para o cliente significam a mesma coisa - pare
  // de perguntar.
  if (!pedido) {
    return fail("not_found", "Pedido de login nao encontrado ou ja consumido.");
  }

  if (pedido.expiraEm < new Date()) {
    await prisma.loginRequest.delete({ where: { id: pedido.id } });
    return fail("not_found", "Pedido de login expirado. Solicite um novo acesso.");
  }

  if (pedido.status !== "APROVADO") {
    return { ok: true, value: { status: "pending", authenticated: false } };
  }

  const user = await getOrCreateUser(pedido.email);
  const sessao = await buildSession(user);

  await prisma.loginRequest.delete({ where: { id: pedido.id } });

  return { ok: true, value: sessao };
}

export async function getUserById(id: string): Promise<UserDto | null> {
  const user = await prisma.appUser.findUnique({ where: { id } });
  return user ? toUserDto(user) : null;
}

/** Remove pedidos vencidos. Chamado pela varredura periodica. */
export async function purgeExpiredLoginRequests(): Promise<number> {
  const { count } = await prisma.loginRequest.deleteMany({
    where: { expiraEm: { lt: new Date() } },
  });
  return count;
}

async function getOrCreateUser(email: string) {
  return prisma.appUser.upsert({
    where: { email },
    create: { id: uuidV7(), email, criadoEm: new Date() },
    update: {},
  });
}

async function buildSession(user: { id: string; email: string; criadoEm: Date }): Promise<LoginStatusDto> {
  const { token, expiresIn } = await issueSessionToken(user);

  return {
    status: "approved",
    authenticated: true,
    access_token: token,
    expires_in: expiresIn,
    user: toUserDto(user),
  };
}

function toUserDto(user: { id: string; email: string; criadoEm: Date }): UserDto {
  return {
    id: user.id,
    email: user.email,
    criado_em: user.criadoEm.toISOString(),
  };
}
