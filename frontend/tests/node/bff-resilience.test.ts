import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/bff/db";
import { uuidV7 } from "@/server/bff/ids";
import { runProcessingCycle } from "@/server/bff/processing-service";

/**
 * Retentativa, falha definitiva e backoff no backend VINEXT.
 *
 * <b>Como cada tipo de falha e provocado.</b> Desde que o retry passou a
 * depender da NATUREZA do erro (ver server/bff/failure-catalog.ts), os dois
 * caminhos precisam de gatilhos diferentes:
 *
 *   - <b>Permanente:</b> um job apontando para um evento SEM contrato. A
 *     consolidacao precisa de `id_contrato`, e nenhuma repeticao faz esse campo
 *     aparecer. Nao e um cenario artificial - um evento assim chega a fila se o
 *     banco for alterado por fora, ou apos uma migration que relaxe uma
 *     restricao.
 *   - <b>Transitoria:</b> um deadlock injetado (`40P01`). Provocar um deadlock
 *     de verdade exigiria coordenar duas transacoes concorrentes com timing
 *     preciso - lento e instavel. O que importa aqui nao e o deadlock em si, e
 *     sim o que o worker faz com um erro classificado como transitorio.
 */

async function limpar() {
  await prisma.processingJob.deleteMany();
  await prisma.paymentEvent.deleteMany();
  await prisma.contractStatus.deleteMany();
}

beforeEach(limpar);

// Um espiao que sobrevivesse ao teste faria o proximo falhar por um deadlock que
// ninguem pediu - e a mensagem apontaria para o codigo, nao para o vazamento.
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/**
 * Cria um evento e o job dele.
 *
 * Sem `idContrato`, a consolidacao nao tem como ser aplicada e a falha e
 * PERMANENTE. Passando um contrato, o evento processa normalmente - e ai a falha
 * vem de `injetarDeadlock()`, que e transitoria.
 */
async function semearEventoQueFalha(maxTentativas = 3, idContrato: string | null = null) {
  const agora = new Date();

  const evento = await prisma.paymentEvent.create({
    data: {
      id: uuidV7(),
      idTransacao: `FALHA-${crypto.randomUUID()}`,
      idContrato,
      valor: idContrato === null ? null : 100,
      statusOrigem: "PAGO",
      statusProcessamento: "PENDENTE",
      payloadBruto: {},
      assinaturaVerificada: false,
      recebidoEm: agora,
      tentativas: 0,
    },
  });

  const job = await prisma.processingJob.create({
    data: {
      id: uuidV7(),
      paymentEventId: evento.id,
      estado: "PENDENTE",
      tentativas: 0,
      maxTentativas,
      disponivelEm: agora,
      criadoEm: agora,
      atualizadoEm: agora,
    },
  });

  return { evento, job };
}

/**
 * Faz a transacao de consolidacao falhar com um deadlock.
 *
 * <b>Por que em `$transaction` e nao em `contractStatus.upsert`.</b> O servico
 * consolida o contrato DENTRO de uma transacao interativa, usando o cliente `tx`
 * que o Prisma cria para o escopo. Esse `tx` nao e o cliente global: um espiao em
 * `prisma.contractStatus.upsert` simplesmente nunca seria chamado, e o teste
 * passaria a exercitar o caminho de SUCESSO sem que nada indicasse isso.
 *
 * A forma interativa (`$transaction(fn)`) e a que consolida o contrato; a forma
 * em lote (`$transaction([...])` ) e a que registra o desfecho da falha. Injetar
 * so na primeira deixa o registro do erro funcionando - que e justamente o que
 * este arquivo verifica.
 *
 * `40P01` e o SQLSTATE do PostgreSQL para deadlock, e e por ele que o
 * classificador reconhece a falha como TRANSITORIA, pelo mesmo caminho que um
 * deadlock real percorreria. Provocar um deadlock de verdade exigiria coordenar
 * duas transacoes concorrentes com timing preciso - lento e instavel, para
 * verificar a mesma coisa.
 */
function injetarDeadlock() {
  const original = prisma.$transaction.bind(prisma);

  vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => {
    if (typeof args[0] === "function") {
      return Promise.reject(
        Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      );
    }

    return (original as (...a: unknown[]) => unknown)(...args);
  }) as typeof prisma.$transaction);
}

describe("retentativa", () => {
  it("uma falha transitória reagenda o item, sem marcá-lo como erro", async () => {
    // O contrato existe: o que falha aqui e o deadlock injetado, e nao o dado.
    const { job } = await semearEventoQueFalha(3, "CTR-DEADLOCK");
    injetarDeadlock();

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

    // E a causa foi lida como transitória - é isso que autoriza a retentativa.
    expect(evento.erroCategoria).toBe("TRANSITORIA");
    expect(evento.erroCodigo).toBe("DEADLOCK");
  });

  it("o item reagendado não é reivindicado antes da hora", async () => {
    // Com `PROCESSING_BASE_RETRY_DELAY_MS=0` nos testes, o backoff é zero e o
    // item volta na hora. Aqui a data é empurrada à mão para exercitar a espera.
    const { job } = await semearEventoQueFalha(5, "CTR-ESPERA");
    injetarDeadlock();

    await runProcessingCycle();

    await prisma.processingJob.update({
      where: { id: job.id },
      data: { disponivelEm: new Date(Date.now() + 60_000) },
    });

    const segundo = await runProcessingCycle();

    expect(segundo.claimed).toBe(0);
  });

  it("esgotadas as tentativas, o evento vai para ERRO", async () => {
    // Transitória de novo: o ponto aqui é que MESMO uma causa retentável vira
    // falha definitiva quando o orçamento de tentativas acaba. Os dois limites
    // existem, e este teste é sobre o segundo.
    const { job } = await semearEventoQueFalha(2, "CTR-ESGOTA");
    injetarDeadlock();

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

    const quando = new Date();
    const bom = await prisma.paymentEvent.create({
      data: {
        id: uuidV7(),
        idTransacao: "BOM-001",
        idContrato: "CTR-BOM",
        valor: 42,
        dataPagamento: new Date("2026-08-01T10:00:00Z"),
        statusOrigem: "PAGO",
        statusProcessamento: "PENDENTE",
        payloadBruto: {},
        assinaturaVerificada: false,
        recebidoEm: quando,
        tentativas: 0,
      },
    });
    await prisma.processingJob.create({
      data: {
        id: uuidV7(),
        paymentEventId: bom.id,
        estado: "PENDENTE",
        tentativas: 0,
        maxTentativas: 3,
        disponivelEm: quando,
        criadoEm: quando,
        atualizadoEm: quando,
      },
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
      const quando = new Date();
      const e = await prisma.paymentEvent.create({
        data: {
          id: uuidV7(),
          idTransacao: `BATCH-${i}`,
          idContrato: "CTR-BATCH",
          valor: 1,
          dataPagamento: new Date("2026-08-01T10:00:00Z"),
          statusOrigem: "PAGO",
          statusProcessamento: "PENDENTE",
          payloadBruto: {},
          assinaturaVerificada: false,
          recebidoEm: quando,
          tentativas: 0,
        },
      });
      await prisma.processingJob.create({
        data: {
          id: uuidV7(),
          paymentEventId: e.id,
          estado: "PENDENTE",
          tentativas: 0,
          maxTentativas: 3,
          disponivelEm: quando,
          criadoEm: quando,
          atualizadoEm: quando,
        },
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
