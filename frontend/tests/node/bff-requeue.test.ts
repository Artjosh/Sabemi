import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/bff/db";
import { uuidV7 } from "@/server/bff/ids";
import { runProcessingCycle } from "@/server/bff/processing-service";
import { reenfileirar } from "@/server/bff/requeue-service";

/**
 * Retry por tipo de erro e reenfileiramento manual no backend VINEXT.
 *
 * As duas coisas sao as duas metades da mesma decisao. O sistema retenta sozinho
 * o que melhora com o tempo; o que nao melhora vai direto para ERRO, com a causa
 * explicada, e espera por uma pessoa.
 *
 * <b>Espelho de `Sabemi.IntegrationTests/Worker/RequeueTests.cs`.</b> Os mesmos
 * cenarios rodam nos dois backends porque o painel e um so: o operador nao pode
 * receber respostas diferentes conforme o backend selecionado.
 *
 * Roda contra PostgreSQL de verdade - e o unico jeito de exercitar a transacao
 * que devolve evento e job a fila de uma vez so.
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

/**
 * Cria um evento e o job dele.
 *
 * `idContrato: null` e o que faz a regra falhar: a consolidacao precisa do
 * contrato. E uma falha PERMANENTE - o payload nao ganha um contrato por ser
 * reprocessado - e por isso serve para exercitar tanto o "nao retentar" quanto
 * o reenfileiramento manual.
 */
async function semear({
  idTransacao,
  idContrato = null,
  valor = null,
}: {
  idTransacao: string;
  idContrato?: string | null;
  valor?: number | null;
}) {
  const agora = new Date();

  const evento = await prisma.paymentEvent.create({
    data: {
      id: uuidV7(),
      idTransacao,
      idContrato,
      valor,
      statusOrigem: "PAGO",
      statusProcessamento: "PENDENTE",
      payloadBruto: {},
      assinaturaVerificada: false,
      recebidoEm: agora,
      tentativas: 0,
    },
  });

  await prisma.processingJob.create({
    data: {
      id: uuidV7(),
      paymentEventId: evento.id,
      estado: "PENDENTE",
      tentativas: 0,
      maxTentativas: 3,
      disponivelEm: agora,
      criadoEm: agora,
      atualizadoEm: agora,
    },
  });

  return evento;
}

describe("retry decidido pelo tipo de erro", () => {
  it("uma falha permanente vai direto para ERRO, sem gastar as tentativas", async () => {
    // O ponto do retry por tipo: um evento sem contrato nao ganha um contrato na
    // segunda tentativa. Insistir tres vezes so atrasa em minutos a unica coisa
    // util - o evento aparecer no painel com a causa e o botao.
    await semear({ idTransacao: "PERM-1" });

    const ciclo = await runProcessingCycle();

    expect(ciclo.failed).toBe(1);
    expect(ciclo.retried).toBe(0);

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "PERM-1" },
    });

    expect(evento.statusProcessamento).toBe("ERRO");
    expect(evento.erroCategoria).toBe("PERMANENTE");
    expect(evento.tentativas).toBe(1);
  });

  it("grava o codigo da causa, e nao so a mensagem crua", async () => {
    // O codigo e o que a UI usa para escolher o texto do tooltip, e o que agrupa
    // as falhas numa metrica sem depender da mensagem da excecao.
    await semear({ idTransacao: "PERM-2" });

    await runProcessingCycle();

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "PERM-2" },
    });

    expect(evento.erroCodigo).toBeTruthy();
    expect(evento.erro).toBeTruthy();
  });
});

