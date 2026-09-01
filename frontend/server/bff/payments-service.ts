import { Prisma } from "@/generated/prisma/client";

import type {
  ContractStatusDto,
  PagedResult,
  PaymentEventDetailDto,
  PaymentEventDto,
  PaymentFilters,
  PaymentSummaryDto,
  ProcessingStatus,
  WebhookAck,
} from "@/lib/contracts";
import { PROCESSING_STATUSES } from "@/lib/contracts";

import { bffConfig } from "./config";
import { prisma } from "./db";
import { computeSignature, fixedTimeEquals } from "./crypto";
import { paymentWebhookSchema, salvageFields, toFieldErrors } from "./validation";

/**
 * Ingestao e consulta de pagamentos no backend VINEXT.
 *
 * Esta e a segunda implementacao COMPLETA do contrato - nao um proxy para o
 * .NET. Ela tem o proprio banco (schema `vinext`), a propria validacao, a
 * propria fila e o proprio processamento em background. E isso que torna a
 * troca de backend uma troca de verdade: os dois lados resolvem o mesmo
 * problema de forma independente, e a UI nao distingue qual respondeu.
 */

/** Codigo do PostgreSQL para violacao de indice unico, exposto pelo Prisma. */
const PRISMA_UNIQUE_VIOLATION = "P2002";

export type IngestionKind = "accepted" | "duplicate" | "invalid";

export interface IngestionResult {
  kind: IngestionKind;
  ack: WebhookAck;
  errors?: Record<string, string[]>;
}

export type WebhookAuthResult =
  | { ok: true; signatureVerified: boolean }
  | { ok: false; reason: "invalid_api_key" | "missing_signature" | "invalid_signature" };

/**
 * Autentica a chamada do banco parceiro.
 *
 * Mesmo esquema em camadas do backend .NET: a `X-Api-Key` diz quem chama, e o
 * HMAC sobre o corpo bruto prova que o conteudo nao foi alterado no caminho.
 * Ver `WebhookAuthenticator` do lado .NET para o raciocinio completo.
 */
export function authenticateWebhook(
  apiKey: string | null,
  signature: string | null,
  rawBody: string,
): WebhookAuthResult {
  const esperada = bffConfig.webhook.apiKey;

  // Falha fechada: sem chave configurada, ninguem entra.
  if (!esperada) return { ok: false, reason: "invalid_api_key" };
  if (!apiKey || !fixedTimeEquals(apiKey, esperada)) {
    return { ok: false, reason: "invalid_api_key" };
  }

  const segredo = bffConfig.webhook.signatureSecret;
  if (!segredo) return { ok: true, signatureVerified: false };

  if (!signature) {
    return bffConfig.webhook.requireSignature
      ? { ok: false, reason: "missing_signature" }
      : { ok: true, signatureVerified: false };
  }

  // Aceita "sha256=<hex>" alem do hex puro - convencao de GitHub e Stripe.
  const recebida = signature.toLowerCase().startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  return fixedTimeEquals(recebida.trim().toLowerCase(), computeSignature(rawBody, segredo))
    ? { ok: true, signatureVerified: true }
    : { ok: false, reason: "invalid_signature" };
}

/**
 * Recebe uma notificacao: valida, persiste e enfileira. Nao executa a regra.
 *
 * <b>Idempotencia.</b> Igual ao backend .NET, a garantia e o indice unico sobre
 * `id_transacao`. A insercao e otimista e a violacao (`P2002`) e o sinal de
 * reentrega - nao um erro. Consultar antes de inserir nao substituiria isso:
 * sob concorrencia, duas requisicoes passariam pela consulta e as duas tentariam
 * inserir. O atalho de consulta existe apenas para evitar gerar excecao no caso
 * comum.
 *
 * <b>Atomicidade.</b> Evento e job vao na mesma transacao, entao nao existe
 * evento aceito sem trabalho enfileirado para ele.
 */
