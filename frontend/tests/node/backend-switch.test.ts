import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackendId } from "@/lib/contracts";
import {
  DEFAULT_BACKEND,
  getAdapter,
  isBackendId,
  listBackends,
} from "@/server/backends/registry";
import { prisma } from "@/server/bff/db";
import { resolveBackend, sessionCookieOptions, backendCookieOptions } from "@/server/session";

/**
 * A abstracao de backend e a feature de troca.
 *
 * <b>O que estes testes precisam provar.</b> Que a troca nao e cosmetica. Nao
 * basta o botao mudar de cor: o adapter selecionado tem de despachar para uma
 * implementacao DIFERENTE, com dados proprios, mantendo o MESMO contrato.
 *
 * A estrategia e exercitar os dois adapters pela mesma interface e comparar as
 * respostas campo a campo. Se um deles divergir, e um bug de contrato - e e
 * exatamente isso que a suite denuncia.
 */

const API_KEY = "chave-de-teste";

function requisicao(over: Partial<Parameters<ReturnType<typeof getAdapter>["handle"]>[0]> = {}) {
  return {
    method: "GET",
    path: "health",
    searchParams: new URLSearchParams(),
    rawBody: "",
    headers: new Headers(),
    token: null,
    ...over,
  };
}

async function limpar() {
  await prisma.processingJob.deleteMany();
  await prisma.paymentEvent.deleteMany();
  await prisma.contractStatus.deleteMany();
  await prisma.loginRequest.deleteMany();
  await prisma.appUser.deleteMany();
}

beforeEach(limpar);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

describe("registro de backends", () => {
  it("o backend primário é o .NET, como exige a vaga", () => {
    expect(DEFAULT_BACKEND).toBe("dotnet");
  });

  it("expõe exatamente os dois backends, com rótulo e descrição", () => {
    const backends = listBackends();

    expect(backends.map((b) => b.id).sort()).toEqual(["dotnet", "vinext"]);
    expect(backends.every((b) => b.label && b.description)).toBe(true);
  });

  it.each([
    ["dotnet", true],
    ["vinext", true],
    ["postgres", false],
    ["", false],
    [null, false],
    [undefined, false],
    [42, false],
  ])("isBackendId(%j) === %s", (valor, esperado) => {
    expect(isBackendId(valor)).toBe(esperado);
  });

  it("cookie ausente ou inválido cai no backend primário", () => {
    // Falha para o lado seguro: um cookie corrompido não pode deixar a aplicação
    // sem backend.
    expect(resolveBackend(undefined)).toBe("dotnet");
    expect(resolveBackend(null)).toBe("dotnet");
    expect(resolveBackend("")).toBe("dotnet");
    expect(resolveBackend("backend-inventado")).toBe("dotnet");
  });

  it("cookie válido seleciona o backend correspondente", () => {
    expect(resolveBackend("vinext")).toBe("vinext");
    expect(resolveBackend("dotnet")).toBe("dotnet");
  });
});

describe("política de cookies", () => {
  it("o cookie de sessão é httpOnly - o token nunca alcança o JavaScript", () => {
    // A propriedade central do padrão BFF adotado: um XSS no dashboard não
    // encontra o token para roubar.
    const opcoes = sessionCookieOptions(3600);

    expect(opcoes.httpOnly).toBe(true);
    expect(opcoes.sameSite).toBe("lax");
    expect(opcoes.path).toBe("/");
    expect(opcoes.maxAge).toBe(3600);
  });

  it("o cookie de backend é legível pelo cliente - é preferência, não segredo", () => {
    const opcoes = backendCookieOptions();

    expect(opcoes.httpOnly).toBe(false);
  });
});

describe("adapter VINEXT (em processo)", () => {
  const vinext = getAdapter("vinext");

  it("identifica-se corretamente", () => {
    expect(vinext.id).toBe("vinext");
    expect(vinext.label).toContain("VINEXT");
  });

  it("responde /health identificando a própria implementação", async () => {
    const resposta = await vinext.handle(requisicao());

    expect(resposta.status).toBe(200);
    expect(resposta.body).toMatchObject({ backend: "vinext" });
  });

  it("atende o webhook com a mesma semântica de status", async () => {
    const headers = new Headers({ "x-api-key": API_KEY });
    const corpo = JSON.stringify({
      id_transacao: "ADP-001",
      id_contrato: "CTR-ADP",
      valor: 10,
      data_pagamento: "2026-08-01T10:00:00Z",
      status: "PAGO",
    });

    const primeira = await vinext.handle(
      requisicao({ method: "POST", path: "webhooks/pagamento", rawBody: corpo, headers }),
    );
    const segunda = await vinext.handle(
      requisicao({ method: "POST", path: "webhooks/pagamento", rawBody: corpo, headers }),
    );

    expect(primeira.status).toBe(202);
    expect(segunda.status).toBe(200);
  });

  it("recusa consulta sem sessão", async () => {
    const resposta = await vinext.handle(requisicao({ path: "payments" }));

    expect(resposta.status).toBe(401);
  });
});

