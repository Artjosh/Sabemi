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
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-brand text-white hover:bg-brand-strong shadow-sm",
        outline:
          "border border-border-subtle bg-surface hover:bg-surface-muted text-[color:var(--foreground)]",
        ghost: "hover:bg-surface-muted text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]",
        danger: "bg-state-error text-white hover:opacity-90 shadow-sm",
        subtle: "bg-surface-muted text-[color:var(--foreground)] hover:bg-border-subtle",
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

export { buttonVariants };
