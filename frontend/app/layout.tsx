import type { Metadata } from "next";

import { AuthProvider } from "@/components/auth-provider";
import { THEME_STORAGE_KEY } from "@/lib/utils";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sabemi · Painel de Pagamentos",
  description:
    "Recebimento idempotente de webhooks de pagamento com processamento assíncrono e painel administrativo.",
};

/**
 * Aplica o tema salvo ANTES da primeira pintura.
 *
 * Sem isto a pagina aparece na cor do sistema por um quadro e so depois troca
 * para a escolhida - o "flash" branco que faz um painel escuro parecer quebrado
 * a cada F5. Um efeito do React nao serve: ele roda depois da hidratacao, e a
 * primeira pintura ja aconteceu.
 *
 * E deliberadamente minusculo e tolerante a falha: se o armazenamento estiver
 * bloqueado, o `catch` deixa o `prefers-color-scheme` decidir, que e o padrao.
 */
const SCRIPT_TEMA = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

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
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SCRIPT_TEMA }} />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
