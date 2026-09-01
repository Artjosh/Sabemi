import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  clearSession,
  getBackends,
  getContract,
  getHealth,
  getPaymentDetail,
  getPaymentSummary,
  getSession,
  listPayments,
  pollLogin,
  startLogin,
  switchBackend,
  verifyOtp,
} from "@/lib/api-client";

/**
 * Cliente de API usado pela interface.
 *
 * <b>O que estes testes protegem.</b> Duas propriedades que sustentam a troca de
 * backend e o padrao BFF:
 *
 *   1. TODA chamada vai para `/api/gateway/*` ou `/api/auth/*`, same-origin.
 *      Nenhuma URL de backend aparece aqui. Se alguem introduzir um
 *      `http://localhost:8080` no cliente, a troca deixa de funcionar - e um
 *      destes testes quebra.
 *   2. Toda falha vira um `ApiError` com o status preservado. E o que permite a
 *      UI ter um unico tratamento de erro e o polling distinguir "acabou" de
 *      "tente de novo".
 */

function stubFetch(resposta: Response | (() => Promise<Response>)) {
  const mock = vi.fn(typeof resposta === "function" ? resposta : async () => resposta);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("todas as chamadas são same-origin", () => {
  it.each([
    ["listPayments", () => listPayments()],
    ["getPaymentSummary", () => getPaymentSummary()],
    ["getPaymentDetail", () => getPaymentDetail("TRX-1")],
    ["getContract", () => getContract("CTR-1")],
    ["getHealth", () => getHealth()],
    ["getSession", () => getSession()],
    ["getBackends", () => getBackends()],
  ])("%s chama um caminho relativo", async (_nome, chamada) => {
    const fetchMock = stubFetch(json({}));

    await chamada();

    const url = fetchMock.mock.calls[0][0] as string;
    // Caminho relativo: nada de host, protocolo ou porta.
    expect(url.startsWith("/api/")).toBe(true);
    expect(url).not.toContain("http");
  });

  it("envia o cookie de sessão e nunca cacheia", async () => {
    const fetchMock = stubFetch(json({}));

    await listPayments();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    // O dashboard atualiza por polling: uma resposta cacheada mostraria dados
    // velhos.
    expect(init.cache).toBe("no-store");
  });
});

describe("montagem dos filtros", () => {
  it("sem filtros não acrescenta query string", async () => {
    const fetchMock = stubFetch(json({ items: [], page: 1, page_size: 20, total: 0 }));

    await listPayments();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/gateway/payments");
  });

  it("inclui apenas os filtros informados", async () => {
    const fetchMock = stubFetch(json({ items: [], page: 1, page_size: 20, total: 0 }));

    await listPayments({ status: "ERRO", contractId: "CTR-A", page: 2, pageSize: 50 });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("status=ERRO");
    expect(url).toContain("contractId=CTR-A");
    expect(url).toContain("page=2");
    expect(url).toContain("pageSize=50");
  });

  it("filtros nulos são omitidos, e não enviados como 'null'", async () => {
    const fetchMock = stubFetch(json({ items: [], page: 1, page_size: 20, total: 0 }));

    await listPayments({ status: null, contractId: null });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/gateway/payments");
  });

  it("escapa identificadores com caracteres especiais", async () => {
    // Um id com barra quebraria a rota se fosse concatenado cru.
    const fetchMock = stubFetch(json({}));

    await getPaymentDetail("TRX/001 #2");

    expect(fetchMock.mock.calls[0][0]).toContain("TRX%2F001%20%232");
  });

  it("escapa o id do contrato", async () => {
    const fetchMock = stubFetch(json({}));

    await getContract("CTR/A&B");

    expect(fetchMock.mock.calls[0][0]).toContain("CTR%2FA%26B");
  });
});

describe("tratamento de erros", () => {
  it("converte a resposta de erro em ApiError com o status preservado", async () => {
    stubFetch(json({ detail: "Sessao ausente ou expirada.", code: "unauthorized" }, 401));

    const erro = await listPayments().catch((e) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.status).toBe(401);
    expect(erro.message).toBe("Sessao ausente ou expirada.");
    expect(erro.code).toBe("unauthorized");
  });

  it("preserva os erros por campo da validação", async () => {
    stubFetch(
      json(
        {
          detail: "Payload invalido.",
          code: "validation_failed",
          errors: { valor: ["deve ser maior que zero"] },
        },
        400,
      ),
    );

    const erro = await listPayments().catch((e) => e);

    expect(erro.errors).toEqual({ valor: ["deve ser maior que zero"] });
  });

  it("uma falha de rede também vira ApiError, com status 0", async () => {
    // Assim a UI tem um único caminho de tratamento, em vez de precisar
    // distinguir exceções de fetch de respostas de erro.
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const erro = await listPayments().catch((e) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.status).toBe(0);
    expect(erro.code).toBe("network_error");
  });

  it("isGone distingue 'acabou' de 'tente de novo'", () => {
    // É o que o polling usa para decidir entre parar e insistir.
    expect(new ApiError("x", 404).isGone).toBe(true);
    expect(new ApiError("x", 410).isGone).toBe(true);

    expect(new ApiError("x", 0).isGone).toBe(false);
    expect(new ApiError("x", 500).isGone).toBe(false);
    expect(new ApiError("x", 401).isGone).toBe(false);
  });

  it("tolera corpo de erro que não é JSON", async () => {
    stubFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const erro = await listPayments().catch((e) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.status).toBe(502);
    expect(erro.message).toBeTruthy();
  });

  it("tolera 204 sem corpo", async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(clearSession()).resolves.toBeUndefined();
  });
});

describe("endpoints de autenticação", () => {
  it("startLogin envia o e-mail para o step correto", async () => {
    const fetchMock = stubFetch(json({ selector: "s-1" }));

    await startLogin("a@b.com");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/login?step=start");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.com" });
  });

  it("pollLogin envia o selector para o step de polling", async () => {
    const fetchMock = stubFetch(json({ status: "pending", authenticated: false }));

    await pollLogin("sel-1");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/login?step=poll");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      selector: "sel-1",
    });
  });

  it("verifyOtp envia selector e código", async () => {
    const fetchMock = stubFetch(json({ authenticated: true }));

    await verifyOtp("sel-1", "123456");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/login?step=otp");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      selector: "sel-1",
      code: "123456",
    });
  });

  it("clearSession usa DELETE", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await clearSession();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/session");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});

describe("troca de backend", () => {
  it("switchBackend envia o backend escolhido", async () => {
    const fetchMock = stubFetch(
      json({ active: "vinext", previous: "dotnet", session_cleared: true }),
    );

    const resultado = await switchBackend("vinext");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/backend");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      backend: "vinext",
    });
    expect(resultado.session_cleared).toBe(true);
  });

  it("getHealth passa pelo gateway, e não direto no backend", async () => {
    // É o que faz o indicador refletir quem REALMENTE respondeu, e não quem o
    // cliente supõe estar ativo.
    const fetchMock = stubFetch(json({ status: "healthy", backend: "vinext" }));

    const saude = await getHealth();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/gateway/health");
    expect(saude.backend).toBe("vinext");
  });
});
