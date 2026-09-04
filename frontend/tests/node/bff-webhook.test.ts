import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { computeSignature } from "@/server/bff/crypto";
import { prisma } from "@/server/bff/db";
import { handleBffRequest } from "@/server/bff/router";
import { runProcessingCycle } from "@/server/bff/processing-service";
import type { PagedResult, PaymentEventDto, WebhookAck } from "@/lib/contracts";

/**
 * O backend VINEXT exercitado pelo seu roteador, contra PostgreSQL real.
 *
 * <b>Por que banco de verdade.</b> Vale o mesmo raciocinio do lado .NET: o que
 * garante a idempotencia e o indice unico, e o que move a fila e
 * `FOR UPDATE SKIP LOCKED`. Um duble de Prisma nao tem nem um nem outro - um
 * teste de idempotencia contra mock passaria com a implementacao quebrada.
 *
 * <b>Por que pelo roteador e nao pelos servicos.</b> E o mesmo ponto de entrada
 * que o gateway usa quando o backend VINEXT esta ativo, e o mesmo que atende o
 * `POST /api/bff/webhooks/pagamento`. Testar por aqui cobre roteamento,
 * autenticacao e os codigos HTTP, e nao so a regra isolada.
 *
 * <b>Espelhamento deliberado.</b> Estes casos repetem, um a um, os do backend
 * .NET. E de proposito: e assim que se demonstra que os dois cumprem o MESMO
 * contrato. Uma divergencia de comportamento aparece como um teste vermelho de
 * um lado so.
 */

const API_KEY = "chave-de-teste";
const SIGNATURE_SECRET = "segredo-de-teste";

interface Payload {
  id_transacao?: string;
  id_contrato?: string | null;
  valor?: number | null;
  data_pagamento?: string | null;
  status?: string | null;
}

function payload(over: Payload = {}): string {
  return JSON.stringify({
    id_transacao: "TRX-001",
    id_contrato: "CTR-001",
    valor: 1500.5,
    data_pagamento: "2026-08-01T10:00:00Z",
    status: "PAGO",
    ...over,
  });
}

function webhook(rawBody: string, opts: { apiKey?: string | null; signature?: string } = {}) {
  const headers = new Headers();
  const apiKey = opts.apiKey === undefined ? API_KEY : opts.apiKey;

  if (apiKey !== null) headers.set("x-api-key", apiKey);
  if (opts.signature) headers.set("x-signature", opts.signature);

  return handleBffRequest({
    method: "POST",
    path: "webhooks/pagamento",
    searchParams: new URLSearchParams(),
    rawBody,
    headers,
    token: null,
  });
}

async function limpar() {
  // A ordem respeita a chave estrangeira: jobs antes dos eventos.
  await prisma.processingJob.deleteMany();
  await prisma.paymentEvent.deleteMany();
  await prisma.contractStatus.deleteMany();
  await prisma.loginRequest.deleteMany();
  await prisma.appUser.deleteMany();
}

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

describe("segurança do webhook", () => {
  it("recusa a requisição sem ApiKey e não persiste nada", async () => {
    const resposta = await webhook(payload(), { apiKey: null });

    expect(resposta.status).toBe(401);
    // Gravar o que chega sem credencial transformaria a tabela de auditoria em
    // alvo trivial de enchimento.
    expect(await prisma.paymentEvent.count()).toBe(0);
  });

  it("recusa a ApiKey incorreta", async () => {
    const resposta = await webhook(payload(), { apiKey: "chave-errada" });

    expect(resposta.status).toBe(401);
    expect(resposta.body).toMatchObject({ code: "invalid_api_key" });
  });

  it("aceita e registra a assinatura HMAC válida", async () => {
    const corpo = payload({ id_transacao: "TRX-ASSINADO" });

    const resposta = await webhook(corpo, {
      signature: computeSignature(corpo, SIGNATURE_SECRET),
    });

    expect(resposta.status).toBe(202);

    const evento = await prisma.paymentEvent.findUnique({
      where: { idTransacao: "TRX-ASSINADO" },
    });
    expect(evento?.assinaturaVerificada).toBe(true);
  });

  it("aceita a assinatura com o prefixo sha256=", async () => {
    const corpo = payload({ id_transacao: "TRX-PREFIXO" });
    const assinatura = computeSignature(corpo, SIGNATURE_SECRET);

    const resposta = await webhook(corpo, { signature: `sha256=${assinatura}` });

    expect(resposta.status).toBe(202);
  });

  it("recusa a assinatura calculada sobre OUTRO corpo", async () => {
    // O ataque que a ApiKey sozinha não impede: credencial válida, corpo
    // adulterado em trânsito.
    const assinaturaDeOutro = computeSignature(payload({ valor: 1 }), SIGNATURE_SECRET);

    const resposta = await webhook(payload({ valor: 999999 }), {
      signature: assinaturaDeOutro,
    });

    expect(resposta.status).toBe(403);
    expect(resposta.body).toMatchObject({ code: "invalid_signature" });
  });
});

