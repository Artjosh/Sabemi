import { z } from "zod";

import type { PartnerStatus } from "@/lib/contracts";

/**
 * Validacao do payload do webhook no backend VINEXT.
 *
 * As mensagens sao identicas as do backend .NET
 * (`PaymentWebhookRequestValidator`), por escolha: elas aparecem no dashboard,
 * e um mesmo payload defeituoso deve produzir o mesmo texto de erro
 * independentemente de qual backend o recebeu. Se divergissem, o operador
 * concluiria que os dois estao aplicando regras diferentes.
 */

/**
 * Tolerancia para `data_pagamento` no futuro, absorvendo relogios
 * dessincronizados entre o parceiro e nos.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

const STATUS_PERMITIDOS = ["PAGO", "PENDENTE", "CANCELADO", "ESTORNADO"] as const;

export const paymentWebhookSchema = z.object({
  id_transacao: z
    .string({ error: "O campo 'id_transacao' e obrigatorio." })
    .trim()
    .min(1, "O campo 'id_transacao' e obrigatorio.")
    .max(128, "O campo 'id_transacao' excede 128 caracteres."),

  id_contrato: z
    .string({ error: "O campo 'id_contrato' e obrigatorio." })
    .trim()
    .min(1, "O campo 'id_contrato' e obrigatorio.")
    .max(128, "O campo 'id_contrato' excede 128 caracteres."),

  valor: z
    .number({ error: "O campo 'valor' e obrigatorio." })
    .positive("O campo 'valor' deve ser maior que zero.")
    .max(9_999_999_999_999.99, "O campo 'valor' excede o limite suportado."),

  data_pagamento: z
    .string({ error: "O campo 'data_pagamento' e obrigatorio." })
    .min(1, "O campo 'data_pagamento' e obrigatorio.")
    .refine((v) => !Number.isNaN(Date.parse(v)), {
      message: "O campo 'data_pagamento' nao e uma data valida.",
    })
    .refine((v) => Date.parse(v) <= Date.now() + CLOCK_SKEW_TOLERANCE_MS, {
      message: "O campo 'data_pagamento' nao pode estar no futuro.",
    }),

  status: z
    .string({ error: "O campo 'status' e obrigatorio." })
    .trim()
    .min(1, "O campo 'status' e obrigatorio.")
    .refine(
      (v) => (STATUS_PERMITIDOS as readonly string[]).includes(v.toUpperCase()),
      { message: `O campo 'status' deve ser um de: ${STATUS_PERMITIDOS.join(", ")}.` },
    ),
});

export type ValidPaymentWebhook = z.infer<typeof paymentWebhookSchema>;

/**
 * Achata os erros do Zod no formato `{ campo: [mensagens] }` do contrato.
 *
 * O frontend usa exatamente esta forma para destacar o campo com problema, e o
 * backend .NET produz a mesma - ver `PaymentIngestionService.ToErrorDictionary`.
 */
export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const resultado: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const campo = issue.path.length > 0 ? issue.path.join(".") : "payload";
    (resultado[campo] ??= []).push(issue.message);
  }

  return resultado;
}

export function parsePartnerStatus(status: string): PartnerStatus {
  return status.trim().toUpperCase() as PartnerStatus;
}

/**
 * Extrai o que der de um payload invalido, para a linha de auditoria ter
 * contexto no dashboard mesmo quando o corpo esta defeituoso.
 */
export function salvageFields(raw: unknown): {
  idTransacao: string | null;
  idContrato: string | null;
  valor: number | null;
  dataPagamento: Date | null;
  statusOrigem: string | null;
} {
  const o = (raw ?? {}) as Record<string, unknown>;

  const texto = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  const numero = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const data = (v: unknown): Date | null => {
    if (typeof v !== "string") return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms);
  };

  const statusOrigem = texto(o.status);

  return {
    idTransacao: texto(o.id_transacao),
    idContrato: texto(o.id_contrato),
    valor: numero(o.valor),
    dataPagamento: data(o.data_pagamento),
    statusOrigem: statusOrigem ? statusOrigem.toUpperCase() : null,
  };
}
