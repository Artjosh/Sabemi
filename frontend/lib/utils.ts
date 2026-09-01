import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combina classes resolvendo conflitos do Tailwind.
 *
 * `clsx` monta a lista condicional; `twMerge` remove os conflitos - com
 * `cn("px-4", "px-6")` sobra apenas `px-6`. Sem isso, um componente que aceita
 * `className` para ajuste pontual nao conseguiria sobrescrever o proprio padrao:
 * as duas classes ficariam na string e venceria a que aparece depois no CSS
 * gerado, nao a que quem chamou pediu.
 *
 * E a mesma funcao que o shadcn/ui usa; os componentes em `components/ui/`
 * dependem dela.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Formata um valor em reais. `null` vira travessao, nao "R$ 0,00". */
export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

/** Data e hora no formato brasileiro, curto o suficiente para caber na tabela. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const data = new Date(value);
  if (Number.isNaN(data.getTime())) return "—";

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(data);
}

/**
 * Tempo relativo ("ha 5 s").
 *
 * O dashboard atualiza sozinho por polling; saber que um evento chegou "ha 5
 * segundos" responde a pergunta que o operador realmente tem - se o fluxo esta
 * vivo - melhor do que um horario absoluto que ele precisaria comparar com o
 * relogio.
 */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const data = new Date(value);
  if (Number.isNaN(data.getTime())) return "—";

  const segundos = Math.round((Date.now() - data.getTime()) / 1000);

  if (segundos < 5) return "agora";
  if (segundos < 60) return `há ${segundos} s`;
  if (segundos < 3600) return `há ${Math.floor(segundos / 60)} min`;
  if (segundos < 86400) return `há ${Math.floor(segundos / 3600)} h`;
  return `há ${Math.floor(segundos / 86400)} d`;
}