describe("ingestão", () => {
  it("aceita o payload válido com 202 e enfileira o processamento", async () => {
    const resposta = await webhook(payload());

    expect(resposta.status).toBe(202);

    const ack = resposta.body as WebhookAck;
    expect(ack.duplicate).toBe(false);
    expect(ack.status).toBe("PENDENTE");

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "TRX-001" },
      include: { job: true },
    });

    expect(evento.statusProcessamento).toBe("PENDENTE");
    expect(evento.valor?.toNumber()).toBe(1500.5);

    // Evento e job na mesma transação: não existe evento aceito sem trabalho
    // enfileirado para ele.
    expect(evento.job).not.toBeNull();
    expect(evento.job?.estado).toBe("PENDENTE");
  });

  it("grava o payload bruto para auditoria", async () => {
    await webhook(payload({ id_transacao: "TRX-BRUTO" }));

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "TRX-BRUTO" },
    });

    expect(evento.payloadBruto).toMatchObject({
      id_transacao: "TRX-BRUTO",
      valor: 1500.5,
    });
  });

  it("responde rápido mesmo com a regra pesada em duração real", async () => {
    // O critério da task: a regra de ~2s não pode entrar no caminho da resposta.
    //
    // `resetModules` + import dinâmico força uma instância nova do serviço, para
    // que ele releia a configuração com a duração REAL - o config é lido uma vez,
    // no carregamento do módulo, e os demais testes rodam com duração zero.
    vi.resetModules();
    process.env.PROCESSING_SIMULATED_WORK_MS = "2000";

    try {
      const { ingestPayment } = await import("@/server/bff/payments-service");

      const inicio = performance.now();
      const resultado = await ingestPayment(payload({ id_transacao: "TRX-RAPIDO" }), false);
      const decorrido = performance.now() - inicio;

      expect(resultado.kind).toBe("accepted");
      // A ingestão apenas grava e enfileira; quem paga os 2s é o worker.
      expect(decorrido).toBeLessThan(1000);
    } finally {
      // Restaura o ambiente mesmo se a asserção falhar - senão o vazamento
      // deixaria os testes seguintes lentos, com a causa em outro arquivo.
      process.env.PROCESSING_SIMULATED_WORK_MS = "0";
      vi.resetModules();
    }
  });
});

