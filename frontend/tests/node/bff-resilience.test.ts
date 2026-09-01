import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/bff/db";
import { runProcessingCycle } from "@/server/bff/processing-service";

/**
 * Retentativa, falha definitiva e backoff no backend VINEXT.
 *
 * <b>Como a falha e provocada.</b> Sem uma dependencia externa para derrubar, o
 * caminho de erro e alcancado por um evento cuja regra nao pode ser aplicada:
 * um job apontando para um evento SEM contrato. A consolidacao precisa de
 * `id_contrato`, entao ela falha - que e exatamente o tipo de dado corrompido
 * que a resiliencia existe para tratar.
 *
 * Nao e um cenario artificial: um evento sem contrato pode chegar a fila se o
 * banco for alterado por fora, ou apos uma migration que relaxe uma restricao.
 * O sistema precisa registrar o erro e desistir com dignidade, em vez de travar
 * a fila para sempre.
 */

async function limpar() {
  await prisma.processingJob.deleteMany();
  await prisma.paymentEvent.deleteMany();
  await prisma.contractStatus.deleteMany();
}

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/** Cria um evento cuja regra de negocio vai falhar, mais o job dele. */
async function semearEventoQueFalha(maxTentativas = 3) {
  const evento = await prisma.paymentEvent.create({
    data: {
      idTransacao: `FALHA-${crypto.randomUUID()}`,
      // Sem contrato: a consolidacao nao tem como ser aplicada.
      idContrato: null,
      valor: null,
      statusOrigem: "PAGO",
      statusProcessamento: "PENDENTE",
      payloadBruto: {},
      recebidoEm: new Date(),
    },
  });

  const job = await prisma.processingJob.create({
    data: {
      paymentEventId: evento.id,
      maxTentativas,
      disponivelEm: new Date(),
    },
  });

  return { evento, job };
}

describe("retentativa", () => {
  it("uma falha transitória reagenda o item, sem marcá-lo como erro", async () => {
    const { job } = await semearEventoQueFalha(3);

    const ciclo = await runProcessingCycle();

    expect(ciclo.claimed).toBe(1);
    expect(ciclo.retried).toBe(1);
    expect(ciclo.failed).toBe(0);

    const depois = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });

    expect(depois.estado).toBe("PENDENTE");
    expect(depois.tentativas).toBe(1);
    expect(depois.ultimoErro).toBeTruthy();
    // O lease é liberado para outro worker poder pegar quando a espera terminar.
    expect(depois.reivindicadoEm).toBeNull();

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { id: depois.paymentEventId },
    });
    // Ainda PENDENTE, e não ERRO: há tentativas pela frente e marcar erro agora
    // acionaria alarme por algo que pode se resolver sozinho.
    expect(evento.statusProcessamento).toBe("PENDENTE");
  });

  it("o item reagendado não é reivindicado antes da hora", async () => {
    // Com `PROCESSING_BASE_RETRY_DELAY_MS=0` nos testes, o backoff é zero e o
    // item volta na hora. Aqui a data é empurrada à mão para exercitar a espera.
    const { job } = await semearEventoQueFalha(5);

    await runProcessingCycle();

    await prisma.processingJob.update({
      where: { id: job.id },
      data: { disponivelEm: new Date(Date.now() + 60_000) },
    });

    const segundo = await runProcessingCycle();

    expect(segundo.claimed).toBe(0);
  });

  it("esgotadas as tentativas, o evento vai para ERRO", async () => {
    const { job } = await semearEventoQueFalha(2);

    const primeiro = await runProcessingCycle();
    expect(primeiro.retried).toBe(1);

    const segundo = await runProcessingCycle();
    expect(segundo.failed).toBe(1);

    const jobFinal = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobFinal.estado).toBe("FALHOU");
    expect(jobFinal.tentativas).toBe(2);

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { id: jobFinal.paymentEventId },
    });
    expect(evento.statusProcessamento).toBe("ERRO");
    expect(evento.erro).toBeTruthy();
    expect(evento.processadoEm).not.toBeNull();
  });

  it("um item que falhou definitivamente não volta para a fila", async () => {
    await semearEventoQueFalha(1);

    const primeiro = await runProcessingCycle();
    expect(primeiro.failed).toBe(1);

    const segundo = await runProcessingCycle();
    expect(segundo.claimed).toBe(0);
  });

  it("nenhum contrato é criado quando a regra nunca conclui", async () => {
    await semearEventoQueFalha(1);

    await runProcessingCycle();

    expect(await prisma.contractStatus.count()).toBe(0);
  });

  it("uma falha não impede os demais itens do mesmo lote", async () => {
    // O item defeituoso não pode envenenar o lote inteiro.
    await semearEventoQueFalha(1);

    const bom = await prisma.paymentEvent.create({
      data: {
        idTransacao: "BOM-001",
        idContrato: "CTR-BOM",
        valor: 42,
        dataPagamento: new Date("2026-08-01T10:00:00Z"),
        statusOrigem: "PAGO",
        statusProcessamento: "PENDENTE",
        payloadBruto: {},
        recebidoEm: new Date(),
      },
    });
    await prisma.processingJob.create({
      data: { paymentEventId: bom.id, maxTentativas: 3, disponivelEm: new Date() },
    });

    const ciclo = await runProcessingCycle();

    expect(ciclo.claimed).toBe(2);
    expect(ciclo.succeeded).toBe(1);
    expect(ciclo.failed).toBe(1);

    const contrato = await prisma.contractStatus.findUniqueOrThrow({
      where: { idContrato: "CTR-BOM" },
    });
    expect(contrato.valorTotalLiquidado.toNumber()).toBe(42);
  });

  it("um job cujo evento sumiu não trava a fila", async () => {
    // Limpeza ou intervenção manual podem deixar um job sem evento. Não é erro
    // recuperável, mas também não pode parar o consumo.
    const { evento, job } = await semearEventoQueFalha(3);

    // Apaga o evento; o job cai junto por cascata, restando nada para reivindicar.
    await prisma.paymentEvent.delete({ where: { id: evento.id } });

    const ciclo = await runProcessingCycle();

    expect(ciclo.claimed).toBe(0);
    expect(await prisma.processingJob.findUnique({ where: { id: job.id } })).toBeNull();
  });

  it("o lote respeita o tamanho configurado", async () => {
    // Com PROCESSING_BATCH_SIZE padrão de 5, um lote maior é consumido em
    // rodadas — e não de uma vez, o que seguraria conexões por tempo demais.
    for (let i = 0; i < 8; i++) {
      const e = await prisma.paymentEvent.create({
        data: {
          idTransacao: `BATCH-${i}`,
          idContrato: "CTR-BATCH",
          valor: 1,
          dataPagamento: new Date("2026-08-01T10:00:00Z"),
          statusOrigem: "PAGO",
          statusProcessamento: "PENDENTE",
          payloadBruto: {},
          recebidoEm: new Date(),
        },
      });
      await prisma.processingJob.create({
        data: { paymentEventId: e.id, maxTentativas: 3, disponivelEm: new Date() },
      });
    }

    const primeiro = await runProcessingCycle();
    expect(primeiro.claimed).toBe(5);

    const segundo = await runProcessingCycle();
    expect(segundo.claimed).toBe(3);

    const contrato = await prisma.contractStatus.findUniqueOrThrow({
      where: { idContrato: "CTR-BATCH" },
    });
    expect(contrato.pagamentosConfirmados).toBe(8);
  });
});
