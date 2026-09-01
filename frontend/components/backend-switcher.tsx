"use client";

import * as React from "react";

import { type BackendInfo, getBackends, switchBackend } from "@/lib/api-client";
import type { BackendId } from "@/lib/contracts";
import { cn } from "@/lib/utils";

import { Badge } from "./ui/primitives";

/**
 * Seletor de backend - a interface explicita da troca.
 *
 * Mostra os dois backends com indicador de disponibilidade e troca o ativo com
 * um clique. A escolha vira um cookie lido pelo gateway no servidor; a partir
 * da proxima requisicao, tudo passa a ser atendido pela outra implementacao.
 *
 * <b>Por que avisa antes de trocar com sessao aberta.</b> Cada backend tem o
 * proprio banco e, portanto, os proprios usuarios: a sessao atual nao vale no
 * outro. O servidor encerra a sessao na troca (ver `app/api/backend/route.ts`),
 * e essa consequencia e anunciada antes, nao descoberta depois com um 401 sem
 * explicacao.
 *
 * <b>Recarga completa apos a troca.</b> `window.location.assign` em vez de
 * navegacao do router: a troca muda a origem de TODOS os dados em tela, e
 * remontar a arvore inteira e mais honesto - e mais simples - do que invalidar
 * cada consulta em cache uma por uma.
 */
export function BackendSwitcher({ hasSession }: { hasSession: boolean }) {
  const [backends, setBackends] = React.useState<BackendInfo[]>([]);
  const [active, setActive] = React.useState<BackendId | null>(null);
  const [switching, setSwitching] = React.useState<BackendId | null>(null);
  const [confirming, setConfirming] = React.useState<BackendId | null>(null);

  const carregar = React.useCallback(async () => {
    try {
      const dados = await getBackends();
      setBackends(dados.backends);
      setActive(dados.active);
    } catch {
      // Sem a lista, o seletor simplesmente nao aparece - nao vale quebrar a
      // pagina inteira por causa dele.
    }
  }, []);

  React.useEffect(() => {
    void carregar();

    // Reconsulta a disponibilidade periodicamente: um backend pode cair ou
    // voltar enquanto a tela esta aberta, e o indicador deve refletir isso.
    const timer = setInterval(() => void carregar(), 15_000);
    return () => clearInterval(timer);
  }, [carregar]);

  const trocar = React.useCallback(async (id: BackendId) => {
    setSwitching(id);
    try {
      await switchBackend(id);
      window.location.assign("/");
    } catch {
      setSwitching(null);
      setConfirming(null);
    }
  }, []);

  const selecionar = (id: BackendId) => {
    if (id === active || switching) return;

    // Com sessao aberta, pede confirmacao - a troca vai desloga-lo.
    if (hasSession) {
      setConfirming(id);
      return;
    }

    void trocar(id);
  };

  if (backends.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="hidden text-[0.65rem] font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)] sm:inline">
          Backend
        </span>

        <div
          className="flex rounded-full border border-border-subtle bg-surface p-1"
          role="radiogroup"
          aria-label="Selecionar backend"
        >
          {backends.map((backend) => {
            const ativo = backend.id === active;
            const carregando = switching === backend.id;

            return (
              <button
                key={backend.id}
                type="button"
                role="radio"
                aria-checked={ativo}
                disabled={carregando}
                onClick={() => selecionar(backend.id)}
                title={`${backend.description}${backend.online ? "" : " — fora do ar"}`}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                  ativo
                    ? "bg-brand text-white shadow-sm"
                    : "text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]",
                  carregando && "opacity-60",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    backend.online ? "bg-state-success" : "bg-state-error",
                  )}
                />
                {backend.label}
              </button>
            );
          })}
        </div>
      </div>

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-state-warning/30 bg-state-warning-soft px-3 py-2 text-xs text-state-warning">
          <i className="bi bi-exclamation-triangle-fill" aria-hidden="true" />
          <span className="flex-1">
            Cada backend tem seu próprio banco. Trocar encerra sua sessão atual.
          </span>
          <button
            type="button"
            onClick={() => void trocar(confirming)}
            className="rounded-md bg-state-warning px-2.5 py-1 font-semibold text-white"
          >
            Trocar mesmo assim
          </button>
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className="rounded-md px-2 py-1 font-semibold underline"
          >
            Cancelar
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Confirma qual backend REALMENTE respondeu.
 *
 * Le o campo `backend` de `/health`, que vem da implementacao que atendeu a
 * chamada - nao do cookie que o cliente enviou. E a diferenca entre "pedi para
 * trocar" e "trocou": se o gateway ignorasse a selecao, este indicador
 * denunciaria.
 */
export function ActiveBackendBadge({ backend }: { backend: BackendId | null }) {
  if (!backend) return null;

  return (
    <Badge tone={backend === "dotnet" ? "info" : "brand"}>
      <i className={cn("bi", backend === "dotnet" ? "bi-hdd-stack" : "bi-lightning-charge")} aria-hidden="true" />
      {backend === "dotnet" ? ".NET" : "VINEXT / BFF"}
    </Badge>
  );
}
