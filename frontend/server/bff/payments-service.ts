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
import { CODIGO_PAYLOAD_INVALIDO, descrever } from "./failure-catalog";
import { uuidV7 } from "./ids";
import { computeSignature, fixedTimeEquals } from "./crypto";
import { paymentWebhookSchema, salvageFields, toFieldErrors } from "./validation";
import { registrarIngestao, tracer } from "./telemetry";

/**
 * Ingestao e consulta de pagamentos no backend VINEXT.
 *
 * Esta e a segunda implementacao COMPLETA do contrato - nao um proxy para o
 * .NET. Ela tem o proprio ORM, a propria validacao, a propria fila e o proprio
 * processamento em background - resolvendo o mesmo problema de forma
 * independente, sem que a UI distinga qual dos dois respondeu.
 *
 * O que os dois COMPARTILHAM e o schema `sabemi`: mesmas tabelas, mesmo indice
 * unico de idempotencia. E por isso que um evento entregue aqui aparece no
 * dashboard do outro backend, e que uma reentrega no .NET reconhece como
 * duplicata um evento que entrou por esta rota.
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
  // A telemetria fica num invólucro, e nao espalhada pelo corpo do servico: o
  // caminho de ingestao tem tres desfechos e varios pontos de saida, e um
  // `add(1, ...)` antes de cada `return` seria facil de esquecer justamente no
  // caminho novo. Aqui e impossivel sair sem ser medido.
  //
  // `sabemi_webhook_duration_seconds` e a metrica que prova o requisito central
  // da task: se ela passar de alguns milissegundos, a regra pesada voltou para
  // dentro do request.
  return tracer.startActiveSpan("webhook.ingestao", async (span) => {
    const inicio = performance.now();
    let desfecho = "erro";

    try {
      const resultado = await ingestPaymentCore(rawBody, signatureVerified);

      desfecho =
        resultado.kind === "accepted"
          ? "aceito"
          : resultado.kind === "duplicate"
            ? "duplicado"
            : "invalido";

      // `id_transacao` como ATRIBUTO do span, e nao rotulo de metrica: no trace
      // ele custa nada e e o que permite achar uma entrega especifica; como
      // rotulo, criaria uma serie temporal por transacao.
      span.setAttribute("sabemi.id_transacao", resultado.ack.id_transacao);
      span.setAttribute("sabemi.desfecho", desfecho);

      return resultado;
    } catch (erro) {
      // Uma falha inesperada e diferente de um payload invalido: a primeira e
      // nossa, a segunda e do parceiro. Marcar o span separa as duas no trace.
      span.recordException(erro as Error);
      span.setStatus({ code: 2 /* ERROR */ });
      throw erro;
    } finally {
      registrarIngestao(desfecho, (performance.now() - inicio) / 1000);
      span.end();
    }
  });
}

async function ingestPaymentCore(
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
  if (existente) {
    return duplicateResult(
      existente.idTransacao,
      comoStatus(existente.statusProcessamento),
      existente.recebidoEm,
    );
  }

  if (!validation.success) {
    const fieldErrors = toFieldErrors(validation.error);
    const motivos = validation.error.issues.map((i) => i.message).join(" ");

    try {
      // O evento reprovado tambem e persistido: descarta-lo tornaria a falha
      // invisivel justamente quando ela mais precisa aparecer no dashboard.
      await prisma.paymentEvent.create({
        data: {
          id: uuidV7(),
          idTransacao,
          idContrato: salvaged.idContrato,
          valor: salvaged.valor === null ? null : new Prisma.Decimal(salvaged.valor),
          dataPagamento: salvaged.dataPagamento,
          statusOrigem: salvaged.statusOrigem,
          statusProcessamento: "INVALIDO",
          erro: motivos.slice(0, 2000),

          // Um evento invalido tambem tem uma causa a explicar no painel. Sem
          // isto ele seria o unico estado de erro sem tooltip - e e justamente
          // o mais frequente.
          erroCategoria: "PERMANENTE",
          erroCodigo: CODIGO_PAYLOAD_INVALIDO,
          payloadBruto: parsedJson as Prisma.InputJsonValue,
          assinaturaVerificada: signatureVerified,
          recebidoEm: agora,
          processadoEm: agora,
          tentativas: 0,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const vencedor = await prisma.paymentEvent.findUnique({ where: { idTransacao } });
        return duplicateResult(
          idTransacao,
          vencedor ? comoStatus(vencedor.statusProcessamento) : "DUPLICADO",
          vencedor?.recebidoEm ?? agora,
        );
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
          id: uuidV7(),
          idTransacao,
          idContrato: dados.id_contrato,
          valor: new Prisma.Decimal(dados.valor),
          dataPagamento: new Date(dados.data_pagamento),
          statusOrigem: dados.status.toUpperCase(),
          statusProcessamento: "PENDENTE",
          payloadBruto: parsedJson as Prisma.InputJsonValue,
          assinaturaVerificada: signatureVerified,
          recebidoEm: agora,
          tentativas: 0,
        },
      });

      await tx.processingJob.create({
        data: {
          id: uuidV7(),
          paymentEventId: evento.id,
          estado: "PENDENTE",
          tentativas: 0,
          maxTentativas: bffConfig.processing.maxTentativas,
          disponivelEm: agora,
          criadoEm: agora,
          atualizadoEm: agora,
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Corrida perdida: outra requisicao gravou este id_transacao entre a
      // nossa consulta e o nosso insert. E o desfecho correto.
      const vencedor = await prisma.paymentEvent.findUnique({ where: { idTransacao } });
      return duplicateResult(
        idTransacao,
        vencedor ? comoStatus(vencedor.statusProcessamento) : "DUPLICADO",
        vencedor?.recebidoEm ?? agora,
      );
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

/**
 * A situacao vem do banco como texto (a coluna e varchar - ver
 * prisma/schema.prisma). A conversao acontece aqui, num lugar so, em vez de
 * espalhar casts por todo o servico.
 */
function comoStatus(valor: string): ProcessingStatus {
  return valor as ProcessingStatus;
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
    situacao: row.situacao as ContractStatusDto["situacao"],
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
    status_processamento: comoStatus(row.statusProcessamento),
    erro: row.erro,

    // Reconstruido a partir do codigo gravado: a explicacao e a acao sugerida
    // nao vivem na tabela, entao melhorar um texto do tooltip nao exige tocar em
    // linha nenhuma. Nulo quando o evento nunca falhou - a UI usa a ausencia
    // para decidir se mostra o tooltip.
    diagnostico:
      row.erroCodigo === null && row.erro === null ? null : descrever(row.erroCodigo),

    recebido_em: row.recebidoEm.toISOString(),
    processado_em: row.processadoEm?.toISOString() ?? null,
    tentativas: row.tentativas,
  };
}
