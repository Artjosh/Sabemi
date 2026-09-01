import { HomeRedirect } from "@/components/home-redirect";

/**
 * Raiz da aplicacao: encaminha para o dashboard ou para o login.
 *
 * A decisao fica no cliente porque depende da sessao restaurada pelo
 * AuthProvider a partir do cookie httpOnly - e ele so sabe o resultado apos a
 * chamada a /api/auth/session.
 */
export default function HomePage() {
  return <HomeRedirect />;
}
