"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Tooltip no padrao shadcn/ui, sobre Radix.
 *
 * <b>Por que Radix e nao `title=""`.</b> O atributo nativo nao abre no teclado,
 * nao abre no toque, demora ~1s para aparecer e nao aceita conteudo formatado -
 * e o que este tooltip precisa mostrar tem duas partes (o que aconteceu e o que
 * fazer). Radix resolve os quatro: abre no foco, tem `role="tooltip"` ligado ao
 * gatilho por `aria-describedby`, e fecha no Esc.
 *
 * <b>Toque.</b> Em telas sem mouse nao existe hover. O gatilho e sempre um
 * `<button>`, entao um toque o foca e o tooltip aparece - por isso
 * `disableHoverableContent` fica desligado e o conteudo continua alcancavel.
 */

/**
 * Provedor obrigatorio do Radix, com atraso curto.
 *
 * 200ms em vez do padrao de 700ms: quem passa o mouse sobre um icone de erro ja
 * decidiu que quer a explicacao, e a espera longa faz o tooltip parecer quebrado.
 */
export function TooltipProvider({
  delayDuration = 200,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        // `max-w-xs` porque o conteudo e prosa: uma linha de 100 caracteres em
        // tela larga fica ilegivel. `z-50` para ficar acima do Dialog, que e de
        // onde este tooltip costuma ser aberto.
        className={cn(
          "z-50 max-w-xs animate-pop-in rounded-[var(--radius-control)] border border-border-subtle bg-surface shadow-pop",
          "px-3.5 py-2.5 text-xs leading-relaxed text-fg",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-surface" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
