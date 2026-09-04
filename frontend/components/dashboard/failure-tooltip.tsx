"use client";

import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FailureCategory, FailureDiagnosisDto } from "@/lib/contracts";
import { cn } from "@/lib/utils";

/**
 * Explica ao operador, em portugues, por que um evento falhou.
 *
 * <b>O problema que resolve.</b> Antes, a coluna de erro mostrava a mensagem
 * crua da excecao - algo como
 * `23503: insert or update on table "contract_statuses" violates foreign key
 * constraint`. Para quem opera a conciliacao isso nao diz nem o que aconteceu
 * nem o que fazer. A mensagem tecnica continua disponivel no detalhe do evento,
 * onde e util para quem investiga; aqui vai a leitura.
 *
 * <b>Os textos vem do backend.</b> Nao ha catalogo de mensagens neste arquivo,
 * de proposito: os dois backends implementam o mesmo contrato e devolvem o mesmo
 * `diagnostico`. Um catalogo duplicado no cliente divergiria na primeira vez que
 * so um dos lados fosse atualizado.
 */

/** Como cada categoria se apresenta. */
const APARENCIA: Record<
  FailureCategory,
  { icone: string; classe: string; rotulo: string }
> = {
  // Transitoria: o sistema esta cuidando. Ambar, nao vermelho - alarmar o
  // operador por algo que se resolve sozinho gasta a atencao dele a toa.
  TRANSITORIA: {
    icone: "bi-arrow-repeat",
    classe: "text-state-warning",
    rotulo: "Falha temporária",
  },

  // Permanente: ninguem mais vai tentar. E o unico caso que exige acao humana.
  PERMANENTE: {
    icone: "bi-exclamation-octagon-fill",
    classe: "text-state-error",
    rotulo: "Falha definitiva",
  },

  DESCONHECIDA: {
    icone: "bi-question-circle-fill",
    classe: "text-state-warning",
    rotulo: "Falha não classificada",
  },
};

interface FailureTooltipProps {
  diagnostico: FailureDiagnosisDto;
  /** Mensagem tecnica crua. Mostrada em ultimo, para quem investiga. */
  mensagemTecnica?: string | null;
  className?: string;
}

/**
 * Icone com tooltip. O gatilho e um `<button type="button">` - e nao um `<span>`
 * - porque so um elemento focavel abre o tooltip pelo teclado e pelo toque.
 */
export function FailureTooltip({
  diagnostico,
  mensagemTecnica,
  className,
}: FailureTooltipProps) {
  const aparencia = APARENCIA[diagnostico.categoria] ?? APARENCIA.DESCONHECIDA;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // `cursor-help` sinaliza que ha algo a ler; sem `onClick`, porque a
          // acao do botao E abrir o tooltip (o Radix cuida disso).
          className={cn(
            "inline-flex cursor-help items-center gap-1.5 rounded-full px-2 py-1 transition-colors",
            "hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
            aparencia.classe,
            className,
          )}
          // O texto acessivel nao pode ser so "erro": um leitor de tela
          // anunciaria um botao sem sentido. O tooltip em si vira
          // `aria-describedby` pelo Radix.
          aria-label={`${aparencia.rotulo}: ${diagnostico.explicacao}`}
        >
          <i className={cn("bi", aparencia.icone)} aria-hidden="true" />
          <span className="text-xs font-medium">{aparencia.rotulo}</span>
        </button>
      </TooltipTrigger>

      <TooltipContent>
        <p className="font-semibold">{aparencia.rotulo}</p>
        <p className="mt-1">{diagnostico.explicacao}</p>

        <p className="mt-2 border-t border-border-subtle pt-2">
          <span className="font-semibold">O que fazer: </span>
          {diagnostico.acao_sugerida}
        </p>

        {/* O codigo aparece porque e o que a pessoa cola ao pedir ajuda, e o que
            aparece na metrica. A mensagem tecnica vem por ultimo e truncada: ela
            e contexto, nao o assunto principal do tooltip. */}
        <p className="mt-2 font-mono text-[10px] text-fg-muted">
          {diagnostico.codigo}
          {mensagemTecnica ? ` · ${mensagemTecnica.slice(0, 120)}` : null}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
