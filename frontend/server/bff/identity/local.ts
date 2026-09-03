import { enviarEmailDeAcesso } from "../brevo";
import { bffConfig } from "../config";
import { fixedTimeEquals, generateOtp, generateToken, sha256 } from "../crypto";

import type { ChallengeResult, IdentityProvider, OtpVerification } from "./types";

/**
 * Magic link e OTP próprios: nós geramos, guardamos o hash e enviamos.
 *
 * É o modo padrão, e o que a task pede: o fluxo passwordless com confirmação
 * cross-device, sem depender de nenhum serviço externo além do envio do e-mail -
 * que também é opcional (sem provedor, o link vai para o log).
 *
 * <b>Espelho de `LocalIdentityProvider.cs`.</b> Os dois geram os segredos com a
 * mesma entropia e guardam o mesmo hash (SHA-256 em hex minúsculo), o que faz um
 * pedido criado por um backend ser validável pelo outro - eles compartilham a
 * tabela.
 *
 * <b>Os segredos são guardados como hash.</b> Um vazamento do banco não entrega
 * logins ativos. SHA-256 sem salt basta aqui, e a razão é específica: estes
 * valores têm 32 bytes de entropia e vida de 15 minutos, então não há dicionário
 * a proteger - diferente de uma senha escolhida por humano, onde bcrypt/argon2
 * seriam obrigatórios.
 */
export const provedorLocal: IdentityProvider = {
  kind: "LOCAL",

  async iniciarDesafio(email: string, _selector: string): Promise<ChallengeResult> {
    const magicToken = generateToken(32);
    const otpCode = generateOtp();

    const base = bffConfig.auth.publicBaseUrl.replace(/\/$/, "");
    const magicUrl = `${base}/api/bff/auth/confirm?token=${encodeURIComponent(magicToken)}`;

    // O link vai para o log SEMPRE, inclusive quando o e-mail é enviado de
    // verdade. Custa nada e é a diferença entre um suporte de dois minutos e um
    // de meia hora quando alguém diz "não recebi".
    console.info(`[bff-auth] ACESSO ${email} | link: ${magicUrl} | OTP: ${otpCode}`);

    // Sem chave da Brevo não há envio: uma chave vazia enviada a ela devolve 401
    // e polui o log com um erro que não é erro.
    const emailEnviado = bffConfig.brevo.apiKey
      ? await enviarEmailDeAcesso(email, magicUrl, otpCode)
      : false;

    return {
      magicTokenHash: sha256(magicToken),
      otpCodeHash: sha256(otpCode),
      emailEnviado,
      magicUrl,
      otpCode,
    };
  },

  async verificarOtp(
    _email: string,
    otpCodeHash: string | null,
    code: string,
  ): Promise<OtpVerification> {
    // Um pedido sem hash não pode ser validado aqui. Acontece se o provedor for
    // trocado com pedidos em voo: o pedido nasceu no modo Supabase e esta
    // implementação assumiu o lugar. Tratar como inválido (e não estourar) faz o
    // usuário receber "código incorreto" e pedir um acesso novo - que já sairá
    // pelo provedor certo.
    if (otpCodeHash === null) return "invalido";

    // Comparação em tempo constante: comparar hashes com `===` vazaria, pelo
    // tempo de resposta, quantos caracteres iniciais estão corretos.
    return fixedTimeEquals(otpCodeHash, sha256(code.trim())) ? "valido" : "invalido";
  },

  /**
   * Sempre `null`: neste modo não há provedor externo emitindo token.
   *
   * A rota que consome isto responde 404 no modo local. Devolver `null` em vez
   * de lançar mantém a decisão em um só lugar - a rota - em vez de espalhar um
   * `try/catch` por causa de um caminho que simplesmente não existe aqui.
   */
  async verificarTokenDeAcesso(): Promise<string | null> {
    return null;
  },
};
