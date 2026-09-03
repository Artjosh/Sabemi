import { bffConfig } from "../config";

import { provedorLocal } from "./local";
import { provedorSupabase } from "./supabase";
import type { IdentityProvider } from "./types";

/**
 * Escolhe o provedor de identidade a partir da configuração.
 *
 * <b>A escolha é feita UMA VEZ, na carga do módulo</b> - e não a cada login.
 * Assim ela aparece no log de inicialização e um erro de configuração é
 * descoberto antes de alguém tentar entrar, e não no meio do fluxo.
 *
 * <b>Por que falhar quando `AUTH_PROVIDER=supabase` está sem chaves.</b> Cair
 * para o modo local em silêncio seria pior: quem pediu Supabase acharia que está
 * usando Supabase, e o comportamento observável é quase igual - até o dia em que
 * alguém procura o usuário no painel do Supabase e não o encontra.
 */
function escolher(): IdentityProvider {
  const escolha = (process.env.AUTH_PROVIDER ?? "local").trim().toLowerCase();

  if (escolha !== "supabase") {
    return provedorLocal;
  }

  if (!bffConfig.supabase.url || !bffConfig.supabase.anonKey) {
    throw new Error(
      "AUTH_PROVIDER=supabase exige SUPABASE_URL e SUPABASE_ANON_KEY. " +
        "Configure-as (ver .env) ou use AUTH_PROVIDER=local.",
    );
  }

  return provedorSupabase;
}

export const identityProvider: IdentityProvider = escolher();

export type {
  ChallengeResult,
  IdentityProvider,
  IdentityProviderKind,
  OtpVerification,
} from "./types";
