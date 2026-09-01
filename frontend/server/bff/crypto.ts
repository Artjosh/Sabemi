import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

import { bffConfig } from "./config";

/**
 * Primitivas criptograficas do backend VINEXT.
 *
 * Espelham o que o backend .NET faz, para que os dois emitam e aceitem
 * exatamente as mesmas provas: mesmo HMAC-SHA256 sobre o corpo bruto, mesmo
 * hash SHA-256 dos segredos de login, mesmo JWT HS256. Uma divergencia aqui
 * seria invisivel ate alguem trocar de backend com uma sessao aberta.
 */

/** SHA-256 em hexadecimal minusculo. Usado nos segredos do fluxo de login. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Comparacao em tempo constante.
 *
 * `a === b` retorna assim que dois bytes diferem, e essa diferenca de tempo,
 * medida com paciencia suficiente, revela o segredo caractere a caractere.
 * Comprimentos diferentes sao rejeitados antes porque `timingSafeEqual` exige
 * buffers do mesmo tamanho - e o comprimento nao e o segredo.
 */
export function fixedTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Token aleatorio url-safe. */
export function generateToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** Codigo OTP de 6 digitos por RNG criptografico (nunca `Math.random`). */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * HMAC-SHA256 do corpo bruto, em hexadecimal minusculo.
 *
 * Precisa receber os BYTES exatos que chegaram na requisicao. Reserializar o
 * JSON antes mudaria espacos e ordem de chaves, e a assinatura nunca conferiria.
 */
export function computeSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

const jwtKey = new TextEncoder().encode(bffConfig.jwt.secret);

/** Emite o JWT de sessao. Mesmo formato e mesmo segredo do backend .NET. */
export async function issueSessionToken(user: { id: string; email: string }): Promise<{
  token: string;
  expiresIn: number;
}> {
  const expiresIn = bffConfig.auth.sessionTtlSeconds;
  const agora = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuer(bffConfig.jwt.issuer)
    .setAudience(bffConfig.jwt.audience)
    .setIssuedAt(agora)
    .setNotBefore(agora)
    .setExpirationTime(agora + expiresIn)
    .setJti(crypto.randomUUID())
    .sign(jwtKey);

  return { token, expiresIn };
}

export interface SessionClaims {
  sub: string;
  email: string;
}

/**
 * Valida o JWT de sessao.
 *
 * Devolve `null` em vez de lancar: para quem chama, "token invalido" e "token
 * expirado" levam a mesma resposta (401), e tratar isso por excecao so
 * espalharia `try/catch` pelos handlers.
 */
export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, jwtKey, {
      issuer: bffConfig.jwt.issuer,
      audience: bffConfig.jwt.audience,
      // Sem tolerancia de relogio: a expiracao configurada e a que vale.
      clockTolerance: 0,
    });

    if (typeof payload.sub !== "string") return null;

    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
    };
  } catch {
    return null;
  }
}
