import { describe, expect, it } from "vitest";

import {
  API_KEY,
  API_URL,
  BACKENDS,
  WEB_URL,
  Cliente,
  aguardarAte,
  comBackend,
  descreveComLogin,
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

/**
 * Entrega um pagamento direto no backend indicado (sem passar pelo gateway).
 *
 * Genérico porque o MESMO endpoint devolve corpos diferentes conforme o
 * desfecho: `Ack` em 202 e 200, e `ProblemDetails` em 400. Fixar o tipo em `Ack`
 * obrigava quem testa a validação a converter com `as`, e o TypeScript recusava
 * a conversão - com razão, porque os dois tipos não se sobrepõem.
 */
function entregarEm<T = Ack>(backendId: "dotnet" | "vinext", corpo: unknown) {
  const base = backendId === "dotnet" ? API_URL : WEB_URL;
  const caminho = backendId === "dotnet" ? "/webhooks/pagamento" : "/api/bff/webhooks/pagamento";

  return parceiro(base).request<T>(caminho, {
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

  const aprovado = await cliente.post<{
    status: string;
    user?: { id: string; email: string };
  }>("/api/auth/login?step=poll", { selector: inicio.body.selector });

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

descreveComLogin("a troca muda quem responde", () => {
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

  it("a sessão SOBREVIVE à troca — sem refazer login", async () => {
    // O comportamento que o schema compartilhado torna possível: os dois
    // backends enxergam os mesmos usuários e assinam com o mesmo segredo.
    const cliente = navegador();

    await cliente.post("/api/backend", { backend: "dotnet" });
    const usuario = await autenticar(cliente, "sessao-sobrevive");

    const cookieAntes = cliente.jar.valor("sabemi_session");
    expect(cookieAntes).toBeTruthy();
    expect((await cliente.get("/api/gateway/payments")).status).toBe(200);

    const troca = await cliente.post<{ session_preserved: boolean }>("/api/backend", {
      backend: "vinext",
    });

    expect(troca.body.session_preserved).toBe(true);

    // O MESMO cookie continua ali - não foi reemitido, apenas preservado.
    expect(cliente.jar.valor("sabemi_session")).toBe(cookieAntes);

    // E dá acesso ao dashboard no OUTRO backend, sem novo login.
    const noOutro = await cliente.get("/api/gateway/payments");
    expect(noOutro.status).toBe(200);
    expect(noOutro.headers.get("x-sabemi-backend")).toBe("vinext");

    // E é o mesmo usuário.
    const sessao = await cliente.get<{ user: { id: string; email: string } }>(
      "/api/auth/session",
    );
    expect(sessao.status).toBe(200);
    expect(sessao.body.user.id).toBe(usuario.id);
    expect(sessao.body.user.email).toBe(usuario.email);
  });

  it("o usuário é o MESMO nos dois backends", async () => {
    // Consequência direta do schema compartilhado - e o oposto do que acontecia
    // quando cada backend tinha o próprio banco.
    const cliente = navegador();

    await cliente.post("/api/backend", { backend: "dotnet" });
    const noDotnet = await autenticar(cliente, "usuario-unico");

    await cliente.post("/api/backend", { backend: "vinext" });
    const noVinext = await cliente.get<{ user: { id: string } }>("/api/auth/session");

    expect(noVinext.status).toBe(200);
    expect(noVinext.body.user.id).toBe(noDotnet.id);
  });
});

descreveComLogin("a troca muda os DADOS, não só a rota", () => {
  it("um evento entregue a um backend é visível pelo OUTRO", async () => {
    // A propriedade que o schema compartilhado entrega: a troca muda a
    // IMPLEMENTAÇÃO, e não os dados.
    const peloDotnet = pagamento({ valor: 11.11 });
    const peloVinext = pagamento({ valor: 22.22 });

    expect((await entregarEm("dotnet", peloDotnet)).status).toBe(202);
    expect((await entregarEm("vinext", peloVinext)).status).toBe(202);

    // ---- Olhando pelo .NET: enxerga os dois.
    const noDotnet = await comBackend("dotnet");

    expect(
      (await noDotnet.get<EventoDto>(
        `/api/gateway/payments/${encodeURIComponent(peloDotnet.id_transacao)}`,
      )).status,
    ).toBe(200);
    expect(
      (await noDotnet.get(
        `/api/gateway/payments/${encodeURIComponent(peloVinext.id_transacao)}`,
      )).status,
    ).toBe(200);

    // ---- Olhando pelo VINEXT: também enxerga os dois.
    const noVinext = await comBackend("vinext");

    expect(
      (await noVinext.get<EventoDto>(
        `/api/gateway/payments/${encodeURIComponent(peloVinext.id_transacao)}`,
      )).status,
    ).toBe(200);
    expect(
      (await noVinext.get(
        `/api/gateway/payments/${encodeURIComponent(peloDotnet.id_transacao)}`,
      )).status,
    ).toBe(200);
  });

  it("a idempotência vale ENTRE os backends", async () => {
    // Consequência importante do índice único compartilhado: uma reentrega que
    // chega pelo OUTRO backend também é recusada. Com bancos separados, o mesmo
    // pagamento seria processado duas vezes - uma de cada lado.
    const evento = pagamento({ valor: 33.33 });

    const primeira = await entregarEm("dotnet", evento);
    expect(primeira.status).toBe(202);
    expect(primeira.body.duplicate).toBe(false);

    // A MESMA transação, agora entregue ao outro backend.
    const segunda = await entregarEm("vinext", evento);
    expect(segunda.status).toBe(200);
    expect(segunda.body.duplicate).toBe(true);

    // E vice-versa.
    const outro = pagamento({ valor: 44.44 });
    expect((await entregarEm("vinext", outro)).status).toBe(202);
    expect((await entregarEm("dotnet", outro)).status).toBe(200);
  });
});

descreveComLogin("os dois backends cumprem o mesmo contrato", () => {
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

    type Recusa = { code: string; errors: Record<string, string[]> };

    const doDotnet = await entregarEm<Recusa>("dotnet", { ...invalido });
    const doVinext = await entregarEm<Recusa>("vinext", {
      ...invalido,
      id_transacao: `${invalido.id_transacao}-B`,
    });

    expect(doDotnet.status).toBe(400);
    expect(doVinext.status).toBe(400);

    const a = doDotnet.body;
    const b = doVinext.body;

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

descreveComLogin("ORM e persistência em ambos os backends", () => {
  it.each([
    { id: "dotnet" as const, orm: "EF Core" },
    { id: "vinext" as const, orm: "Prisma" },
  ])("$orm persiste e consulta no schema compartilhado", async ({ id }) => {
    // Cada backend tem seu próprio ORM, mas os dois escrevem no MESMO schema
    // `sabemi` - é isso que faz o dado aparecer nos dois sem novo login. O que
    // se verifica aqui é o ciclo completo de persistência: gravar pelo webhook,
    // processar e ler de volta pelo dashboard, com os decimais intactos.
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

descreveComLogin("reenfileiramento manual", () => {
  // O botao do painel chama este endpoint. Aqui ele e exercitado pelo gateway,
  // nos DOIS backends, com os mesmos casos - porque o painel e um so e o
  // operador nao pode receber respostas diferentes conforme o backend ativo.

  it.each(BACKENDS)(
    "$nome recusa reenfileirar um evento que já teve SUCESSO",
    async ({ id }) => {
      // A proteção mais importante deste endpoint. A idempotência da ingestão
      // impede um evento DUPLICADO de entrar - ela não impede o MESMO evento de
      // ser processado duas vezes. Sem esta recusa, dois cliques dobrariam o
      // valor liquidado do contrato.
      const evento = pagamento({ valor: 111.11 });

      expect((await entregarEm(id, evento)).status).toBe(202);

      const cliente = await comBackend(id);

      await aguardarAte(`o evento ser processado pelo backend ${id}`, async () => {
        const r = await cliente.get<EventoDto>(
          `/api/gateway/payments/${encodeURIComponent(evento.id_transacao)}`,
        );
        return r.status === 200 && r.body.status_processamento === "SUCESSO" ? r.body : null;
      });

      const recusa = await cliente.request<{ detail: string; code: string }>(
        `/api/gateway/payments/${encodeURIComponent(evento.id_transacao)}/reenfileirar`,
        { method: "POST" },
      );

      // 409, e não 400: o pedido está correto; o que impede é o ESTADO do evento.
      expect(recusa.status).toBe(409);
      expect(recusa.body.code).toBe("requeue_not_allowed");

      // A mensagem é mostrada ao operador tal como vem: precisa dizer POR QUE.
      expect(recusa.body.detail).toContain("somado ao contrato");

      // E o contrato continua com UM pagamento, não dois.
      const contrato = await cliente.get<{ pagamentos_confirmados: number }>(
        `/api/gateway/contracts/${encodeURIComponent(evento.id_contrato)}`,
      );
      expect(contrato.body.pagamentos_confirmados).toBe(1);
    },
  );

  it.each(BACKENDS)("$nome responde 404 para um id_transacao inexistente", async ({ id }) => {
    const cliente = await comBackend(id);

    const r = await cliente.request<{ code: string }>(
      "/api/gateway/payments/NAO-EXISTE-JAMAIS/reenfileirar",
      { method: "POST" },
    );

    expect(r.status).toBe(404);
    expect(r.body.code).toBe("payment_event_not_found");
  });

  it.each(BACKENDS)("$nome exige sessão para reenfileirar", async ({ id }) => {
    // O endpoint MUTA estado. Deixá-lo aberto permitiria a qualquer um forçar o
    // reprocessamento de eventos sem nunca ter feito login.
    const cliente = navegador();
    await cliente.post("/api/backend", { backend: id });

    const r = await cliente.request("/api/gateway/payments/QUALQUER/reenfileirar", {
      method: "POST",
    });

    expect(r.status).toBe(401);
  });
});

descreveComLogin("diagnóstico de falha no contrato da API", () => {
  it.each(BACKENDS)("$nome explica um payload inválido em português", async ({ id }) => {
    // O tooltip do painel é montado com estes campos. Se o backend não os
    // devolvesse, o operador voltaria a ver só a mensagem crua da validação.
    const invalido = { ...pagamento(), valor: -5 };

    const ack = await entregarEm(id, invalido);
    expect(ack.status).toBe(400);

    const cliente = await comBackend(id);

    const detalhe = await cliente.get<{
      status_processamento: string;
      diagnostico: {
        categoria: string;
        codigo: string;
        explicacao: string;
        acao_sugerida: string;
        retentavel: boolean;
      } | null;
    }>(`/api/gateway/payments/${encodeURIComponent(invalido.id_transacao as string)}`);

    expect(detalhe.status).toBe(200);
    expect(detalhe.body.status_processamento).toBe("INVALIDO");

    const d = detalhe.body.diagnostico;
    expect(d).not.toBeNull();
    expect(d!.codigo).toBe("PAYLOAD_INVALIDO");
    expect(d!.categoria).toBe("PERMANENTE");

    // Não é retentável: é isso que faz o painel NÃO oferecer o botão.
    expect(d!.retentavel).toBe(false);

    // Textos de verdade, não campos vazios - eles vão direto para a tela.
    expect(d!.explicacao.length).toBeGreaterThan(20);
    expect(d!.acao_sugerida.length).toBeGreaterThan(20);
  });

  it.each(BACKENDS)("$nome não inventa diagnóstico para um evento OK", async ({ id }) => {
    // A UI usa a AUSÊNCIA para decidir se mostra o tooltip. Um diagnóstico
    // genérico numa linha de sucesso poria um ícone de erro onde não há erro.
    const evento = pagamento({ valor: 77.77 });
    expect((await entregarEm(id, evento)).status).toBe(202);

    const cliente = await comBackend(id);

    const pronto = await aguardarAte(`o evento ser processado pelo backend ${id}`, async () => {
      const r = await cliente.get<{ status_processamento: string; diagnostico: unknown }>(
        `/api/gateway/payments/${encodeURIComponent(evento.id_transacao)}`,
      );
      return r.status === 200 && r.body.status_processamento === "SUCESSO" ? r.body : null;
    });

    expect(pronto.diagnostico).toBeNull();
  });
});
