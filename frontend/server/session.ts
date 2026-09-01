import type { BackendId } from "@/lib/contracts";
import { DEFAULT_BACKEND, isBackendId } from "./backends/registry";

/**
 * Cookies e configuracao de sessao do BFF.
 *
 * <b>O padrao adotado.</b> O token de sessao NAO vive no browser. Ele fica num
 * cookie `httpOnly` gerenciado pelos route handlers do VINEXT, e o servidor o
 * reinjeta como `Authorization: Bearer` ao falar com o backend ativo.
 *
 * O ganho e concreto: um XSS no dashboard nao encontra o token para roubar,
 * porque ele nunca esteve ao alcance do JavaScript. Guardar em `localStorage` -
 * o caminho mais comum - deixa o token a uma linha de distancia de qualquer
 * script injetado.
 *
 * O cookie do backend selecionado e o oposto: precisa ser legivel pelo cliente,
 * para a interface mostrar qual esta ativo sem uma ida ao servidor. Nao e
 * segredo - e uma preferencia.
 */

/** Cookie httpOnly com o JWT da sessao. Nunca legivel pelo JavaScript. */
export const SESSION_COOKIE = "sabemi_session";

/** Cookie legivel pelo cliente com o backend selecionado. */
export const BACKEND_COOKIE = "sabemi_backend";

const ONE_DAY_SECONDS = 60 * 60 * 24;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const isProduction = process.env.NODE_ENV === "production";

/**
 * Opcoes do cookie de sessao.
 *
 * `sameSite: lax` permite que o retorno do link de confirmacao (navegacao
 * top-level vinda do cliente de e-mail) chegue com o cookie; `strict` quebraria
 * esse caminho. `secure` so em producao, senao o cookie nao seria aceito em
 * `http://localhost` durante o desenvolvimento.
 */
export function sessionCookieOptions(maxAge: number = ONE_DAY_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    path: "/",
    maxAge,
  };
}

/** Opcoes do cookie do backend: legivel pelo cliente, de proposito. */
export function backendCookieOptions() {
  return {
    httpOnly: false,
    sameSite: "lax" as const,
    secure: isProduction,
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  };
}

/** Le o backend selecionado, caindo no primario quando ausente ou invalido. */
export function resolveBackend(cookieValue: string | undefined | null): BackendId {
  return isBackendId(cookieValue) ? cookieValue : DEFAULT_BACKEND;
}
