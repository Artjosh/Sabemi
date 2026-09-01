import type { Metadata } from "next";

import { AuthProvider } from "@/components/auth-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sabemi · Painel de Pagamentos",
  description:
    "Recebimento idempotente de webhooks de pagamento com processamento assíncrono e painel administrativo.",
};

/**
 * Layout raiz.
 *
 * O `AuthProvider` envolve toda a aplicacao porque a sessao e consultada tanto
 * pelo login (para redirecionar quem ja entrou) quanto pelo dashboard (para
 * proteger a rota). Um provider por pagina duplicaria a restauracao de sessao e
 * dispararia duas chamadas a `/api/auth/session` em cada navegacao.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
