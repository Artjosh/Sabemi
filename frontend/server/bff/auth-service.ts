import type { LoginStatusDto, MagicLinkStartDto, UserDto } from "@/lib/contracts";

import { bffConfig } from "./config";
import { uuidV7 } from "./ids";
import { prisma } from "./db";
import { enviarEmailDeAcesso } from "./brevo";
import { identityProvider } from "./identity";
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

/**
 * Motivos pelos quais um passo do login pode falhar.
 *
 * `provider_unavailable` e separado de `invalid_code` de proposito: um GoTrue
 * fora do ar nao e um codigo errado. Contar como tentativa faria uma queda de
 * dois segundos consumir o orcamento do usuario, e a tela precisa dizer "tente
 * de novo em instantes" em vez de "codigo incorreto". Vira HTTP 503, e nao 401 -
 * o cliente nao errou nada.
 */
export type AuthFailure =
  | "not_found"
  | "invalid_code"
  | "too_many_attempts"
  | "invalid_email"
  | "provider_unavailable"
  // Pedido repetido para o mesmo e-mail antes do prazo de reenvio. Distinto de
  // `too_many_attempts`, que fala de tentativas de OTP e destrói o pedido: aqui
  // o pedido anterior continua VÁLIDO, e o e-mail pode chegar a qualquer momento.
  | "resend_too_soon";

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

  // Espera de reenvio. Vem ANTES de invalidar o anterior de propósito: quem pede
  // de novo cedo demais fica com o pedido que já tem, e o e-mail que talvez
  // esteja a caminho continua servindo. Invalidar e depois recusar deixaria a
  // pessoa sem nenhum caminho de entrada.
  //
  // A conta é feita na tabela de pedidos, que os DOIS backends compartilham:
  // pedir pelo VINEXT e repetir pelo .NET esbarra no mesmo prazo, porque a
  // espera é do e-mail e não do processo que atendeu.
  if (bffConfig.auth.resendCooldownMs > 0) {
    const recente = await prisma.loginRequest.findFirst({
      where: { email, status: "PENDENTE" },
      orderBy: { criadoEm: "desc" },
    });

    if (recente) {
      const faltamMs =
        recente.criadoEm.getTime() + bffConfig.auth.resendCooldownMs - agora.getTime();

      if (faltamMs > 0) {
        return fail(
          "resend_too_soon",
          `Um acesso ja foi enviado. Aguarde ${Math.ceil(faltamMs / 1000)}s para pedir outro.`,
        );
      }
    }
  }

  // Um novo pedido invalida os anteriores do mesmo e-mail: sem isso, links
  // antigos continuariam validos e quem pediu duas vezes teria dois codigos
  // funcionando ao mesmo tempo.
  await prisma.loginRequest.deleteMany({ where: { email } });

  // O selector e gerado AQUI, e nao pelo provedor: ele e a peca do fluxo que nao
  // pertence a nenhum dos dois modos. E o que sustenta o polling cross-device, e
  // no modo Supabase e ele que viaja no `redirect_to` para ligar o clique no
  // celular ao pedido pollado no desktop.
  const selector = generateToken(24);

  // O provedor decide o resto: gerar e guardar os segredos (modo local) ou
  // delegar tudo ao GoTrue (modo Supabase).
  let desafio;
  try {
    desafio = await identityProvider.iniciarDesafio(email, selector);
  } catch (erro) {
    console.error(`[bff-auth] falha ao iniciar o desafio de acesso para ${email}:`, erro);
    return fail(
      "provider_unavailable",
      "Nao foi possivel iniciar o acesso agora. Tente novamente em instantes.",
    );
  }

  // Os valores que antes vinham de `@default(...)` agora sao explicitos: com o
  // schema compartilhado, quem os define e a aplicacao (o EF Core sempre fez
  // assim). Ter duas fontes de valor para a mesma coluna seria pedir
  // divergencia entre os dois backends.
  //
  // O pedido e gravado MESMO se o desafio falhou: o selector ja vai para o
  // cliente, que ja comeca a pollar, e um pedido ausente daria 404 com a tela
  // dizendo "seu acesso expirou" quando o que houve foi falha de envio.
  await prisma.loginRequest.create({
    data: {
      id: uuidV7(),
      email,
      selector,
      magicTokenHash: desafio.magicTokenHash,
      otpCodeHash: desafio.otpCodeHash,
      otpTentativas: 0,
      status: "PENDENTE",
      provedor: identityProvider.kind,
      criadoEm: agora,
      expiraEm: new Date(agora.getTime() + bffConfig.auth.magicLinkTtlMs),
    },
  });

  const expoe = bffConfig.auth.exposeLoginCodes;

  return {
    ok: true,
    value: {
      selector,
      email,
      email_sent: desafio.emailEnviado,

      // `expoe` decide se PODE mostrar; o provedor decide se TEM o que mostrar.
      // No modo Supabase os dois vem nulos - o link vive dentro do GoTrue e
      // nunca passa por aqui.
      dev_magic_url: expoe ? desafio.magicUrl : null,
      dev_otp_code: expoe ? desafio.otpCode : null,
      // Os textos sao os MESMOS do backend .NET (AuthService.MontarMensagem): a
      // tela de login e uma so, e a mensagem nao deveria mudar conforme o
      // backend selecionado.
      message: montarMensagem(desafio.emailEnviado, desafio.magicUrl, expoe),
    },
  };
}

