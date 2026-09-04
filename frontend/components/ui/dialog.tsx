"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Dialog no padrao shadcn/ui, sobre Radix.
 *
 * Usado no detalhe do evento, onde aparece o payload bruto recebido. Radix
 * cuida do que um modal caseiro erra com frequencia: prender o foco dentro do
 * dialogo, devolve-lo ao elemento de origem ao fechar, fechar no Esc e esconder
 * o resto da pagina dos leitores de tela.
 */

// Apenas o Root e reexportado: este dialogo e controlado por prop (`open`), e
// nao por um elemento disparador. Reexportar Trigger e Close so por convencao
// deixaria dois simbolos mortos no repositorio.
export const Dialog = DialogPrimitive.Root;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-canvas/70 backdrop-blur-md" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2",
        // `animate-pop-in` anima `scale` e opacidade. A centralizacao usa
        // `translate`, que no Tailwind v4 e uma propriedade separada - por isso
        // uma nao desfaz a outra.
        "animate-pop-in",
        "max-h-[85vh] overflow-y-auto rounded-[var(--radius-card)] border border-border-subtle bg-surface p-6 shadow-pop",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-4 top-4 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg focus:outline-none focus:ring-2 focus:ring-brand"
        aria-label="Fechar"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-5 flex flex-col gap-1 pr-10", className)} {...props} />;
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-tight tracking-[-0.01em]", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-fg-muted", className)} {...props} />
));
DialogDescription.displayName = "DialogDescription";
