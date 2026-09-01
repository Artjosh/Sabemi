import { Prisma } from "@/generated/prisma/client";

import { bffConfig } from "./config";
import { prisma } from "./db";
import { parsePartnerStatus } from "./validation";

/**
 * Processamento em background do backend VINEXT.
 *
 * <b>Por que nao `setTimeout`.</b> A task pede que a regra pesada nao bloqueie o
 * webhook, e que o mecanismo nao possa perder trabalho em silencio. Um
 * `setTimeout` atende o primeiro requisito e falha no segundo: se o processo
 * cair entre o "202 Accepted" e o disparo, o trabalho evapora sem deixar
 * registro.
 *
 * Aqui a fila e uma tabela. O evento e o job sao gravados na mesma transacao do
 * webhook, o consumo usa `FOR UPDATE SKIP LOCKED`, e itens cujo lease expirou
 * voltam para a fila. Depois de um `kill -9` no meio do processamento, o item
 * ainda esta la e sera retomado.
 *
 * <b>Diferenca de topologia em relacao ao .NET.</b> Do lado .NET o worker e um
 * container proprio, que escala separado da API. Aqui o laco roda no mesmo
 * processo do BFF - um servidor Node so. As GARANTIAS sao as mesmas (fila
 * durable, at-least-once, recuperacao de orfaos); o que muda e a capacidade de
 * escalar os dois lados de forma independente. E a escolha certa para o
 * backend alternativo, que existe para provar a portabilidade do contrato e nao
 * para ser o caminho de producao.
 */

export interface CycleResult {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  released: number;
}

const EMPTY_CYCLE: CycleResult = { claimed: 0, succeeded: 0, retried: 0, failed: 0, released: 0 };

/** Identidade deste processo, gravada no job reivindicado. */
const WORKER_ID = `vinext:${process.pid}`;

/**
 * Reivindica ate `batchSize` itens disponiveis.
 *
 * Um unico comando seleciona-e-marca. `FOR UPDATE SKIP LOCKED` faz cada
 * consumidor pular as linhas travadas por outro em vez de esperar por elas, o
 * que permite varios consumidores sem entregar o mesmo item duas vezes.
 * Selecionar e depois atualizar em comandos separados abriria uma janela entre
 * a leitura e a escrita.
 */
