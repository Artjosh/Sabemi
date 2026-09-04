"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { useAuth } from "@/components/auth-provider";
import { PaymentsDashboard } from "@/components/dashboard/payments-dashboard";
import { Skeleton } from "@/components/ui/primitives";

/**
 * Protege o dashboard.
 *
 * <b>Sobre a natureza desta protecao.</b> Ela e de EXPERIENCIA, nao de
 * seguranca. Um usuario sem sessao e mandado para o login em vez de ver uma tela
 * vazia cheia de erros. A protecao real esta no servidor: o gateway so anexa o
 * token do cookie httpOnly, e o backend recusa qualquer consulta sem sessao
 * valida. Remover este componente pelo devtools nao daria acesso a dado algum -
 * daria uma tela de erros.
 *
 * O estado de carregamento importa: sem ele, o F5 mostraria o login por um
 * instante antes de a sessao ser restaurada, o que parece um logout aleatorio.
 */
export function DashboardGuard() {
  const { user, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-6">
        <Skeleton className="h-14 w-full rounded-[var(--radius-card)]" />
        <div className="flex gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 flex-1 rounded-[var(--radius-card)]" />
          ))}
        </div>
        <Skeleton className="h-96 w-full rounded-[var(--radius-card)]" />
      </div>
    );
  }

  return <PaymentsDashboard />;
}