export async function ingestPayment(
  rawBody: string,
  signatureVerified: boolean,
): Promise<IngestionResult> {
  const agora = new Date();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return {
      kind: "invalid",
      ack: {
        id_transacao: "",
        status: "INVALIDO",
        duplicate: false,
        received_at: agora.toISOString(),
        message: "Corpo da requisicao nao e um JSON valido.",
      },
      errors: { payload: ["Corpo da requisicao nao e um JSON valido."] },
    };
  }

  const validation = paymentWebhookSchema.safeParse(parsedJson);
  const salvaged = salvageFields(parsedJson);

  // Sem `id_transacao` nao ha chave de idempotencia, e portanto nao ha como
  // gravar a linha de auditoria sem colidir com outros payloads incompletos.
  // Este e o unico caso rejeitado sem persistir.
  if (!salvaged.idTransacao) {
    const errors = validation.success ? undefined : toFieldErrors(validation.error);
    return {
      kind: "invalid",
      ack: {
        id_transacao: "",
        status: "INVALIDO",
        duplicate: false,
        received_at: agora.toISOString(),
        message: "O campo 'id_transacao' e obrigatorio.",
      },
      errors,
    };
  }

  const idTransacao = salvaged.idTransacao;

  // Atalho para o caso frequente de reentrega. Nao e a garantia.
  const existente = await prisma.paymentEvent.findUnique({ where: { idTransacao } });
  if (existente) return duplicateResult(existente.idTransacao, existente.statusProcessamento, existente.recebidoEm);

  if (!validation.success) {
    const fieldErrors = toFieldErrors(validation.error);
    const motivos = validation.error.issues.map((i) => i.message).join(" ");

    try {
      // O evento reprovado tambem e persistido: descarta-lo tornaria a falha
      // invisivel justamente quando ela mais precisa aparecer no dashboard.
      await prisma.paymentEvent.create({
        data: {
          idTransacao,
          idContrato: salvaged.idContrato,
          valor: salvaged.valor === null ? null : new Prisma.Decimal(salvaged.valor),
          dataPagamento: salvaged.dataPagamento,
          statusOrigem: salvaged.statusOrigem,
          statusProcessamento: "INVALIDO",
          erro: motivos.slice(0, 2000),
          payloadBruto: parsedJson as Prisma.InputJsonValue,
          assinaturaVerificada: signatureVerified,
          recebidoEm: agora,
          processadoEm: agora,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const vencedor = await prisma.paymentEvent.findUnique({ where: { idTransacao } });
        return duplicateResult(idTransacao, vencedor?.statusProcessamento ?? "DUPLICADO", vencedor?.recebidoEm ?? agora);
      }
      throw error;
    }

    return {
      kind: "invalid",
      ack: {
        id_transacao: idTransacao,
        status: "INVALIDO",
        duplicate: false,
        received_at: agora.toISOString(),
        message: motivos,
      },
      errors: fieldErrors,
    };
  }

  const dados = validation.data;

  try {
    await prisma.$transaction(async (tx) => {
      const evento = await tx.paymentEvent.create({
        data: {
          idTransacao,
          idContrato: dados.id_contrato,
          valor: new Prisma.Decimal(dados.valor),
          dataPagamento: new Date(dados.data_pagamento),
          statusOrigem: dados.status.toUpperCase(),
          statusProcessamento: "PENDENTE",
          payloadBruto: parsedJson as Prisma.InputJsonValue,
          assinaturaVerificada: signatureVerified,
          recebidoEm: agora,
        },
      });

      await tx.processingJob.create({
        data: {
          paymentEventId: evento.id,
          maxTentativas: bffConfig.processing.maxTentativas,
          disponivelEm: agora,
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Corrida perdida: outra requisicao gravou este id_transacao entre a
      // nossa consulta e o nosso insert. E o desfecho correto.
      const vencedor = await prisma.paymentEvent.findUnique({ where: { idTransacao } });
      return duplicateResult(idTransacao, vencedor?.statusProcessamento ?? "DUPLICADO", vencedor?.recebidoEm ?? agora);
    }
    throw error;
  }

  return {
    kind: "accepted",
    ack: {
      id_transacao: idTransacao,
      status: "PENDENTE",
      duplicate: false,
      received_at: agora.toISOString(),
      message: "Evento recebido e enfileirado para processamento.",
    },
  };
}

function duplicateResult(
  idTransacao: string,
  status: ProcessingStatus,
  recebidoEm: Date,
): IngestionResult {
  return {
    kind: "duplicate",
    ack: {
      id_transacao: idTransacao,
      // Devolve a situacao REAL do evento ja conhecido: o parceiro descobre no
      // mesmo passo que a notificacao ja chegou e em que pe ela esta.
      status,
      duplicate: true,
      received_at: recebidoEm.toISOString(),
      message: "Notificacao ja recebida anteriormente. Nenhum reprocessamento foi disparado.",
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PRISMA_UNIQUE_VIOLATION
  );
}

// ---------------------------------------------------------------- consultas

/** Lista paginada com os filtros do dashboard (situacao e contrato). */
export async function listPayments(filters: PaymentFilters): Promise<PagedResult<PaymentEventDto>> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(Math.max(1, filters.pageSize ?? 20), 100);

  const where: Prisma.PaymentEventWhereInput = {};
  if (filters.status) where.statusProcessamento = filters.status;
  if (filters.contractId) where.idContrato = filters.contractId;

  // Contagem e pagina na mesma ida ao banco.
  const [total, rows] = await prisma.$transaction([
    prisma.paymentEvent.count({ where }),
    prisma.paymentEvent.findMany({
      where,
      // Desempate por id (UUID v7, monotonico no tempo) para a paginacao ser
      // estavel quando dois eventos chegam no mesmo instante.
      orderBy: [{ recebidoEm: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    items: rows.map(toEventDto),
    page,
    page_size: pageSize,
    total,
  };
}

export async function getPaymentDetail(idTransacao: string): Promise<PaymentEventDetailDto | null> {
  const row = await prisma.paymentEvent.findUnique({ where: { idTransacao } });
  if (!row) return null;

  return {
    ...toEventDto(row),
    payload_bruto: JSON.stringify(row.payloadBruto),
  };
}

export async function getContract(idContrato: string): Promise<ContractStatusDto | null> {
  const row = await prisma.contractStatus.findUnique({ where: { idContrato } });
  if (!row) return null;

  return {
    id_contrato: row.idContrato,
    valor_total_liquidado: row.valorTotalLiquidado.toNumber(),
    pagamentos_confirmados: row.pagamentosConfirmados,
    ultimo_pagamento_em: row.ultimoPagamentoEm?.toISOString() ?? null,
    ultima_transacao: row.ultimaTransacao,
    situacao: row.situacao,
    atualizado_em: row.atualizadoEm.toISOString(),
  };
}

/**
 * Contadores dos cartoes do dashboard.
 *
 * Agrega no banco e completa com zero as situacoes sem ocorrencia, para o
 * contrato sempre trazer o conjunto completo de chaves - assim o frontend nao
 * precisa tratar chave ausente.
 */
export async function getSummary(): Promise<PaymentSummaryDto> {
  const grupos = await prisma.paymentEvent.groupBy({
    by: ["statusProcessamento"],
    _count: { _all: true },
  });

  const porStatus: Record<string, number> = {};
  for (const status of PROCESSING_STATUSES) porStatus[status] = 0;

  let total = 0;
  for (const g of grupos) {
    porStatus[g.statusProcessamento] = g._count._all;
    total += g._count._all;
  }

  return { total, por_status: porStatus };
}

type PaymentEventRow = Awaited<ReturnType<typeof prisma.paymentEvent.findFirstOrThrow>>;

function toEventDto(row: PaymentEventRow): PaymentEventDto {
  return {
    id: row.id,
    id_transacao: row.idTransacao,
    id_contrato: row.idContrato,
    valor: row.valor?.toNumber() ?? null,
    data_pagamento: row.dataPagamento?.toISOString() ?? null,
    status_origem: row.statusOrigem,
    status_processamento: row.statusProcessamento,
    erro: row.erro,
    recebido_em: row.recebidoEm.toISOString(),
    processado_em: row.processadoEm?.toISOString() ?? null,
    tentativas: row.tentativas,
  };
}
