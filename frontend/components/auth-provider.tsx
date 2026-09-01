"use client";

import * as React from "react";

import { ApiError, clearSession, getSession, pollLogin, startLogin, verifyOtp } from "@/lib/api-client";
import type { BackendId, MagicLinkStartDto, UserDto } from "@/lib/contracts";

/**
 * Estado de autenticacao do cliente, incluindo o polling cross-device.
 *
 * <b>O problema que o polling resolve.</b> O operador pede o link no desktop e
 * pode abri-lo no celular. A aba do desktop precisa descobrir sozinha que o
 * login foi confirmado - sem ninguem recarregar nada. Ela pergunta ao servidor
 * em intervalo fixo e, ao receber a aprovacao, entra.
 *
 * <b>Por que aqui nao ha token.</b> Quando o polling e aprovado, quem grava o
 * cookie de sessao e o servidor; a resposta traz apenas o usuario. Este
 * componente nunca ve um token e portanto nao tem como vaza-lo.
 *
 * <b>As tres formas de o polling terminar</b> - e nenhuma delas e "girar para
 * sempre":
 *
 *   1. aprovado - o servidor gravou o cookie, o usuario entra;
 *   2. `404`    - o pedido expirou ou ja foi consumido; para imediatamente;
 *   3. prazo    - passou o TTL do link (15 min) sem confirmacao.
 *
 * Falha de rede NAO encerra o polling: o backend pode estar reiniciando, e a
 * proxima tentativa provavelmente funciona. So um `404` e definitivo.
 */

/** Intervalo entre consultas. */
const POLL_INTERVAL_MS = 2500;

/** Teto do polling - acompanha a validade do link no servidor. */
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

export type PollOutcome = "approved" | "expired" | "cancelled" | "error";

interface AuthContextValue {
  user: UserDto | null;
  /** Sessao ainda sendo restaurada: evita piscar a tela de login no F5. */
  loading: boolean;
  backend: BackendId | null;
  setUser: (user: UserDto | null) => void;
  beginLogin: (email: string) => Promise<MagicLinkStartDto>;
  /** Consulta ate aprovar, expirar ou ser cancelado. */
  pollUntilAuthenticated: (selector: string, signal: { cancelled: boolean }) => Promise<PollOutcome>;
  submitOtp: (selector: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<UserDto | null>(null);
  const [backend, setBackend] = React.useState<BackendId | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Restaura a sessao a partir do cookie httpOnly. Roda uma vez, na montagem.
  React.useEffect(() => {
    let activo = true;

    (async () => {
      try {
        const sessao = await getSession();
        if (activo) {
          setUser(sessao.user);
          setBackend(sessao.backend);
        }
      } catch {
        // Sem sessao e o estado normal de quem ainda nao entrou - nao e erro.
        if (activo) setUser(null);
      } finally {
        if (activo) setLoading(false);
      }
    })();

    return () => {
      activo = false;
    };
  }, []);

  const beginLogin = React.useCallback(async (email: string) => {
    return startLogin(email);
  }, []);

  const pollUntilAuthenticated = React.useCallback(
    async (selector: string, signal: { cancelled: boolean }): Promise<PollOutcome> => {
      const prazo = Date.now() + POLL_TIMEOUT_MS;

      while (!signal.cancelled && Date.now() < prazo) {
        try {
          const resultado = await pollLogin(selector);

          if (resultado.status === "approved" && resultado.user) {
            // O cookie ja foi gravado pelo servidor neste mesmo passo.
            if (!signal.cancelled) setUser(resultado.user);
            return "approved";
          }
        } catch (error) {
          // Pedido consumido ou expirado: insistir nao mudaria nada.
          if (error instanceof ApiError && error.isGone) return "expired";

          // Qualquer outra falha (rede, backend reiniciando) e tratada como
          // transitoria: o proximo ciclo tenta de novo. Desistir aqui abandonaria
          // um login que estava prestes a funcionar.
        }

        await sleep(POLL_INTERVAL_MS);
      }

      return signal.cancelled ? "cancelled" : "expired";
    },
    [],
  );

  const submitOtp = React.useCallback(async (selector: string, code: string) => {
    const resultado = await verifyOtp(selector, code);
    if (resultado.user) setUser(resultado.user);
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await clearSession();
    } catch {
      // Mesmo que a chamada falhe, o estado local e limpo: manter o usuario na
      // tela apos ele pedir para sair seria pior do que um cookie orfao.
    }
    setUser(null);

    // Navegacao "dura" em vez de router.push: garante que a proxima requisicao
    // ja saia sem o cookie, evitando a corrida em que o servidor ainda enxerga a
    // sessao e devolve o dashboard.
    if (typeof window !== "undefined") window.location.assign("/login");
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ user, loading, backend, setUser, beginLogin, pollUntilAuthenticated, submitOtp, logout }),
    [user, loading, backend, beginLogin, pollUntilAuthenticated, submitOtp, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth precisa estar dentro de <AuthProvider>.");
  return ctx;
}

export { POLL_INTERVAL_MS, POLL_TIMEOUT_MS };
