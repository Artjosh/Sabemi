import { describe, expect, it } from "vitest";

import {
  API_KEY,
  BACKENDS,
  aguardarAte,
  comBackend,
  pagamento,
  parceiro,
} from "./support";

/**
 * O caminho completo de uma notificacao, contra a stack em execucao.
 *
 * Da entrega do banco parceiro ate o contrato consolidado, atravessando rede,
 * fila em PostgreSQL e - do lado .NET - um worker em OUTRO CONTAINER.
 *
 * <b>O que so este nivel prova.</b> Que o trabalho enfileirado por um processo
 * e concluido por outro. Os testes de integracao chamam o ciclo de
 * processamento diretamente; aqui ninguem chama nada - o worker acorda sozinho,
 * reivindica o item e fecha. Se a fiacao entre os containers estivesse errada
 * (variavel com nome trocado, serviço apontando para localhost), tudo o mais
 * passaria e este teste ficaria esperando ate o prazo.
 */

interface Ack {
  id_transacao: string;
  status: string;
  duplicate: boolean;
  received_at: string;
}

interface EventoDto {
  id_transacao: string;
  id_contrato: string | null;
  valor: number | null;
  status_processamento: string;
  erro: string | null;
  tentativas: number;
  payload_bruto?: string;
}

interface ContratoDto {
  id_contrato: string;
  valor_total_liquidado: number;
  pagamentos_confirmados: number;
  situacao: string;
}

/**
 * Sessao no backend indicado.
 *
 * Reaproveitada entre os testes deste arquivo: o objeto aqui e o pipeline do
 * webhook, nao o login, e refazer a autenticacao a cada verificacao so
 * consumiria o rate limit sem provar nada de novo.
 */
const comSessao = comBackend;

describe.each(BACKENDS)("pipeline do webhook — backend $nome", (backend) => {
  const banco = parceiro(backend.base);

  const entregar = (corpo: unknown, apiKey: string | null = API_KEY) =>
    banco.request<Ack>(`${backend.prefixo}/webhooks/pagamento`, {
      method: "POST",
      json: corpo,
      headers: apiKey ? { "X-Api-Key": apiKey } : {},
    });

  it("recebe, enfileira, processa em background e consolida o contrato", async () => {
    const evento = pagamento({ valor: 1234.56 });

    // ---- O banco parceiro entrega. A resposta é imediata.
    const inicio = performance.now();
    const ack = await entregar(evento);
    const decorrido = performance.now() - inicio;

    expect(ack.status).toBe(202);
    expect(ack.body.duplicate).toBe(false);
    expect(ack.body.status).toBe("PENDENTE");

    // A regra leva ~2s e roda em background: a resposta não pode pagá-la.
    expect(decorrido).toBeLessThan(1500);

    // ---- O processamento acontece depois, sem ninguém pedir.
    const sessao = await comSessao(backend.id);

    const processado = await aguardarAte(
      `o evento ${evento.id_transacao} ser processado`,
      async () => {
        const r = await sessao.get<EventoDto>(
          `/api/gateway/payments/${encodeURIComponent(evento.id_transacao)}`,
        );
        return r.status === 200 && r.body.status_processamento === "SUCESSO" ? r.body : null;
      },
    );

    expect(processado.tentativas).toBeGreaterThanOrEqual(1);
    expect(processado.valor).toBe(1234.56);

    // ---- O payload bruto foi preservado: a trilha de auditoria é real.
    expect(processado.payload_bruto).toBeTruthy();
    const bruto = JSON.parse(processado.payload_bruto!);
    expect(bruto.id_transacao).toBe(evento.id_transacao);

    // ---- E o efeito colateral aconteceu: o contrato foi consolidado.
    const contrato = await sessao.get<ContratoDto>(
      `/api/gateway/contracts/${encodeURIComponent(evento.id_contrato)}`,
    );

    expect(contrato.status).toBe(200);
    expect(contrato.body.valor_total_liquidado).toBe(1234.56);
    expect(contrato.body.pagamentos_confirmados).toBe(1);
    expect(contrato.body.situacao).toBe("LIQUIDADO");
  });

  it("soma vários pagamentos do mesmo contrato sem perder nenhum", async () => {
    const idContrato = `CTR-SOMA-${backend.id}-${Date.now()}`;
    const valores = [100.0, 250.5, 49.5];

    for (const valor of valores) {
      const r = await entregar(pagamento({ id_contrato: idContrato, valor }));
      expect(r.status).toBe(202);
    }

    const sessao = await comSessao(backend.id);

    const contrato = await aguardarAte(
      `o contrato ${idContrato} receber os 3 pagamentos`,
      async () => {
        const r = await sessao.get<ContratoDto>(
          `/api/gateway/contracts/${encodeURIComponent(idContrato)}`,
        );
        return r.status === 200 && r.body.pagamentos_confirmados === 3 ? r.body : null;
      },
    );

    // A soma exata é a prova de que nada foi contado duas vezes nem perdido.
    expect(contrato.valor_total_liquidado).toBe(400.0);
  });

  it("reentregas simultâneas do mesmo id_transacao produzem UM evento", async () => {
    // O requisito central da task, contra o banco real e pela rede.
    const evento = pagamento({ valor: 77.0 });

    const respostas = await Promise.all(
      Array.from({ length: 15 }, () => entregar(evento)),
    );

    expect(respostas.filter((r) => r.status === 202)).toHaveLength(1);
    expect(respostas.filter((r) => r.status === 200)).toHaveLength(14);
    expect(respostas.filter((r) => r.status === 200).every((r) => r.body.duplicate)).toBe(true);

    // E o contrato recebeu o valor UMA vez.
    const sessao = await comSessao(backend.id);

    const contrato = await aguardarAte(
      "o contrato ser consolidado",
      async () => {
        const r = await sessao.get<ContratoDto>(
          `/api/gateway/contracts/${encodeURIComponent(evento.id_contrato)}`,
        );
        return r.status === 200 && r.body.pagamentos_confirmados > 0 ? r.body : null;
      },
    );

    expect(contrato.valor_total_liquidado).toBe(77.0);
    expect(contrato.pagamentos_confirmados).toBe(1);
  });

  it("um pagamento cancelado não soma ao total liquidado", async () => {
    const evento = pagamento({ valor: 999.0, status: "CANCELADO" });

    expect((await entregar(evento)).status).toBe(202);

    const sessao = await comSessao(backend.id);

    const contrato = await aguardarAte(
      "o contrato cancelado ser consolidado",
      async () => {
        const r = await sessao.get<ContratoDto>(
          `/api/gateway/contracts/${encodeURIComponent(evento.id_contrato)}`,
        );
        return r.status === 200 ? r.body : null;
      },
    );

    expect(contrato.valor_total_liquidado).toBe(0);
    expect(contrato.situacao).toBe("INADIMPLENTE");
  });

  it("um payload inválido é recusado com 400 e MESMO ASSIM fica auditável", async () => {
    // O requisito de visualização de erros: o evento reprovado precisa aparecer
    // no dashboard, e não sumir.
    const invalido = pagamento({ id_contrato: "", valor: -1, status: "XPTO" });

    const resposta = await entregar(invalido);

    expect(resposta.status).toBe(400);

    const sessao = await comSessao(backend.id);

    const registrado = await sessao.get<EventoDto>(
      `/api/gateway/payments/${encodeURIComponent(invalido.id_transacao)}`,
    );

    expect(registrado.status).toBe(200);
    expect(registrado.body.status_processamento).toBe("INVALIDO");
    expect(registrado.body.erro).toBeTruthy();

    // O filtro por INVALIDO o encontra.
    const filtrados = await sessao.get<{ items: EventoDto[] }>(
      "/api/gateway/payments?status=INVALIDO&pageSize=100",
    );
    expect(
      filtrados.body.items.some((e) => e.id_transacao === invalido.id_transacao),
    ).toBe(true);
  });

  it("recusa a entrega sem credencial", async () => {
    const resposta = await entregar(pagamento(), null);

    expect(resposta.status).toBe(401);
  });

  it("recusa a entrega com credencial errada", async () => {
    const resposta = await entregar(pagamento(), "chave-de-atacante");

    expect(resposta.status).toBe(401);
  });
});