/**
 * O texto que a tela mostra depois de pedir acesso.
 *
 * Os tres casos existem porque cada um manda o usuario fazer uma coisa
 * diferente, e errar aqui e manda-lo esperar por algo que nao vem. O caso do
 * meio - envio aceito, mas sem link em maos - so acontece no modo Supabase.
 */
function montarMensagem(
  emailEnviado: boolean,
  magicUrl: string | null,
  expoe: boolean,
): string {
  if (emailEnviado) {
    return "Enviamos um link e um codigo de acesso para o seu e-mail.";
  }

  return expoe && magicUrl !== null
    ? "Use o link ou o codigo abaixo para entrar."
    : "Nao foi possivel enviar o e-mail agora. Tente novamente em instantes.";
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

  // Quem valida e o provedor: comparacao de hash em tempo constante no modo
  // local, chamada ao GoTrue no modo Supabase.
  const verificacao = await identityProvider.verificarOtp(
    pedido.email,
    pedido.otpCodeHash,
    code.trim(),
  );

  if (verificacao === "indisponivel") {
    // NAO conta tentativa. Uma queda do provedor nao pode consumir o orcamento
    // do usuario e obriga-lo a pedir um acesso novo.
    return fail(
      "provider_unavailable",
      "Nao foi possivel verificar o codigo agora. Tente novamente em instantes.",
    );
  }

  if (verificacao === "invalido") {
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
 * Aprova o pedido a partir de um token de acesso do provedor externo.
 *
 * <b>Espelho de `AuthService.ApproveWithProviderTokenAsync`.</b> E o caminho
 * cross-device do modo Supabase: o usuario abre o e-mail no celular, o GoTrue
 * valida o magic link dele e redireciona para uma pagina nossa levando o
 * `selector` na query e o token no fragmento da URL. A pagina le o fragmento e
 * chama isto, e o polling que roda no desktop recebe a sessao no ciclo seguinte.
 *
 * <b>As duas verificacoes que fazem isto ser seguro.</b> O selector e PUBLICO -
 * ele viaja em cada chamada de polling -, entao aprovar so por ele deixaria
 * qualquer pessoa que observasse uma requisicao entrar na conta alheia. Por isso:
 *
 *   1. o token e validado CONTRA O PROVEDOR (nao localmente), o que tambem
 *      recusa um token ja revogado;
 *   2. o e-mail que o provedor devolve e comparado com o do pedido - sem isso,
 *      um token valido de OUTRA conta aprovaria este.
 *
 * Devolve `false` para tudo que nao passar. Nenhuma distincao entre "selector
 * inexistente", "token invalido" e "e-mail divergente" chega ao cliente: essa
 * granularidade so ajudaria quem esta sondando.
 */
export async function aprovarComTokenDoProvedor(
  selector: unknown,
  accessToken: unknown,
): Promise<boolean> {
  if (typeof selector !== "string" || !selector) return false;
  if (typeof accessToken !== "string" || !accessToken) return false;

  const pedido = await prisma.loginRequest.findUnique({ where: { selector } });
  if (!pedido) return false;

  if (pedido.expiraEm.getTime() < Date.now()) {
    await prisma.loginRequest.delete({ where: { id: pedido.id } });
    return false;
  }

  // Um pedido do modo LOCAL nao pode ser aprovado por token externo: ele tem o
  // proprio magic token, e aceitar os dois caminhos daria duas formas de aprovar
  // o mesmo pedido - uma delas nao prevista quando ele foi criado.
  if (pedido.provedor !== identityProvider.kind) {
    console.warn(
      `[bff-auth] tentativa de aprovar por token um pedido do provedor ${pedido.provedor}`,
    );
    return false;
  }

  const emailDoToken = await identityProvider.verificarTokenDeAcesso(accessToken);
  if (emailDoToken === null) return false;

  // A comparacao que impede um token valido de outra conta aprovar este pedido.
  if (emailDoToken.toLowerCase() !== pedido.email.toLowerCase()) {
    console.warn(
      `[bff-auth] token de ${emailDoToken} nao corresponde ao pedido de ${pedido.email}`,
    );
    return false;
  }

  // A conta e criada aqui, na confirmacao, e nao ao pedir o acesso: do contrario
  // bastaria digitar e-mails para popular a tabela de usuarios com contas que
  // nunca provaram posse da caixa.
  await getOrCreateUser(pedido.email);

  await prisma.loginRequest.update({
    where: { id: pedido.id },
    data: { status: "APROVADO" },
  });

  console.info(
    `[bff-auth] login aprovado por magic link do ${identityProvider.kind} para ${pedido.email}`,
  );

  return true;
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
