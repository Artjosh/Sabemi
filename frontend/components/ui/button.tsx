"use client";

import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Botao no padrao shadcn/ui.
 *
 * As variantes sao declaradas com `cva` em vez de condicionais no JSX: o
 * conjunto de aparencias fica visivel num lugar so, e o TypeScript passa a
 * recusar uma variante que nao existe - em vez de renderizar um botao sem
 * estilo.
 *
 * `asChild` delega a renderizacao ao filho (via Radix Slot). E o que permite um
 * link com aparencia de botao sem aninhar `<a>` dentro de `<button>`, que e HTML
 * invalido e quebra a navegacao por teclado.
 *
 * <b>O recuo ao clicar</b> (`active:translate-y-px`) existe porque o painel tem
 * acoes que nao mudam a tela na hora - "Atualizar" com os mesmos dados, por
 * exemplo. Sem retorno tatil o operador clica de novo achando que nao pegou.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)]",
    "text-sm font-medium",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-150",
    "active:translate-y-px",
    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/20",
    "disabled:pointer-events-none disabled:opacity-45",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-brand text-brand-contrast shadow-card hover:bg-brand-strong hover:shadow-lift",
        outline:
          "border border-border-subtle bg-surface text-fg hover:border-border-strong hover:bg-surface-muted",
        ghost: "text-fg-muted hover:bg-surface-muted hover:text-fg",
        danger: "bg-state-error text-white shadow-card hover:opacity-90",
        subtle: "bg-surface-muted text-fg hover:bg-border-subtle",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        default: "h-10 px-4",
        lg: "h-11 px-6 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";