describe("filtros do dashboard sobre dados reais", () => {
  it("filtra por status e por contrato, e os dois combinados", async () => {
    const sessao = await comSessao("dotnet");
    const banco = parceiro();
    const idContrato = `CTR-FILTRO-${Date.now()}`;

    const entregar = (corpo: unknown) =>
      banco.request<Ack>("/webhooks/pagamento", {
        method: "POST",
        json: corpo,
        headers: { "X-Api-Key": API_KEY },
      });

    // Dois válidos e um inválido, todos no mesmo contrato.
    await entregar(pagamento({ id_contrato: idContrato, valor: 10 }));
    await entregar(pagamento({ id_contrato: idContrato, valor: 20 }));
    const ruim = pagamento({ id_contrato: idContrato, valor: -5, status: "XPTO" });
    await entregar(ruim);

    await aguardarAte(
      "os dois pagamentos válidos serem processados",
      async () => {
        const r = await sessao.get<{ items: EventoDto[]; total: number }>(
          `/api/gateway/payments?contractId=${encodeURIComponent(idContrato)}&status=SUCESSO&pageSize=100`,
        );
        return r.body.total === 2 ? r.body : null;
      },
    );

    // Filtro por contrato: os três (dois válidos + um inválido).
    const porContrato = await sessao.get<{ total: number }>(
      `/api/gateway/payments?contractId=${encodeURIComponent(idContrato)}&pageSize=100`,
    );
    expect(porContrato.body.total).toBe(3);

    // Filtros combinados.
    const combinado = await sessao.get<{ total: number; items: EventoDto[] }>(
      `/api/gateway/payments?contractId=${encodeURIComponent(idContrato)}&status=INVALIDO&pageSize=100`,
    );
    expect(combinado.body.total).toBe(1);
    expect(combinado.body.items[0].id_transacao).toBe(ruim.id_transacao);

    // O resumo traz todas as chaves de situação.
    const resumo = await sessao.get<{ total: number; por_status: Record<string, number> }>(
      "/api/gateway/payments/summary",
    );
    expect(Object.keys(resumo.body.por_status).sort()).toEqual([
      "DUPLICADO",
      "ERRO",
      "INVALIDO",
      "PENDENTE",
      "PROCESSANDO",
      "SUCESSO",
    ]);
  });

  it("um contrato inexistente devolve 404", async () => {
    const sessao = await comSessao("dotnet");

    const resposta = await sessao.get("/api/gateway/contracts/CTR-QUE-NAO-EXISTE");

    expect(resposta.status).toBe(404);
  });
});
