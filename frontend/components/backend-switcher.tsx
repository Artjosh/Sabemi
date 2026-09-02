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
 * <b>A troca e imediata e NAO desloga.</b> Os dois backends compartilham o
 * schema `sabemi` - as mesmas tabelas, os mesmos usuarios e os mesmos
 * pagamentos - e assinam a sessao com o mesmo segredo. O operador troca de
 * implementacao e continua exatamente onde estava, vendo os mesmos dados.
 *
 * <b>Recarga completa apos a troca.</b> `window.location.reload` em vez de
 * navegacao do router: a troca muda a ORIGEM de todos os dados em tela, e
 * remontar a arvore inteira e mais simples - e mais honesto - do que invalidar
 * cada consulta em cache uma por uma.
 */
export function BackendSwitcher() {
  const [backends, setBackends] = React.useState<BackendInfo[]>([]);
  const [active, setActive] = React.useState<BackendId | null>(null);
  const [switching, setSwitching] = React.useState<BackendId | null>(null);

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

  const selecionar = React.useCallback(
    async (id: BackendId) => {
      if (id === active || switching) return;

      setSwitching(id);
      try {
        await switchBackend(id);

        // Recarrega no MESMO lugar, e nao na raiz: a sessao sobrevive a troca,
        // entao nao ha razao para tirar o operador de onde ele estava.
        window.location.reload();
      } catch {
        setSwitching(null);
      }
    },
    [active, switching],
  );

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
                onClick={() => void selecionar(backend.id)}
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
