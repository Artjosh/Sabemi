/**
 * Quem envia o desafio de acesso e quem valida o código digitado.
 *
 * <b>Espelho de `Sabemi.Application/Auth/IIdentityProvider.cs`.</b> Os dois
 * backends compartilham a tabela de pedidos de login, então precisam concordar
 * sobre o que um pedido significa - inclusive sobre quem pode aprová-lo.
 *
 * <b>O que esta abstração NÃO cobre, e por quê.</b> Ela não cobre o pedido de
 * login em si - o `selector`, o polling, o uso único. Isso continua sempre
 * local, porque é o que dá o fluxo cross-device (pedir no desktop, confirmar no
 * celular) e o GoTrue não tem esse conceito: ele emite um magic link e espera o
 * clique redirecionar o MESMO navegador.
 *
 * A divisão é o que permite ter os dois: a identidade é verificada por um
 * serviço dedicado, e a experiência cross-device continua funcionando.
 */

/** Quem valida a identidade de um pedido. Gravado na linha `provedor`. */
export type IdentityProviderKind = "LOCAL" | "SUPABASE";

/** O que o desafio produziu. */
export interface ChallengeResult {
  /**
   * Dados do pedido a persistir.
   *
   * `magicTokenHash` e `otpCodeHash` são `null` no modo Supabase: quem guarda e
   * valida os segredos é o GoTrue.
   */
  magicTokenHash: string | null;
  otpCodeHash: string | null;

  /**
   * Houve envio real? É o que decide se a tela diz "confira seu e-mail" ou
   * mostra o código. Uma promessa errada aqui manda o usuário procurar um
   * e-mail que nunca vai chegar.
   */
  emailEnviado: boolean;

  /**
   * Link de confirmação, quando existe e pode ser mostrado. `null` no modo
   * Supabase: o link é montado dentro do GoTrue e nunca passa por aqui - e é
   * por isso que, nesse modo, a demonstração sem SMTP depende do log do
   * container do GoTrue.
   */
  magicUrl: string | null;

  /** Código, sob a mesma condição do link. `null` no modo Supabase. */
  otpCode: string | null;
}

/**
 * Desfecho da validação de um código.
 *
 * `indisponivel` é separado de `invalido` de propósito: um provedor fora do ar
 * não é um código errado. Contar como tentativa faria uma queda de dois segundos
 * do GoTrue consumir o orçamento do usuário e obrigá-lo a pedir um acesso novo -
 * e a tela precisa dizer "tente de novo em instantes", não "código incorreto".
 */
export type OtpVerification = "valido" | "invalido" | "indisponivel";

export interface IdentityProvider {
  /** Qual provedor esta implementação representa. */
  readonly kind: IdentityProviderKind;

  /**
   * Prepara o pedido e dispara o desafio.
   *
   * @param email Já normalizado (minúsculas, sem espaços).
   * @param selector Identificador público do pedido, gerado por quem chama. Vai
   *   para o `redirect_to` no modo Supabase, porque é o que permite ao clique no
   *   celular aprovar o pedido que está sendo pollado no desktop.
   */
  iniciarDesafio(email: string, selector: string): Promise<ChallengeResult>;

  /**
   * Valida o código digitado.
   *
   * @param otpCodeHash O hash gravado no pedido. Usado no modo local; ignorado
   *   no modo Supabase, onde quem compara é o GoTrue.
   */
  verificarOtp(
    email: string,
    otpCodeHash: string | null,
    code: string,
  ): Promise<OtpVerification>;

  /**
   * Valida um token de acesso do provedor e devolve o e-mail do dono, ou `null`.
   *
   * <b>Por que isto é necessário.</b> No modo Supabase, o clique no magic link
   * cai num endpoint nosso que carrega o `selector` na query - e o selector é
   * PÚBLICO por desenho (ele viaja em cada chamada de polling). Aprovar o pedido
   * apenas por ele deixaria qualquer pessoa que observasse uma requisição de
   * polling entrar na conta alheia.
   *
   * Então o que aprova não é o selector: é o token que o GoTrue emitiu, e que só
   * existe para quem realmente abriu o e-mail.
   */
  verificarTokenDeAcesso(accessToken: string): Promise<string | null>;
}