describe("idempotência", () => {
  it("a reentrega devolve 200 com duplicate e não cria um segundo job", async () => {
    await webhook(payload({ id_transacao: "TRX-DUP" }));
    const segunda = await webhook(payload({ id_transacao: "TRX-DUP" }));

    expect(segunda.status).toBe(200);
    expect((segunda.body as WebhookAck).duplicate).toBe(true);

    expect(await prisma.paymentEvent.count({ where: { idTransacao: "TRX-DUP" } })).toBe(1);
    expect(await prisma.processingJob.count()).toBe(1);
  });

  it("a reentrega com corpo diferente NÃO sobrescreve o original", async () => {
    // Aceitar a segunda permitiria alterar um pagamento já processado apenas
    // reenviando a notificação.
    await webhook(payload({ id_transacao: "TRX-MUT", valor: 100 }));
    await webhook(payload({ id_transacao: "TRX-MUT", valor: 999999 }));

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "TRX-MUT" },
    });

    expect(evento.valor?.toNumber()).toBe(100);
  });

  it("vinte reentregas SIMULTÂNEAS produzem exatamente um evento", async () => {
    // O teste central. Sob concorrência, várias passam pela consulta prévia ao
    // mesmo tempo; quem arbitra é o índice único do banco.
    const respostas = await Promise.all(
      Array.from({ length: 20 }, () => webhook(payload({ id_transacao: "TRX-CORRIDA" }))),
    );

    expect(respostas.filter((r) => r.status === 202)).toHaveLength(1);
    expect(respostas.filter((r) => r.status === 200)).toHaveLength(19);

    expect(await prisma.paymentEvent.count({ where: { idTransacao: "TRX-CORRIDA" } })).toBe(1);
    expect(await prisma.processingJob.count()).toBe(1);
  });

  it("a resposta de duplicado informa a situação REAL do evento conhecido", async () => {
    await webhook(payload({ id_transacao: "TRX-JA-PROC" }));
    await runProcessingCycle();

    const reentrega = await webhook(payload({ id_transacao: "TRX-JA-PROC" }));

    // O parceiro descobre no mesmo passo que já foi recebido E que já foi
    // processado com sucesso.
    expect((reentrega.body as WebhookAck).status).toBe("SUCESSO");
    expect((reentrega.body as WebhookAck).duplicate).toBe(true);
  });
});

describe("validação", () => {
  it("reprova com 400 mas PERSISTE o evento para auditoria", async () => {
    const resposta = await webhook(
      payload({
        id_transacao: "TRX-INVALIDO",
        id_contrato: "",
        valor: -5,
        status: "XPTO",
      }),
    );

    expect(resposta.status).toBe(400);
    expect(resposta.body).toMatchObject({ code: "validation_failed" });

    const erros = (resposta.body as { errors: Record<string, string[]> }).errors;
    expect(Object.keys(erros)).toEqual(expect.arrayContaining(["id_contrato", "valor", "status"]));

    // O requisito de visualização de erros: o evento reprovado aparece no
    // dashboard em vez de sumir.
    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "TRX-INVALIDO" },
    });
    expect(evento.statusProcessamento).toBe("INVALIDO");
    expect(evento.erro).toBeTruthy();

    // Sem job: não há o que processar num evento reprovado.
    expect(await prisma.processingJob.count()).toBe(0);
  });

  it("reprova a data de pagamento no futuro", async () => {
    const futuro = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();

    const resposta = await webhook(
      payload({ id_transacao: "TRX-FUTURO", data_pagamento: futuro }),
    );

    expect(resposta.status).toBe(400);

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "TRX-FUTURO" },
    });
    expect(evento.erro).toContain("futuro");
  });

  it("tolera pequena deriva de relógio", async () => {
    const poucoAdiante = new Date(Date.now() + 60_000).toISOString();

    const resposta = await webhook(
      payload({ id_transacao: "TRX-DERIVA", data_pagamento: poucoAdiante }),
    );

    expect(resposta.status).toBe(202);
  });

  it("recusa sem persistir quando falta o id_transacao", async () => {
    const resposta = await webhook(JSON.stringify({ id_contrato: "CTR-1", valor: 10 }));

    expect(resposta.status).toBe(400);
    expect(await prisma.paymentEvent.count()).toBe(0);
  });

  it("trata JSON malformado no formato do contrato", async () => {
    const resposta = await webhook("{ isto nao e json ");

    expect(resposta.status).toBe(400);
    expect(resposta.body).toHaveProperty("detail");
  });

  it("preserva o que dá para extrair de um payload defeituoso", async () => {
    // O dashboard precisa de contexto mesmo quando o corpo veio quebrado.
    await webhook(payload({ id_transacao: "TRX-PARCIAL", valor: -1 }));

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "TRX-PARCIAL" },
    });

    expect(evento.idContrato).toBe("CTR-001");
    expect(evento.statusOrigem).toBe("PAGO");
  });

  it.each(["PAGO", "CANCELADO"])(
    "aceita o status %s do contrato",
    async (status) => {
      const resposta = await webhook(payload({ id_transacao: `TRX-${status}`, status }));

      expect(resposta.status).toBe(202);
    },
  );
});

