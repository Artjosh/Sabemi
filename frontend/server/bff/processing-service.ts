import { Prisma } from "@/generated/prisma/client";

import { bffConfig } from "./config";
import { prisma } from "./db";
import { classificar } from "./failure-catalog";
import { parsePartnerStatus } from "./validation";
import type { Span } from "@opentelemetry/api";

import { registrarFalha, registrarProcessamento, tracer } from "./telemetry";

/**
 * Schema compartilhado pelos dois backends.
 *
 * A reivindicacao usa SQL bruto (`FOR UPDATE SKIP LOCKED` nao tem equivalente
 * na API do Prisma), e SQL bruto nao respeita o `?schema=` da URL de conexao -
 * a tabela precisa ser qualificada. A constante existe para que uma mudanca de
 * schema seja feita num lugar so: quando ele passou de `vinext` para `sabemi`,
 * estas duas linhas de SQL foram o unico ponto que o compilador nao pegou.
 */
const SCHEMA = "sabemi";

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
    UPDATE ${Prisma.raw(SCHEMA)}.processing_jobs AS j
       SET estado           = 'PROCESSANDO',
           tentativas       = j.tentativas + 1,
           reivindicado_em  = ${agora},
           reivindicado_por = ${WORKER_ID},
           atualizado_em    = ${agora}
      FROM (
            SELECT id
              FROM ${Prisma.raw(SCHEMA)}.processing_jobs
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
  // Um span por ITEM, e nao por ciclo: e assim que se ve quanto tempo um
  // pagamento especifico levou, e nao so a media do lote. A regra pesada (~2s)
  // domina esta duracao por desenho - e util ver isso no trace.
  return tracer.startActiveSpan("fila.processamento", async (span) => {
    const inicio = performance.now();
    let desfecho = "erro";

    try {
      const resultado = await processOneCore(jobId, span);

      desfecho =
        resultado === "succeeded"
          ? "sucesso"
          : resultado === "retried"
            ? "retentativa"
            : "falha";

      span.setAttribute("sabemi.desfecho", desfecho);
      return resultado;
    } finally {
      registrarProcessamento(desfecho, (performance.now() - inicio) / 1000);
      span.end();
    }
  });
}

async function processOneCore(jobId: string, span: Span): Promise<Outcome> {
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
        data: {
          statusProcessamento: "SUCESSO",
          processadoEm: agora,
          erro: null,
          erroCategoria: null,
          erroCodigo: null,
        },
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

    // A natureza da falha decide o retry, nao so a contagem de tentativas. Um
    // contrato inexistente nao passa a existir na segunda tentativa: insistir
    // tres vezes so atrasa em minutos a unica coisa util, que e o evento
    // aparecer como ERRO no painel, com a causa dita em portugues e o botao de
    // reenfileirar disponivel para depois que a pessoa corrigir o que faltava.
    //
    // Mesma regra do backend .NET (PaymentProcessingService.ProcessOneAsync).
    const diagnostico = classificar(error);
    const podeRetentar = job.tentativas < job.maxTentativas && diagnostico.retentavel;

    // A metrica separada por codigo e categoria responde, em plantao, a unica
    // pergunta que importa nos primeiros segundos: "isso vai se resolver
    // sozinho?".
    registrarFalha(diagnostico.codigo, diagnostico.categoria);

    span.recordException(error as Error);
    span.setStatus({ code: 2 /* ERROR */ });
    span.setAttribute("sabemi.erro.codigo", diagnostico.codigo);
    span.setAttribute("sabemi.erro.categoria", diagnostico.categoria);

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
          data: {
            statusProcessamento: "PENDENTE",
            erro: mensagem.slice(0, 2000),
            erroCategoria: diagnostico.categoria,
            erroCodigo: diagnostico.codigo,
          },
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
          erroCategoria: diagnostico.categoria,
          erroCodigo: diagnostico.codigo,
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

  // Em serverless nao ha laco: quem dispara o trabalho e cada requisicao que
  // enfileira algo, via `agendarCicloAposResposta`. Ver a explicacao dos dois
  // modos em `config.ts`.
  if (bffConfig.processing.mode !== "loop") return;

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

/**
 * Roda um ciclo de processamento DEPOIS de a resposta ser enviada.
 *
 * <b>O requisito.</b> A task pede que o endpoint responda rapido ao banco
 * enquanto a regra pesada (~2s) acontece em background. Num servidor de vida
 * longa isso e o laco acima. Em serverless nao ha onde um laco viver - mas a
 * plataforma oferece a primitiva certa: `waitUntil` estende a invocacao para
 * depois da resposta, entao o webhook responde em milissegundos e os 2s rodam
 * em seguida, dentro do mesmo pedido.
 *
 * <b>Por que ler o contexto por `Symbol.for` em vez de importar
 * `@vercel/functions`.</b> Este modulo tambem roda no container e nos testes,
 * onde esse pacote nao faz sentido; a busca pelo simbolo e a mesma que o proprio
 * Next.js usa, nao adiciona dependencia, e simplesmente nao encontra nada fora
 * da Vercel - o que e exatamente o comportamento desejado.
 *
 * <b>Fora da Vercel, o disparo e solto</b> (`void`). Num processo de vida longa
 * isso e seguro: ninguem vai congelar a execucao no meio.
 *
 * <b>`waitUntil` nao tem retry</b> - se a promessa rejeitar, nada re-executa.
 * Nao e problema aqui porque a fila e uma tabela com lease: o item volta a ficar
 * reivindicavel e outro consumidor o pega. E por isso que este desenho pede um
 * segundo consumidor da mesma fila (o worker .NET) quando roda em serverless.
 */
export function agendarCicloAposResposta(): void {
  if (!bffConfig.processing.workerEnabled) return;
  if (bffConfig.processing.mode === "loop") return;

  const tarefa = (async () => {
    try {
      await runProcessingCycle();
    } catch (error) {
      console.error("[bff] ciclo de processamento falhou", error);
    }
  })();

  const contexto = (
    globalThis as unknown as {
      [k: symbol]: { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined };
    }
  )[Symbol.for("@vercel/request-context")];

  const waitUntil = contexto?.get?.()?.waitUntil;
  if (waitUntil) waitUntil(tarefa);
  else void tarefa;
}