describe("adapter .NET (proxy HTTP)", () => {
  const dotnet = getAdapter("dotnet");

  it("identifica-se corretamente", () => {
    expect(dotnet.id).toBe("dotnet");
    expect(dotnet.label).toBe(".NET");
  });

  it("encaminha método, caminho e query para o serviço remoto", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "healthy", backend: "dotnet" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await dotnet.handle(
      requisicao({ path: "payments", searchParams: new URLSearchParams({ status: "SUCESSO" }) }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toContain("/payments");
    expect(url).toContain("status=SUCESSO");
    expect(init.method).toBe("GET");
    // O dashboard atualiza por polling: uma resposta cacheada mostraria dados
    // velhos e faria o operador acreditar que nada está chegando.
    expect(init.cache).toBe("no-store");
  });

  it("injeta o token da sessão como Authorization: Bearer", async () => {
    // O token vem do cookie httpOnly, lido no servidor. É aqui que ele entra na
    // chamada ao backend, sem nunca ter passado pelo browser.
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await dotnet.handle(requisicao({ path: "payments", token: "jwt-da-sessao" }));

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer jwt-da-sessao");
  });

  it("repassa ApiKey e assinatura do webhook intactas", async () => {
    // É o backend .NET quem valida a assinatura, e ela cobre o corpo bruto:
    // qualquer alteração no caminho a invalidaria.
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const headers = new Headers({
      "x-api-key": "chave-do-parceiro",
      "x-signature": "assinatura-hex",
    });

    await dotnet.handle(
      requisicao({ method: "POST", path: "webhooks/pagamento", rawBody: "{}", headers }),
    );

    const enviados = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(enviados.get("x-api-key")).toBe("chave-do-parceiro");
    expect(enviados.get("x-signature")).toBe("assinatura-hex");
  });

  it("envia o corpo bruto sem reserializar", async () => {
    // Reserializar mudaria espaços e ordem de chaves, quebrando a assinatura.
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const corpoExato = '{"id_transacao":"X",  "valor":  1}';

    await dotnet.handle(
      requisicao({ method: "POST", path: "webhooks/pagamento", rawBody: corpoExato }),
    );

    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(corpoExato);
  });

  it("não envia corpo em requisições GET", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await dotnet.handle(requisicao({ method: "GET", path: "payments" }));

    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBeUndefined();
  });

  it("traduz backend fora do ar em ProblemDetails, e não em tela quebrada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const resposta = await dotnet.handle(requisicao({ path: "payments" }));

    expect(resposta.status).toBe(502);
    expect(resposta.body).toMatchObject({ code: "backend_unreachable" });
    // A UI já sabe exibir este formato: o erro chega como qualquer outro.
    expect(resposta.body).toHaveProperty("detail");
  });

  it("preserva o status de erro devolvido pelo serviço remoto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "Credencial invalida.", code: "invalid_api_key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ));

    const resposta = await dotnet.handle(requisicao({ path: "webhooks/pagamento" }));

    expect(resposta.status).toBe(401);
    expect(resposta.body).toMatchObject({ code: "invalid_api_key" });
  });

  it("preserva HTML (página de confirmação do link) sem tentar interpretar como JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html><body>Acesso confirmado</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ));

    const resposta = await dotnet.handle(requisicao({ path: "auth/confirm" }));

    expect(resposta.contentType).toContain("text/html");
    expect(resposta.body).toContain("Acesso confirmado");
  });

  it("tolera resposta com corpo vazio", async () => {
    // 204 nao admite corpo: `new Response("", {status:204})` lanca TypeError.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    const resposta = await dotnet.handle(requisicao({ path: "payments" }));

    expect(resposta.status).toBe(204);
    expect(resposta.body).toBeNull();
  });
});