describe("rota e saúde", () => {
  it("identifica o backend como vinext", async () => {
    const resposta = await handleBffRequest({
      method: "GET",
      path: "health",
      searchParams: new URLSearchParams(),
      rawBody: "",
      headers: new Headers(),
      token: null,
    });

    expect(resposta.status).toBe(200);
    expect(resposta.body).toMatchObject({ status: "healthy", backend: "vinext" });
  });

  it("devolve 404 para rota desconhecida", async () => {
    const resposta = await handleBffRequest({
      method: "GET",
      path: "rota/que/nao/existe",
      searchParams: new URLSearchParams(),
      rawBody: "",
      headers: new Headers(),
      token: null,
    });

    expect(resposta.status).toBe(404);
    expect(resposta.body).toMatchObject({ code: "route_not_found" });
  });

  it("exige sessão nas consultas do dashboard", async () => {
    const resposta = await handleBffRequest({
      method: "GET",
      path: "payments",
      searchParams: new URLSearchParams(),
      rawBody: "",
      headers: new Headers(),
      token: null,
    });

    expect(resposta.status).toBe(401);
  });
});

describe("processamento em background", () => {
  it("processa a fila e atualiza o contrato", async () => {
    await webhook(payload({ id_transacao: "TRX-PROC", id_contrato: "CTR-P", valor: 250 }));

    const ciclo = await runProcessingCycle();

    expect(ciclo.claimed).toBe(1);
    expect(ciclo.succeeded).toBe(1);

    const evento = await prisma.paymentEvent.findUniqueOrThrow({
      where: { idTransacao: "TRX-PROC" },
      include: { job: true },
    });
    expect(evento.statusProcessamento).toBe("SUCESSO");
    expect(evento.processadoEm).not.toBeNull();
    expect(evento.job?.estado).toBe("CONCLUIDO");

    const contrato = await prisma.contractStatus.findUniqueOrThrow({
      where: { idContrato: "CTR-P" },
    });
    expect(contrato.valorTotalLiquidado.toNumber()).toBe(250);
    expect(contrato.pagamentosConfirmados).toBe(1);
    expect(contrato.situacao).toBe("LIQUIDADO");
  });

  it("acumula vários pagamentos do mesmo contrato sem perder nenhum", async () => {
    for (let i = 1; i <= 5; i++) {
      await webhook(payload({ id_transacao: `LOTE-${i}`, id_contrato: "CTR-LOTE", valor: 10 }));
    }

    const ciclo = await runProcessingCycle();
    expect(ciclo.succeeded).toBe(5);

    const contrato = await prisma.contractStatus.findUniqueOrThrow({
      where: { idContrato: "CTR-LOTE" },
    });

    // A soma exata é a prova de que nada foi contado duas vezes nem perdido.
    expect(contrato.valorTotalLiquidado.toNumber()).toBe(50);
    expect(contrato.pagamentosConfirmados).toBe(5);
  });

  it.each(["CANCELADO", "ESTORNADO"])(
    "pagamento %s não soma ao total liquidado",
    async (status) => {
      await webhook(
        payload({ id_transacao: `TRX-${status}`, id_contrato: "CTR-CANC", valor: 500, status }),
      );

      await runProcessingCycle();

      const contrato = await prisma.contractStatus.findUniqueOrThrow({
        where: { idContrato: "CTR-CANC" },
      });

      expect(contrato.valorTotalLiquidado.toNumber()).toBe(0);
      expect(contrato.situacao).toBe("INADIMPLENTE");
    },
  );

  it("fila vazia não faz trabalho algum", async () => {
    const ciclo = await runProcessingCycle();

    expect(ciclo.claimed).toBe(0);
    expect(ciclo.succeeded).toBe(0);
  });

  it("não reprocessa um evento já concluído", async () => {
    await webhook(payload({ id_transacao: "TRX-UMA-VEZ", id_contrato: "CTR-U", valor: 77 }));

    await runProcessingCycle();
    const segundoCiclo = await runProcessingCycle();

    expect(segundoCiclo.claimed).toBe(0);

    const contrato = await prisma.contractStatus.findUniqueOrThrow({
      where: { idContrato: "CTR-U" },
    });
    // Continua 77, e não 154.
    expect(contrato.valorTotalLiquidado.toNumber()).toBe(77);
  });

  it("devolve à fila o item órfão cujo lease expirou", async () => {
    // Simula o processo morto no meio do trabalho: o item fica em PROCESSANDO e
    // ninguém o conclui. Sem a varredura, ficaria travado para sempre.
    await webhook(payload({ id_transacao: "TRX-ORFAO", id_contrato: "CTR-O" }));

    const job = await prisma.processingJob.findFirstOrThrow();
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        estado: "PROCESSANDO",
        reivindicadoEm: new Date(Date.now() - 10 * 60_000),
        reivindicadoPor: "processo-que-morreu",
        tentativas: 1,
      },
    });

    const ciclo = await runProcessingCycle();

    expect(ciclo.released).toBe(1);
    expect(ciclo.succeeded).toBe(1);
  });

  it("não rouba um item que está sendo processado dentro do prazo", async () => {
    await webhook(payload({ id_transacao: "TRX-ATIVO" }));

    const job = await prisma.processingJob.findFirstOrThrow();
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { estado: "PROCESSANDO", reivindicadoEm: new Date(), reivindicadoPor: "ativo" },
    });

    const ciclo = await runProcessingCycle();

    expect(ciclo.released).toBe(0);
    expect(ciclo.claimed).toBe(0);
  });
});

