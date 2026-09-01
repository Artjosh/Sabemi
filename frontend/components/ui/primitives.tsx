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
        "rounded-[var(--radius-card)] border border-border-subtle bg-surface shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-5 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-base font-semibold leading-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-sm text-[color:var(--muted-foreground)]", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2 p-5 pt-0", className)} {...props} />;
}

// ------------------------------------------------------------------ Badge

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-state-neutral-soft text-state-neutral",
        success: "bg-state-success-soft text-state-success",
        error: "bg-state-error-soft text-state-error",
        warning: "bg-state-warning-soft text-state-warning",
        info: "bg-state-info-soft text-state-info",
        brand: "bg-brand-soft text-brand-strong",
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
        "flex h-10 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm",
        "placeholder:text-[color:var(--muted-foreground)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-0",
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
        "text-xs font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]",
        className,
      )}
      {...props}
    />
  );
}

// ------------------------------------------------------------------ Alert

const alertVariants = cva("flex gap-3 rounded-lg border p-4 text-sm", {
  variants: {
    tone: {
      info: "border-state-info/30 bg-state-info-soft text-state-info",
      success: "border-state-success/30 bg-state-success-soft text-state-success",
      error: "border-state-error/30 bg-state-error-soft text-state-error",
      warning: "border-state-warning/30 bg-state-warning-soft text-state-warning",
    },
  },
  defaultVariants: { tone: "info" },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  icon?: string;
}

export function Alert({ className, tone, icon, children, ...props }: AlertProps) {
  return (
    <div role="alert" className={cn(alertVariants({ tone }), className)} {...props}>
      {icon ? <i className={cn("bi", icon, "mt-0.5 shrink-0")} aria-hidden="true" /> : null}
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
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-muted", className)}
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
  return <thead className={cn("border-b border-border-subtle", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-border-subtle", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors hover:bg-surface-muted", className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...props} />;
}

// -------------------------------------------------------------- Separator

export function Separator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("h-px w-full bg-border-subtle", className)} role="separator" {...props} />;
}