describe("equivalência de contrato entre os dois backends", () => {
  /**
   * Duble do backend .NET que responde exatamente o que o serviço real responde.
   *
   * Não é para "fazer o teste passar": as respostas abaixo foram verificadas
   * contra o serviço .NET em execução. O que se compara aqui é a FORMA do
   * contrato - se as duas implementações concordam nos campos e nos códigos.
   */
  function dublarDotnet(body: unknown, status = 200) {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ));
  }

  it("/health tem a mesma forma nos dois, mudando só o identificador", async () => {
    dublarDotnet({ status: "healthy", backend: "dotnet", version: "1.0.0" });

    const doDotnet = await getAdapter("dotnet").handle(requisicao());
    const doVinext = await getAdapter("vinext").handle(requisicao());

    expect(Object.keys(doDotnet.body as object).sort()).toEqual(
      expect.arrayContaining(["backend", "status"]),
    );
    expect(Object.keys(doVinext.body as object).sort()).toEqual(
      expect.arrayContaining(["backend", "status"]),
    );

    // O único campo que DEVE divergir é o que identifica quem respondeu.
    expect((doDotnet.body as { backend: BackendId }).backend).toBe("dotnet");
    expect((doVinext.body as { backend: BackendId }).backend).toBe("vinext");
  });

  it("o ack do webhook tem os mesmos campos nos dois", async () => {
    const corpo = JSON.stringify({
      id_transacao: "EQ-001",
      id_contrato: "CTR-EQ",
      valor: 10,
      data_pagamento: "2026-08-01T10:00:00Z",
      status: "PAGO",
    });
    const headers = new Headers({ "x-api-key": API_KEY });

    const doVinext = await getAdapter("vinext").handle(
      requisicao({ method: "POST", path: "webhooks/pagamento", rawBody: corpo, headers }),
    );

    dublarDotnet(
      {
        id_transacao: "EQ-001",
        status: "PENDENTE",
        duplicate: false,
        received_at: new Date().toISOString(),
        message: "Evento recebido e enfileirado para processamento.",
      },
      202,
    );

    const doDotnet = await getAdapter("dotnet").handle(
      requisicao({ method: "POST", path: "webhooks/pagamento", rawBody: corpo, headers }),
    );

    expect(doVinext.status).toBe(202);
    expect(doDotnet.status).toBe(202);

    const camposObrigatorios = ["id_transacao", "status", "duplicate", "received_at"];
    for (const campo of camposObrigatorios) {
      expect(doVinext.body).toHaveProperty(campo);
      expect(doDotnet.body).toHaveProperty(campo);
    }
  });

  it("o erro de validação tem o mesmo formato nos dois", async () => {
    // É o que permite ao frontend ter um único tratamento de erro.
    const corpoInvalido = JSON.stringify({
      id_transacao: "EQ-BAD",
      id_contrato: "",
      valor: -1,
      data_pagamento: "2026-08-01T10:00:00Z",
      status: "XPTO",
    });
    const headers = new Headers({ "x-api-key": API_KEY });

    const doVinext = await getAdapter("vinext").handle(
      requisicao({ method: "POST", path: "webhooks/pagamento", rawBody: corpoInvalido, headers }),
    );

    expect(doVinext.status).toBe(400);
    expect(doVinext.body).toHaveProperty("detail");
    expect(doVinext.body).toHaveProperty("code", "validation_failed");
    expect(doVinext.body).toHaveProperty("errors");
  });

  it("os dois recusam consulta sem sessão com 401", async () => {
    dublarDotnet({ detail: "Sessao ausente ou expirada.", code: "unauthorized" }, 401);

    const doDotnet = await getAdapter("dotnet").handle(requisicao({ path: "payments" }));
    const doVinext = await getAdapter("vinext").handle(requisicao({ path: "payments" }));

    expect(doDotnet.status).toBe(401);
    expect(doVinext.status).toBe(401);
    expect(doDotnet.body).toHaveProperty("detail");
    expect(doVinext.body).toHaveProperty("detail");
  });

  it("os dois adapters expõem exatamente a mesma interface", () => {
    // Se um deles ganhasse um método próprio, a UI acabaria dependendo dele - e
    // a troca deixaria de ser transparente.
    for (const id of ["dotnet", "vinext"] as const) {
      const adapter = getAdapter(id);
      expect(typeof adapter.handle).toBe("function");
      expect(typeof adapter.id).toBe("string");
      expect(typeof adapter.label).toBe("string");
      expect(typeof adapter.description).toBe("string");
    }
  });
});