describe("filtros do dashboard", () => {
  /** Sessão válida, para as rotas protegidas. */
  async function comSessao(): Promise<string> {
    const inicio = await handleBffRequest({
      method: "POST",
      path: "auth/magic-link",
      searchParams: new URLSearchParams(),
      rawBody: JSON.stringify({ email: "dash@sabemi.com.br" }),
      headers: new Headers(),
      token: null,
    });

    const { selector, dev_magic_url } = inicio.body as {
      selector: string;
      dev_magic_url: string;
    };

    const token = new URL(dev_magic_url).searchParams.get("token")!;

    await handleBffRequest({
      method: "GET",
      path: "auth/confirm",
      searchParams: new URLSearchParams({ token }),
      rawBody: "",
      headers: new Headers(),
      token: null,
    });

    const aprovado = await handleBffRequest({
      method: "POST",
      path: "auth/login-status",
      searchParams: new URLSearchParams({ selector }),
      rawBody: "",
      headers: new Headers(),
      token: null,
    });

    return (aprovado.body as { access_token: string }).access_token;
  }

  async function consultar(token: string, params: Record<string, string> = {}) {
    return handleBffRequest({
      method: "GET",
      path: "payments",
      searchParams: new URLSearchParams(params),
      rawBody: "",
      headers: new Headers(),
      token,
    });
  }

  async function semear() {
    // Sucessos.
    await webhook(payload({ id_transacao: "S-1", id_contrato: "CTR-A" }));
    await webhook(payload({ id_transacao: "S-2", id_contrato: "CTR-A" }));
    await webhook(payload({ id_transacao: "S-3", id_contrato: "CTR-B" }));
    await runProcessingCycle();

    // Inválidos.
    await webhook(payload({ id_transacao: "I-1", id_contrato: "CTR-A", valor: -1 }));
    await webhook(payload({ id_transacao: "I-2", id_contrato: "CTR-B", status: "NOPE" }));

    // Pendente (não processado).
    await webhook(payload({ id_transacao: "P-1", id_contrato: "CTR-B" }));
  }

  it("sem filtro devolve tudo, do mais recente para o mais antigo", async () => {
    const token = await comSessao();
    await semear();

    const resposta = await consultar(token);
    const pagina = resposta.body as PagedResult<PaymentEventDto>;

    expect(pagina.total).toBe(6);
    expect(pagina.items[0].id_transacao).toBe("P-1");
  });

  it.each([
    ["SUCESSO", 3],
    ["INVALIDO", 2],
    ["PENDENTE", 1],
    ["ERRO", 0],
  ])("filtra por status %s", async (status, esperado) => {
    const token = await comSessao();
    await semear();

    const pagina = (await consultar(token, { status })).body as PagedResult<PaymentEventDto>;

    expect(pagina.total).toBe(esperado);
    expect(pagina.items.every((e) => e.status_processamento === status)).toBe(true);
  });

  it.each([
    ["CTR-A", 3],
    ["CTR-B", 3],
    ["CTR-FANTASMA", 0],
  ])("filtra por contrato %s", async (contractId, esperado) => {
    const token = await comSessao();
    await semear();

    const pagina = (await consultar(token, { contractId })).body as PagedResult<PaymentEventDto>;

    expect(pagina.total).toBe(esperado);
  });

  it("combina os dois filtros", async () => {
    const token = await comSessao();
    await semear();

    const pagina = (await consultar(token, { status: "SUCESSO", contractId: "CTR-A" }))
      .body as PagedResult<PaymentEventDto>;

    expect(pagina.total).toBe(2);
  });

  it("status desconhecido degrada para sem filtro, e não para erro", async () => {
    // Numa tela de consulta, devolver 400 por um parâmetro de URL digitado
    // errado atrapalha mais do que ajuda.
    const token = await comSessao();
    await semear();

    const resposta = await consultar(token, { status: "BANANA" });

    expect(resposta.status).toBe(200);
    expect((resposta.body as PagedResult<PaymentEventDto>).total).toBe(6);
  });

  it("pagina sem repetir nem perder itens", async () => {
    const token = await comSessao();
    await semear();

    const p1 = (await consultar(token, { page: "1", pageSize: "4" }))
      .body as PagedResult<PaymentEventDto>;
    const p2 = (await consultar(token, { page: "2", pageSize: "4" }))
      .body as PagedResult<PaymentEventDto>;

    expect(p1.items).toHaveLength(4);
    expect(p2.items).toHaveLength(2);
    expect(p1.total).toBe(6);

    const ids = [...p1.items, ...p2.items].map((e) => e.id_transacao);
    expect(new Set(ids).size).toBe(6);
  });

  it("limita o pageSize ao teto", async () => {
    const token = await comSessao();
    await semear();

    const pagina = (await consultar(token, { pageSize: "99999" }))
      .body as PagedResult<PaymentEventDto>;

    expect(pagina.page_size).toBe(100);
  });

  it("o resumo traz todas as chaves, inclusive as zeradas", async () => {
    const token = await comSessao();
    await semear();

    const resposta = await handleBffRequest({
      method: "GET",
      path: "payments/summary",
      searchParams: new URLSearchParams(),
      rawBody: "",
      headers: new Headers(),
      token,
    });

    const resumo = resposta.body as { total: number; por_status: Record<string, number> };

    expect(resumo.total).toBe(6);
    expect(resumo.por_status).toMatchObject({
      SUCESSO: 3,
      INVALIDO: 2,
      PENDENTE: 1,
      ERRO: 0,
      PROCESSANDO: 0,
      DUPLICADO: 0,
    });
  });

  it("o detalhe traz o payload bruto", async () => {
    const token = await comSessao();
    await semear();

    const resposta = await handleBffRequest({
      method: "GET",
      path: "payments/S-1",
      searchParams: new URLSearchParams(),
      rawBody: "",
      headers: new Headers(),
      token,
    });

    expect(resposta.status).toBe(200);
    expect(resposta.body).toHaveProperty("payload_bruto");
  });

  it("devolve 404 para transação inexistente", async () => {
    const token = await comSessao();

    const resposta = await handleBffRequest({
      method: "GET",
      path: "payments/NAO-EXISTE",
      searchParams: new URLSearchParams(),
      rawBody: "",
      headers: new Headers(),
      token,
    });

    expect(resposta.status).toBe(404);
  });

  it("consulta o estado consolidado do contrato", async () => {
    const token = await comSessao();
    await semear();

    const resposta = await handleBffRequest({
      method: "GET",
      path: "contracts/CTR-A",
      searchParams: new URLSearchParams(),
      rawBody: "",
      headers: new Headers(),
      token,
    });

    expect(resposta.status).toBe(200);
    expect(resposta.body).toMatchObject({ id_contrato: "CTR-A", pagamentos_confirmados: 2 });
  });

  it("devolve 404 para contrato inexistente", async () => {
    const token = await comSessao();

    const resposta = await handleBffRequest({
      method: "GET",
      path: "contracts/CTR-FANTASMA",
      searchParams: new URLSearchParams(),
      rawBody: "",
      headers: new Headers(),
      token,
    });

    expect(resposta.status).toBe(404);
  });
});
