"use client";

import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";

import type { ProcessingStatus } from "@/lib/contracts";
import { cn } from "@/lib/utils";

/**
 * Primitivas visuais no padrao shadcn/ui.
 *
 * Agrupadas num arquivo por serem pequenas e sempre usadas juntas nas telas do
 * painel. Componentes que carregam comportamento proprio (Button, Select) ficam
 * em arquivos separados.
 */

// ------------------------------------------------------------------- Card

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-border-subtle bg-surface shadow-card",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-5 pb-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-[0.95rem] font-semibold leading-tight tracking-[-0.01em]", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm leading-relaxed text-fg-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2 p-5 pt-0", className)} {...props} />;
}

// ------------------------------------------------------------------ Badge

/**
 * O anel de 1px na cor do estado, alem do fundo suave, e o que mantem o badge
 * legivel nas duas faces do tema: no escuro os fundos "soft" sao escuros e, sem
 * a borda, a pilula se dissolve no cartao.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold leading-none whitespace-nowrap ring-1 ring-inset",
  {
    variants: {
      tone: {
        neutral: "bg-state-neutral-soft text-state-neutral ring-state-neutral/20",
        success: "bg-state-success-soft text-state-success ring-state-success/25",
        error: "bg-state-error-soft text-state-error ring-state-error/25",
        warning: "bg-state-warning-soft text-state-warning ring-state-warning/25",
        info: "bg-state-info-soft text-state-info ring-state-info/25",
        brand: "bg-brand-soft text-brand-strong ring-brand/25",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/**
 * Aparencia de cada situacao de processamento.
 *
 * Fica num mapa unico, e nao espalhado em condicionais nas telas, porque a
 * mesma situacao aparece na tabela, nos cartoes e no detalhe. Se cada lugar
 * decidisse a propria cor, um "ERRO" verde em alguma tela seria so questao de
 * tempo.
 *
 * A escolha dos tons segue a acao que o operador precisa tomar:
 *
 *   SUCESSO/ERRO     - o desfecho, o que ele procura.
 *   INVALIDO         - erro de validacao: nao vai se resolver sozinho, alguem
 *                      precisa olhar. Vermelho, como ERRO, porem com icone
 *                      diferente para nao serem confundidos.
 *   PENDENTE/PROCESSANDO - estados intermediarios de um sistema assincrono.
 *                      Neutro e azul: sao normais, nao exigem acao.
 *   DUPLICADO        - informativo.
 *
 * O icone acompanha a cor de proposito: cor sozinha nao e acessivel a quem nao
 * distingue verde de vermelho.
 */
const STATUS_APPEARANCE: Record<
  ProcessingStatus,
  { tone: NonNullable<BadgeProps["tone"]>; icon: string; label: string }
> = {
  SUCESSO: { tone: "success", icon: "bi-check-circle-fill", label: "Sucesso" },
  ERRO: { tone: "error", icon: "bi-x-octagon-fill", label: "Erro" },
  INVALIDO: { tone: "error", icon: "bi-exclamation-triangle-fill", label: "Inválido" },
  PENDENTE: { tone: "neutral", icon: "bi-hourglass-split", label: "Pendente" },
  PROCESSANDO: { tone: "info", icon: "bi-arrow-repeat", label: "Processando" },
  DUPLICADO: { tone: "warning", icon: "bi-files", label: "Duplicado" },
};

/** Badge da situacao de um evento: cor + icone + rotulo. */
export function StatusBadge({ status, className }: { status: ProcessingStatus; className?: string }) {
  const aparencia = STATUS_APPEARANCE[status] ?? STATUS_APPEARANCE.PENDENTE;

  return (
    <Badge tone={aparencia.tone} className={className}>
      <i
        className={cn(
          "bi",
          aparencia.icon,
          // O icone de "processando" gira, deixando visivel que algo esta
          // acontecendo agora - e nao apenas parado neste estado.
          status === "PROCESSANDO" && "animate-spin",
        )}
        aria-hidden="true"
      />
      {aparencia.label}
    </Badge>
  );
}

// ------------------------------------------------------------------ Input

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-[var(--radius-control)] border border-border-subtle bg-surface px-3 py-2 text-sm",
        "transition-[border-color,box-shadow] duration-150",
        "placeholder:text-fg-muted/70",
        "hover:border-border-strong",
        // O anel substitui o outline global para o campo nao "pular" ao focar:
        // um `box-shadow` nao ocupa espaco no layout.
        "focus-visible:border-brand focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

// ------------------------------------------------------------------ Alert

const alertVariants = cva(
  "flex gap-3 rounded-[var(--radius-control)] border p-4 text-sm leading-relaxed",
  {
    variants: {
      tone: {
        info: "border-state-info/25 bg-state-info-soft text-state-info",
        success: "border-state-success/25 bg-state-success-soft text-state-success",
        error: "border-state-error/25 bg-state-error-soft text-state-error",
        warning: "border-state-warning/25 bg-state-warning-soft text-state-warning",
      },
    },
    defaultVariants: { tone: "info" },
  },
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  icon?: string;
}

export function Alert({ className, tone, icon, children, ...props }: AlertProps) {
  return (
    <div role="alert" className={cn(alertVariants({ tone }), className)} {...props}>
      {icon ? (
        <i className={cn("bi", icon, "mt-px shrink-0 text-base leading-none")} aria-hidden="true" />
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// --------------------------------------------------------------- Skeleton

/**
 * Placeholder de carregamento.
 *
 * Preferivel a um spinner na tabela: preserva a altura das linhas e evita o
 * salto de layout quando os dados chegam.
 *
 * O brilho que atravessa e um gradiente animado, e nao o `animate-pulse` do
 * Tailwind: o pulso faz o bloco inteiro escurecer e clarear junto, o que a
 * cinco blocos empilhados parece a tela toda piscando. A varredura sugere
 * carregamento sem competir com o resto da interface.
 *
 * O `data-slot` existe para o teste que verifica "a tela mostra o esqueleto
 * durante a restauracao da sessao". Ele procurava pela classe `.animate-pulse`,
 * o que amarrava um teste de COMPORTAMENTO ao nome de um utilitario do Tailwind:
 * trocar a animacao derrubava o teste sem que nada tivesse quebrado de verdade.
 * O atributo e um contrato estavel, e e a convencao que o proprio shadcn/ui
 * adotou para o mesmo problema.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-shimmer rounded-md bg-surface-muted",
        "bg-[linear-gradient(100deg,transparent_35%,var(--color-border-subtle)_50%,transparent_65%)]",
        "bg-[length:200%_100%]",
        className,
      )}
      aria-hidden="true"
      {...props}
    />
  );
}

// ------------------------------------------------------------------ Table

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  // O contêiner rolavel evita que uma tabela larga empurre a pagina para os
  // lados no celular - a rolagem horizontal fica contida na tabela.
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("border-y border-border-subtle bg-surface-muted/60", className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-border-subtle", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn("transition-colors duration-150 hover:bg-surface-muted", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "px-4 py-2.5 text-left text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3.5 align-middle", className)} {...props} />;
}

// -------------------------------------------------------------- Separator

export function Separator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("h-px w-full bg-border-subtle", className)} role="separator" {...props} />;
}
