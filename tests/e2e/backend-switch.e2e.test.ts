import { describe, expect, it } from "vitest";

import {
  API_KEY,
  API_URL,
  Cliente,
  WEB_URL,
  aguardarAte,
  comBackend,
  navegador,
  pagamento,
  parceiro,
} from "./support";

/**
 * A troca de backend, ponta a ponta.
 *
 * <b>O que estes testes precisam provar - e o que seria facil fingir.</b> Um
 * botao que muda de cor passaria em qualquer teste superficial. O que se afirma
 * aqui e mais forte:
 *
 *   1. o gateway passa a despachar para OUTRA implementacao (header
 *      `x-sabemi-backend`, que vem de quem respondeu e nao de quem foi pedido);
 *   2. os DADOS mudam junto - cada backend tem o proprio banco, e um evento
 *      gravado em um nao existe no outro;
 *   3. os dois cumprem o MESMO contrato, campo a campo;
 *   4. a sessao e encerrada na troca, porque os usuarios tambem sao proprios.
 *
 * O item 2 e o que separa "troca de verdade" de "fachada": e impossivel passar
 * nele com um backend so.
 */

interface Ack {
  id_transacao: string;
  duplicate: boolean;
}

interface EventoDto {
  id_transacao: string;
  status_processamento: string;
}

/** Entrega um pagamento direto no backend indicado (sem passar pelo gateway). */
function entregarEm(backendId: "dotnet" | "vinext", corpo: unknown) {
  const base = backendId === "dotnet" ? API_URL : WEB_URL;
  const caminho = backendId === "dotnet" ? "/webhooks/pagamento" : "/api/bff/webhooks/pagamento";

  return parceiro(base).request<Ack>(caminho, {
    method: "POST",
    json: corpo,
    headers: { "X-Api-Key": API_KEY },
  });
}

/** Autentica no backend atualmente selecionado. */
async function autenticar(cliente: Cliente, rotulo: string) {
  const inicio = await cliente.post<{ selector: string; dev_magic_url: string }>(
    "/api/auth/login?step=start",
    { email: `${rotulo}-${Date.now()}@sabemi.com.br` },
  );

  await new Cliente("").get(inicio.body.dev_magic_url);

  const aprovado = await cliente.post<{ status: string; user?: { id: string } }>(
    "/api/auth/login?step=poll",
    { selector: inicio.body.selector },
  );

  expect(aprovado.body.status).toBe("approved");
  return aprovado.body.user!;
}

describe("seleção de backend", () => {
  it("o primário é o .NET, como exige a vaga", async () => {
    const cliente = navegador();

    const estado = await cliente.get<{ active: string; default: string }>("/api/backend");

    expect(estado.status).toBe(200);
    expect(estado.body.default).toBe("dotnet");
    // Sem cookie, o ativo é o padrão.
    expect(estado.body.active).toBe("dotnet");
  });

  it("informa a disponibilidade real de cada backend", async () => {
    const cliente = navegador();

    const estado = await cliente.get<{
      backends: Array<{ id: string; online: boolean; label: string }>;
    }>("/api/backend");

    expect(estado.body.backends).toHaveLength(2);
    // Com a stack no ar, os dois respondem.
    expect(estado.body.backends.every((b) => b.online)).toBe(true);
  });

  it("recusa um backend inexistente", async () => {
    const cliente = navegador();

    const resposta = await cliente.post("/api/backend", { backend: "postgres" });

    expect(resposta.status).toBe(400);
  });
});