async function claimJobs(batchSize: number, agora: Date): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE vinext.processing_jobs AS j
       SET estado           = 'PROCESSANDO',
           tentativas       = j.tentativas + 1,
           reivindicado_em  = ${agora},
           reivindicado_por = ${WORKER_ID},
           atualizado_em    = ${agora}
      FROM (
            SELECT id
              FROM vinext.processing_jobs
             WHERE estado = 'PENDENTE'
               AND disponivel_em <= ${agora}
             ORDER BY disponivel_em, criado_em
             LIMIT ${batchSize}
               FOR UPDATE SKIP LOCKED
           ) AS candidatos
     WHERE j.id = candidatos.id
    RETURNING j.id
  `;

  return rows.map((r) => r.id);
}

/**
 * Devolve a fila os itens presos em PROCESSANDO alem do visibility timeout.
 *
 * Sem esta varredura, um processo morto no meio de um item o deixaria travado
 * para sempre: ninguem o reivindicaria (ja nao esta pendente) e ninguem o
 * concluiria (quem o segurava morreu). E o que faz a entrega at-least-once ser
 * verdade e nao apenas intencao.
 */
async function releaseStaleJobs(agora: Date): Promise<number> {
  const limite = new Date(agora.getTime() - bffConfig.processing.visibilityTimeoutMs);

  const { count } = await prisma.processingJob.updateMany({
    where: { estado: "PROCESSANDO", reivindicadoEm: { lt: limite } },
    data: {
      estado: "PENDENTE",
      disponivelEm: agora,
      reivindicadoEm: null,
      reivindicadoPor: null,
      ultimoErro: "Worker perdeu o lease (visibility timeout expirado).",
    },
  });

  return count;
}

/** A regra de negocio simulada (~2s), como pede a task. */
async function executeBusinessRule(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, bffConfig.processing.simulatedWorkMs));
}

/**
 * Executa uma rodada completa da fila.
 *
 * Exportado para os testes chamarem diretamente, sem precisar hospedar o laco
 * nem esperar por temporizadores.
 */
export async function runProcessingCycle(): Promise<CycleResult> {
  const agora = new Date();

  const released = await releaseStaleJobs(agora);
  const jobIds = await claimJobs(bffConfig.processing.batchSize, agora);

  if (jobIds.length === 0) return { ...EMPTY_CYCLE, released };

  let succeeded = 0;
  let retried = 0;
  let failed = 0;

  for (const jobId of jobIds) {
    const desfecho = await processOne(jobId);
    if (desfecho === "succeeded") succeeded += 1;
    else if (desfecho === "retried") retried += 1;
    else failed += 1;
  }

  return { claimed: jobIds.length, succeeded, retried, failed, released };
}

type Outcome = "succeeded" | "retried" | "failed";

async function processOne(jobId: string): Promise<Outcome> {
  const job = await prisma.processingJob.findUnique({
    where: { id: jobId },
    include: { paymentEvent: true },
  });

  // O item pode ter sido removido entre a reivindicacao e agora (limpeza,
  // intervencao manual). Nao ha o que fazer, e nao e um erro.
  if (!job || !job.paymentEvent) return "failed";

  const evento = job.paymentEvent;

  await prisma.paymentEvent.update({
    where: { id: evento.id },
    data: { statusProcessamento: "PROCESSANDO", tentativas: job.tentativas },
  });

  try {
    // A regra pesada roda FORA da transacao. Segurar uma transacao aberta
    // durante 2s prenderia uma conexao e as travas das linhas por todo esse
    // tempo - com varios itens em paralelo, e assim que o pool se esgota.
    await executeBusinessRule();

    const agora = new Date();
    const valor = evento.valor ?? new Prisma.Decimal(0);
    const statusOrigem = parsePartnerStatus(evento.statusOrigem ?? "PENDENTE");

    // Efeito colateral e fechamento do job na MESMA transacao: contrato
    // atualizado com job ainda aberto seria somado de novo na proxima tentativa.
    await prisma.$transaction(async (tx) => {
      await upsertContract(tx, {
        idContrato: evento.idContrato!,
        statusOrigem,
        valor,
        dataPagamento: evento.dataPagamento,
        idTransacao: evento.idTransacao,
        agora,
      });

      await tx.paymentEvent.update({
        where: { id: evento.id },
        data: { statusProcessamento: "SUCESSO", processadoEm: agora, erro: null },
      });

      await tx.processingJob.update({
        where: { id: job.id },
        data: { estado: "CONCLUIDO", ultimoErro: null },
      });
    });

    return "succeeded";
  } catch (error) {
    const agora = new Date();
    const mensagem = error instanceof Error ? error.message : String(error);
    const podeRetentar = job.tentativas < job.maxTentativas;

    if (podeRetentar) {
      // Backoff exponencial (base 2, teto de 5 min) para nao martelar uma
      // dependencia instavel.
      const fator = 2 ** Math.max(0, job.tentativas - 1);
      const espera = Math.min(
        bffConfig.processing.baseRetryDelayMs * fator,
        5 * 60_000,
      );

      await prisma.$transaction([
        prisma.processingJob.update({
          where: { id: job.id },
          data: {
            estado: "PENDENTE",
            ultimoErro: mensagem.slice(0, 2000),
            disponivelEm: new Date(agora.getTime() + espera),
            reivindicadoEm: null,
            reivindicadoPor: null,
          },
        }),
        prisma.paymentEvent.update({
          where: { id: evento.id },
          data: { statusProcessamento: "PENDENTE", erro: mensagem.slice(0, 2000) },
        }),
      ]);

      return "retried";
    }

    await prisma.$transaction([
      prisma.processingJob.update({
        where: { id: job.id },
        data: { estado: "FALHOU", ultimoErro: mensagem.slice(0, 2000) },
      }),
      prisma.paymentEvent.update({
        where: { id: evento.id },
        data: {
          statusProcessamento: "ERRO",
          erro: mensagem.slice(0, 2000),
          processadoEm: agora,
        },
      }),
    ]);

    return "failed";
  }
}

/**
 * Projeta o evento no estado consolidado do contrato.
 *
 * So `PAGO` soma ao total. `CANCELADO`/`ESTORNADO` marcam inadimplencia sem
 * mexer no acumulado, e `PENDENTE` apenas registra o toque. A idempotencia
 * desta soma vem de um nivel acima: um `id_transacao` gera um unico evento e,
 * portanto, um unico job.
 */
async function upsertContract(
  tx: Prisma.TransactionClient,
  input: {
    idContrato: string;
    statusOrigem: string;
    valor: Prisma.Decimal;
    dataPagamento: Date | null;
    idTransacao: string;
    agora: Date;
  },
): Promise<void> {
  const { idContrato, statusOrigem, valor, dataPagamento, idTransacao, agora } = input;

  const pago = statusOrigem === "PAGO";
  const inadimplente = statusOrigem === "CANCELADO" || statusOrigem === "ESTORNADO";

  const situacao = pago ? "LIQUIDADO" : inadimplente ? "INADIMPLENTE" : "ATIVO";

  await tx.contractStatus.upsert({
    where: { idContrato },
    create: {
      idContrato,
      valorTotalLiquidado: pago ? valor : new Prisma.Decimal(0),
      pagamentosConfirmados: pago ? 1 : 0,
      ultimoPagamentoEm: pago ? dataPagamento : null,
      ultimaTransacao: idTransacao,
      situacao,
      atualizadoEm: agora,
    },
    update: {
      // `increment` deixa a soma para o banco, em vez de ler-somar-gravar na
      // aplicacao: dois workers atualizando o mesmo contrato nao perdem um
      // pagamento por sobrescrita.
      ...(pago
        ? {
            valorTotalLiquidado: { increment: valor },
            pagamentosConfirmados: { increment: 1 },
            ultimoPagamentoEm: dataPagamento,
          }
        : {}),
      ultimaTransacao: idTransacao,
      situacao,
      atualizadoEm: agora,
    },
  });
}

// ------------------------------------------------------------ laco do worker

let loopStarted = false;

/**
 * Inicia o laco de processamento, uma unica vez por processo.
 *
 * Chamado quando o backend VINEXT recebe a primeira requisicao. O guarda em
 * `globalThis` importa em desenvolvimento: o HMR reavalia o modulo a cada
 * alteracao e, sem ele, cada recarga somaria mais um laco concorrendo pela
 * mesma fila.
 */
export function ensureWorkerStarted(): void {
  if (!bffConfig.processing.workerEnabled) return;

  const g = globalThis as unknown as { __sabemiBffWorker?: boolean };
  if (loopStarted || g.__sabemiBffWorker) return;

  loopStarted = true;
  g.__sabemiBffWorker = true;

  void (async function loop() {
    for (;;) {
      try {
        const resultado = await runProcessingCycle();

        // Havendo trabalho, volta ja; fila vazia, dorme. Mantem a latencia
        // baixa sob carga sem martelar o banco quando esta ocioso.
        if (resultado.claimed === 0 && resultado.released === 0) {
          await sleep(bffConfig.processing.pollIntervalMs);
        }
      } catch (error) {
        // Uma falha de ciclo (banco fora, por exemplo) nao pode derrubar o
        // laco: os itens continuam na fila e a proxima volta tenta de novo.
        console.error("[bff-worker] falha no ciclo de processamento:", error);
        await sleep(bffConfig.processing.pollIntervalMs);
      }
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