describe("reenfileiramento manual", () => {
  it("devolve o evento a fila e ele processa na sequencia", async () => {
    // O ciclo completo que justifica o botao: falhou, a pessoa corrigiu o que
    // faltava, clicou, e agora passa.
    const evento = await semear({ idTransacao: "FIX-1" });

    await runProcessingCycle();
    expect(
      (await prisma.paymentEvent.findUniqueOrThrow({ where: { idTransacao: "FIX-1" } }))
        .statusProcessamento,
    ).toBe("ERRO");

    // A "correcao": o contrato que faltava passa a existir no evento.
    await prisma.paymentEvent.update({
      where: { id: evento.id },
      data: { idContrato: "CTR-FIX", valor: 250 },
    });

    const resultado = await reenfileirar("FIX-1");

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.status_processamento).toBe("PENDENTE");

    const ciclo = await runProcessingCycle();
    expect(ciclo.succeeded).toBe(1);

    const final = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "FIX-1" },
    });
    expect(final.statusProcessamento).toBe("SUCESSO");

    // O sucesso limpa o diagnostico: manter a causa antiga numa linha que deu
    // certo faria o painel mostrar um erro que nao existe mais.
    expect(final.erroCodigo).toBeNull();
    expect(final.erroCategoria).toBeNull();

    const contrato = await prisma.contractStatus.findUniqueOrThrow({
      where: { idContrato: "CTR-FIX" },
    });
    expect(Number(contrato.valorTotalLiquidado)).toBe(250);
    expect(contrato.pagamentosConfirmados).toBe(1);
  });

  it("RECUSA reenfileirar um evento que ja teve SUCESSO", async () => {
    // A protecao mais importante deste endpoint. A idempotencia da ingestao
    // impede um evento DUPLICADO de entrar - ela nao impede o MESMO evento de
    // ser processado duas vezes. Sem esta recusa, dois cliques dobrariam o valor
    // liquidado do contrato.
    await semear({ idTransacao: "OK-1", idContrato: "CTR-OK", valor: 500 });

    await runProcessingCycle();

    const resultado = await reenfileirar("OK-1");

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.failure).toBe("not_eligible");
    expect(resultado.message).toContain("ja esta somado ao contrato");

    const contrato = await prisma.contractStatus.findUniqueOrThrow({
      where: { idContrato: "CTR-OK" },
    });
    expect(Number(contrato.valorTotalLiquidado)).toBe(500);
    expect(contrato.pagamentosConfirmados).toBe(1);
  });

  it("dois cliques seguidos nao geram dois processamentos", async () => {
    // O segundo clique encontra o evento ja em PENDENTE e e recusado - e o que
    // torna o botao seguro contra o duplo-clique apressado.
    await semear({ idTransacao: "2X-1" });
    await runProcessingCycle();

    expect((await reenfileirar("2X-1")).ok).toBe(true);

    const segundo = await reenfileirar("2X-1");
    expect(segundo.ok).toBe(false);
    if (segundo.ok) return;
    expect(segundo.message).toContain("ja esta na fila");

    const jobs = await prisma.processingJob.findMany({
      where: { paymentEvent: { idTransacao: "2X-1" } },
    });
    expect(jobs).toHaveLength(1);
  });

  it("zera as tentativas, para o item nao morrer na primeira falha nova", async () => {
    // Um item que falhou esgotou o orcamento de tentativas. Devolve-lo sem zerar
    // faria o botao parecer nao funcionar: uma tentativa e a morte de novo.
    await semear({ idTransacao: "ZERO-1" });
    await runProcessingCycle();

    await reenfileirar("ZERO-1");

    const job = await prisma.processingJob.findFirstOrThrow({
      where: { paymentEvent: { idTransacao: "ZERO-1" } },
    });

    expect(job.tentativas).toBe(0);
    expect(job.estado).toBe("PENDENTE");
  });

  it("preserva o registro do que aconteceu", async () => {
    // `ultimoErro` NAO e limpo ao reenfileirar: apaga-lo destruiria o unico
    // registro da causa justo enquanto alguem investiga.
    await semear({ idTransacao: "HIST-1" });
    await runProcessingCycle();

    await reenfileirar("HIST-1");

    const job = await prisma.processingJob.findFirstOrThrow({
      where: { paymentEvent: { idTransacao: "HIST-1" } },
    });

    expect(job.ultimoErro).toBeTruthy();
  });

  it("recusa um id_transacao inexistente", async () => {
    const resultado = await reenfileirar("NAO-EXISTE");

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.failure).toBe("not_found");
  });

  it("recria o job quando ele foi apagado por fora", async () => {
    // Um evento em ERRO sempre teve job - eles nascem na mesma transacao. Chegar
    // sem job significa que a linha da fila foi apagada a mao; o dado que importa
    // (o evento bruto) esta intacto, e e dele que o job deriva.
    await semear({ idTransacao: "SEMJOB-1" });
    await runProcessingCycle();

    await prisma.processingJob.deleteMany({
      where: { paymentEvent: { idTransacao: "SEMJOB-1" } },
    });

    const resultado = await reenfileirar("SEMJOB-1");
    expect(resultado.ok).toBe(true);

    const jobs = await prisma.processingJob.findMany({
      where: { paymentEvent: { idTransacao: "SEMJOB-1" } },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.estado).toBe("PENDENTE");
  });
});