describe("a troca muda quem responde", () => {
  it("o gateway despacha para a implementação selecionada", async () => {
    const cliente = navegador();

    // Começa no .NET.
    await cliente.post("/api/backend", { backend: "dotnet" });
    const noDotnet = await cliente.get<{ backend: string }>("/api/gateway/health");

    expect(noDotnet.headers.get("x-sabemi-backend")).toBe("dotnet");
    // O corpo vem de QUEM RESPONDEU, não do cookie que enviamos.
    expect(noDotnet.body.backend).toBe("dotnet");

    // Troca para o VINEXT.
    await cliente.post("/api/backend", { backend: "vinext" });
    const noVinext = await cliente.get<{ backend: string }>("/api/gateway/health");

    expect(noVinext.headers.get("x-sabemi-backend")).toBe("vinext");
    expect(noVinext.body.backend).toBe("vinext");

    // E volta.
    await cliente.post("/api/backend", { backend: "dotnet" });
    const devolta = await cliente.get<{ backend: string }>("/api/gateway/health");
    expect(devolta.body.backend).toBe("dotnet");
  });

  it("a troca encerra a sessão — cada backend tem seus próprios usuários", async () => {
    const cliente = navegador();

    await cliente.post("/api/backend", { backend: "dotnet" });
    await autenticar(cliente, "troca");

    expect(cliente.jar.tem("sabemi_session")).toBe(true);
    expect((await cliente.get("/api/gateway/payments")).status).toBe(200);

    // Troca de backend.
    const troca = await cliente.post<{ session_cleared: boolean }>("/api/backend", {
      backend: "vinext",
    });

    expect(troca.body.session_cleared).toBe(true);
    expect(cliente.jar.tem("sabemi_session")).toBe(false);

    // A sessão antiga não vale no novo backend.
    expect((await cliente.get("/api/gateway/payments")).status).toBe(401);
  });

  it("selecionar o backend já ativo preserva a sessão", async () => {
    const cliente = navegador();

    await cliente.post("/api/backend", { backend: "dotnet" });
    await autenticar(cliente, "mesma");

    const troca = await cliente.post<{ session_cleared: boolean }>("/api/backend", {
      backend: "dotnet",
    });

    expect(troca.body.session_cleared).toBe(false);
    expect((await cliente.get("/api/gateway/payments")).status).toBe(200);
  });

  it("o usuário criado em um backend não existe no outro", async () => {
    // Consequência direta de bancos separados - e a prova de que não são duas
    // fachadas sobre o mesmo armazenamento.
    const cliente = navegador();

    await cliente.post("/api/backend", { backend: "dotnet" });
    const noDotnet = await autenticar(cliente, "usuario");

    await cliente.post("/api/backend", { backend: "vinext" });
    const noVinext = await autenticar(cliente, "usuario");

    // Mesmo fluxo, identificadores diferentes: são registros de bancos distintos.
    expect(noDotnet.id).not.toBe(noVinext.id);
  });
});

describe("a troca muda os DADOS, não só a rota", () => {
  it("um evento gravado em um backend não aparece no outro", async () => {
    // O teste que torna impossível fingir a troca com um backend só.
    const soNoDotnet = pagamento({ valor: 11.11 });
    const soNoVinext = pagamento({ valor: 22.22 });

    expect((await entregarEm("dotnet", soNoDotnet)).status).toBe(202);
    expect((await entregarEm("vinext", soNoVinext)).status).toBe(202);

    // ---- Olhando pelo .NET.
    const noDotnet = await comBackend("dotnet");

    const dotnetVeOProprio = await noDotnet.get<EventoDto>(
      `/api/gateway/payments/${encodeURIComponent(soNoDotnet.id_transacao)}`,
    );
    const dotnetVeODoOutro = await noDotnet.get(
      `/api/gateway/payments/${encodeURIComponent(soNoVinext.id_transacao)}`,
    );

    expect(dotnetVeOProprio.status).toBe(200);
    expect(dotnetVeODoOutro.status).toBe(404);

    // ---- Olhando pelo VINEXT.
    const noVinext = await comBackend("vinext");

    const vinextVeOProprio = await noVinext.get<EventoDto>(
      `/api/gateway/payments/${encodeURIComponent(soNoVinext.id_transacao)}`,
    );
    const vinextVeODoOutro = await noVinext.get(
      `/api/gateway/payments/${encodeURIComponent(soNoDotnet.id_transacao)}`,
    );

    expect(vinextVeOProprio.status).toBe(200);
    expect(vinextVeODoOutro.status).toBe(404);
  });

  it("o mesmo id_transacao pode existir nos dois — são bancos independentes", async () => {
    // A idempotência é por backend, e é o comportamento correto: um índice único
    // do schema `dotnet` não tem por que restringir o schema `vinext`.
    const evento = pagamento({ valor: 33.33 });

    const noDotnet = await entregarEm("dotnet", evento);
    const noVinext = await entregarEm("vinext", evento);

    // Os dois aceitam como NOVO.
    expect(noDotnet.status).toBe(202);
    expect(noVinext.status).toBe(202);
    expect(noDotnet.body.duplicate).toBe(false);
    expect(noVinext.body.duplicate).toBe(false);

    // Mas dentro de cada um, a reentrega é rejeitada.
    expect((await entregarEm("dotnet", evento)).status).toBe(200);
    expect((await entregarEm("vinext", evento)).status).toBe(200);
  });
});

describe("os dois backends cumprem o mesmo contrato", () => {
  it("respondem /health com a mesma forma", async () => {
    const cliente = navegador();

    const respostas: Record<string, Record<string, unknown>> = {};

    for (const id of ["dotnet", "vinext"] as const) {
      await cliente.post("/api/backend", { backend: id });
      const r = await cliente.get<Record<string, unknown>>("/api/gateway/health");
      respostas[id] = r.body;
    }

    for (const id of ["dotnet", "vinext"] as const) {
      expect(respostas[id]).toHaveProperty("status", "healthy");
      expect(respostas[id]).toHaveProperty("backend", id);
      expect(respostas[id]).toHaveProperty("version");
    }
  });

  it("o ack do webhook tem exatamente os mesmos campos", async () => {
    const doDotnet = await entregarEm("dotnet", pagamento());
    const doVinext = await entregarEm("vinext", pagamento());

    const campos = (corpo: unknown) => Object.keys(corpo as object).sort();

    expect(campos(doDotnet.body)).toEqual(campos(doVinext.body));
    expect(campos(doDotnet.body)).toEqual([
      "duplicate",
      "id_transacao",
      "message",
      "received_at",
      "status",
    ]);
  });

  it("o erro de validação tem o mesmo formato e as mesmas mensagens", async () => {
    // Mensagens iguais não são coincidência: elas aparecem no dashboard, e um
    // mesmo payload defeituoso deve produzir o mesmo texto independentemente de
    // qual backend o recebeu.
    const invalido = pagamento({ id_contrato: "", valor: -1, status: "XPTO" });

    const doDotnet = await entregarEm("dotnet", { ...invalido });
    const doVinext = await entregarEm("vinext", { ...invalido, id_transacao: `${invalido.id_transacao}-B` });

    expect(doDotnet.status).toBe(400);
    expect(doVinext.status).toBe(400);

    const a = doDotnet.body as { code: string; errors: Record<string, string[]> };
    const b = doVinext.body as { code: string; errors: Record<string, string[]> };

    expect(a.code).toBe("validation_failed");
    expect(b.code).toBe("validation_failed");
    expect(Object.keys(a.errors).sort()).toEqual(Object.keys(b.errors).sort());
    expect(a.errors.valor).toEqual(b.errors.valor);
  });

  it("a página de listagem tem a mesma estrutura nos dois", async () => {
    const formas: string[][] = [];

    for (const id of ["dotnet", "vinext"] as const) {
      const autenticado = await comBackend(id);

      const r = await autenticado.get<Record<string, unknown>>("/api/gateway/payments?pageSize=1");
      expect(r.status).toBe(200);
      formas.push(Object.keys(r.body).sort());
    }

    expect(formas[0]).toEqual(formas[1]);
    expect(formas[0]).toEqual(["items", "page", "page_size", "total"]);
  });

  it("os dois recusam consulta sem sessão, com o mesmo formato de erro", async () => {
    const cliente = navegador();

    for (const id of ["dotnet", "vinext"] as const) {
      await cliente.post("/api/backend", { backend: id });

      const r = await cliente.get<{ detail: string }>("/api/gateway/payments");

      expect(r.status).toBe(401);
      expect(r.body).toHaveProperty("detail");
    }
  });
});

describe("ORM e persistência em ambos os backends", () => {
  it.each([
    { id: "dotnet" as const, orm: "EF Core", schema: "dotnet" },
    { id: "vinext" as const, orm: "Prisma", schema: "vinext" },
  ])("$orm persiste e consulta no schema $schema", async ({ id }) => {
    // Cada backend tem seu próprio ORM e seu próprio schema. O que se verifica
    // aqui é o ciclo completo de persistência: gravar pelo webhook, processar
    // e ler de volta pelo dashboard, com os valores decimais intactos.
    const evento = pagamento({ valor: 4321.99 });

    expect((await entregarEm(id, evento)).status).toBe(202);

    const cliente = await comBackend(id);

    const persistido = await aguardarAte(
      `o evento ser processado pelo backend ${id}`,
      async () => {
        const r = await cliente.get<EventoDto & { valor: number; payload_bruto: string }>(
          `/api/gateway/payments/${encodeURIComponent(evento.id_transacao)}`,
        );
        return r.status === 200 && r.body.status_processamento === "SUCESSO" ? r.body : null;
      },
    );

    // Decimal preservado sem erro de ponto flutuante - os dois ORMs mapeiam
    // para decimal(18,2).
    expect(persistido.valor).toBe(4321.99);

    // O payload bruto voltou íntegro.
    const bruto = JSON.parse(persistido.payload_bruto);
    expect(bruto.id_transacao).toBe(evento.id_transacao);

    // E a projeção no contrato aconteceu.
    const contrato = await cliente.get<{ valor_total_liquidado: number }>(
      `/api/gateway/contracts/${encodeURIComponent(evento.id_contrato)}`,
    );
    expect(contrato.status).toBe(200);
    expect(contrato.body.valor_total_liquidado).toBe(4321.99);
  });
});
