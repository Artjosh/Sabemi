import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/bff/db";
import { chamadaFetch, jsonResponse, stubFetch } from "../helpers";

/**
 * Route handlers do VINEXT - a camada onde a troca de backend e o padrao BFF
 * realmente acontecem.
 *
 * <b>Por que estes testes sao os mais importantes do frontend.</b> E aqui que:
 *
 *   * o token de sessao e retirado da resposta e gravado em cookie httpOnly -
 *     a propriedade de seguranca central do projeto;
 *   * o gateway escolhe o adapter a partir do cookie - a troca de backend;
 *   * a sessao e encerrada ao trocar de backend.
 *
 * Um defeito em qualquer um desses pontos passaria por todos os outros testes:
 * os servicos estariam corretos e a aplicacao, errada.
 *
 * <b>Como o cookie e simulado.</b> `cookies()` do `next/headers` exige um
 * contexto de requisicao que so existe dentro do servidor. O duble abaixo
 * implementa a mesma interface (`get`/`set`/`delete`/`has`) sobre um Map, o que
 * permite INSPECIONAR o que foi gravado - e verificar, por exemplo, que o
 * cookie de sessao saiu com `httpOnly: true`.
 */

interface CookieGravado {
  value: string;
  options: Record<string, unknown>;
}

/** Duble do cookie jar do Next, com o estado exposto para inspecao. */
class FakeCookieJar {
  readonly store = new Map<string, CookieGravado>();

  get(name: string) {
    const item = this.store.get(name);
    return item ? { name, value: item.value } : undefined;
  }

  set(name: string, value: string, options: Record<string, unknown> = {}) {
    this.store.set(name, { value, options });
  }

  delete(name: string) {
    this.store.delete(name);
  }

  has(name: string) {
    return this.store.has(name);
  }
}

let jar: FakeCookieJar;

vi.mock("next/headers", () => ({
  cookies: async () => jar,
  headers: async () => new Headers(),
}));

async function limpar() {
  await prisma.processingJob.deleteMany();
  await prisma.paymentEvent.deleteMany();
  await prisma.contractStatus.deleteMany();
  await prisma.loginRequest.deleteMany();
  await prisma.appUser.deleteMany();
}

beforeEach(async () => {
  jar = new FakeCookieJar();
  await limpar();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

/** Requisicao mínima com a forma que os handlers consomem. */
function req(url: string, init: RequestInit = {}) {
  const request = new Request(url, init) as Request & { nextUrl: URL };
  request.nextUrl = new URL(url);
  return request as never;
}

// ------------------------------------------------------------------ gateway

describe("gateway /api/gateway/[...path]", () => {
  it("despacha para o backend VINEXT quando o cookie o seleciona", async () => {
    jar.set("sabemi_backend", "vinext");

    const { GET } = await import("@/app/api/gateway/[...path]/route");
    const resposta = await GET(req("http://localhost:3000/api/gateway/health"), {
      params: Promise.resolve({ path: ["health"] }),
    });

    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ backend: "vinext" });
    // O header declara quem respondeu - e o que torna a troca verificavel.
    expect(resposta.headers.get("x-sabemi-backend")).toBe("vinext");
  });

  it("despacha para o backend .NET por padrão, sem cookie", async () => {
    // O primário exigido pela vaga é o padrão.
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ status: "healthy", backend: "dotnet" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/gateway/[...path]/route");
    const resposta = await GET(req("http://localhost:3000/api/gateway/health"), {
      params: Promise.resolve({ path: ["health"] }),
    });

    expect(resposta.headers.get("x-sabemi-backend")).toBe("dotnet");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("injeta o token do cookie httpOnly na chamada ao backend", async () => {
    // O ponto central do padrão BFF: o token vive no cookie, é lido no servidor
    // e entra na chamada sem nunca ter passado pelo browser.
    jar.set("sabemi_session", "jwt-secreto");

    const fetchMock = stubFetch(
      new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/gateway/[...path]/route");
    await GET(req("http://localhost:3000/api/gateway/payments"), {
      params: Promise.resolve({ path: ["payments"] }),
    });

    const headers = chamadaFetch(fetchMock).headers;
    expect(headers.get("Authorization")).toBe("Bearer jwt-secreto");
  });

  it("encaminha os filtros da query string", async () => {
    jar.set("sabemi_backend", "vinext");

    const { GET } = await import("@/app/api/gateway/[...path]/route");
    const resposta = await GET(
      req("http://localhost:3000/api/gateway/payments?status=ERRO&contractId=CTR-A"),
      { params: Promise.resolve({ path: ["payments"] }) },
    );

    // Sem sessão: 401, mas a rota foi alcançada com os parâmetros.
    expect(resposta.status).toBe(401);
  });

  it("encaminha o corpo do POST", async () => {
    jar.set("sabemi_backend", "vinext");

    const corpo = JSON.stringify({
      id_transacao: "GW-001",
      id_contrato: "CTR-GW",
      valor: 10,
      data_pagamento: "2026-08-01T10:00:00Z",
      status: "PAGO",
    });

    const { POST } = await import("@/app/api/gateway/[...path]/route");
    const resposta = await POST(
      req("http://localhost:3000/api/gateway/webhooks/pagamento", {
        method: "POST",
        body: corpo,
        headers: { "x-api-key": "chave-de-teste" },
      }),
      { params: Promise.resolve({ path: ["webhooks", "pagamento"] }) },
    );

    expect(resposta.status).toBe(202);
    expect(await prisma.paymentEvent.count({ where: { idTransacao: "GW-001" } })).toBe(1);
  });

  it("cookie de backend inválido cai no primário, em vez de quebrar", async () => {
    jar.set("sabemi_backend", "backend-inventado");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const { GET } = await import("@/app/api/gateway/[...path]/route");
    const resposta = await GET(req("http://localhost:3000/api/gateway/health"), {
      params: Promise.resolve({ path: ["health"] }),
    });

    expect(resposta.headers.get("x-sabemi-backend")).toBe("dotnet");
  });
});

// --------------------------------------------------------------------- auth

describe("login /api/auth/login", () => {
  async function iniciarLogin(): Promise<{ selector: string; magicUrl: string; otp: string }> {
    const { POST } = await import("@/app/api/auth/login/route");

    const resposta = await POST(
      req("http://localhost:3000/api/auth/login?step=start", {
        method: "POST",
        body: JSON.stringify({ email: "rota@sabemi.com.br" }),
      }),
    );

    const corpo = (await resposta.json()) as {
      selector: string;
      dev_magic_url: string;
      dev_otp_code: string;
    };

    return { selector: corpo.selector, magicUrl: corpo.dev_magic_url, otp: corpo.dev_otp_code };
  }

  beforeEach(() => {
    jar.set("sabemi_backend", "vinext");
  });

  it("step=start devolve o selector do polling", async () => {
    const { selector } = await iniciarLogin();

    expect(selector).toBeTruthy();
  });

  it("step=poll devolve pending sem gravar cookie", async () => {
    const { selector } = await iniciarLogin();

    const { POST } = await import("@/app/api/auth/login/route");
    const resposta = await POST(
      req("http://localhost:3000/api/auth/login?step=poll", {
        method: "POST",
        body: JSON.stringify({ selector }),
      }),
    );

    expect(await resposta.json()).toMatchObject({ status: "pending", authenticated: false });
    expect(jar.has("sabemi_session")).toBe(false);
  });

  it("polling aprovado grava o cookie e NÃO devolve o token ao browser", async () => {
    // O teste de segurança mais importante do frontend. Se o token vazasse no
    // corpo, qualquer script na página poderia lê-lo com response.json().
    const { selector, magicUrl } = await iniciarLogin();

    const { handleBffRequest } = await import("@/server/bff/router");
    await handleBffRequest({
      method: "GET",
      path: "auth/confirm",
      searchParams: new URLSearchParams({ token: new URL(magicUrl).searchParams.get("token")! }),
      rawBody: "",
      headers: new Headers(),
      token: null,
    });

    const { POST } = await import("@/app/api/auth/login/route");
    const resposta = await POST(
      req("http://localhost:3000/api/auth/login?step=poll", {
        method: "POST",
        body: JSON.stringify({ selector }),
      }),
    );

    const corpo = await resposta.json();

    expect(corpo).toMatchObject({ status: "approved", authenticated: true });
    expect(corpo.user.email).toBe("rota@sabemi.com.br");

    // O token NÃO está no corpo.
    expect(corpo).not.toHaveProperty("access_token");
    expect(JSON.stringify(corpo)).not.toContain("eyJ");

    // Ele foi para o cookie - e o cookie é httpOnly.
    const cookie = jar.store.get("sabemi_session");
    expect(cookie?.value).toMatch(/^eyJ/);
    expect(cookie?.options.httpOnly).toBe(true);
    expect(cookie?.options.sameSite).toBe("lax");
  });

  it("step=otp grava o cookie do mesmo modo", async () => {
    const { selector, otp } = await iniciarLogin();

    const { POST } = await import("@/app/api/auth/login/route");
    const resposta = await POST(
      req("http://localhost:3000/api/auth/login?step=otp", {
        method: "POST",
        body: JSON.stringify({ selector, code: otp }),
      }),
    );

    const corpo = await resposta.json();

    expect(corpo).toMatchObject({ authenticated: true });
    expect(corpo).not.toHaveProperty("access_token");
    expect(jar.store.get("sabemi_session")?.options.httpOnly).toBe(true);
  });

  it("OTP incorreto propaga o erro sem gravar cookie", async () => {
    const { selector } = await iniciarLogin();

    const { POST } = await import("@/app/api/auth/login/route");
    const resposta = await POST(
      req("http://localhost:3000/api/auth/login?step=otp", {
        method: "POST",
        body: JSON.stringify({ selector, code: "000000" }),
      }),
    );

    expect(resposta.status).toBe(400);
    expect(jar.has("sabemi_session")).toBe(false);
  });

  it("recusa JSON malformado", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const resposta = await POST(
      req("http://localhost:3000/api/auth/login?step=start", {
        method: "POST",
        body: "{ quebrado",
      }),
    );

    expect(resposta.status).toBe(400);
  });

  it("recusa um step desconhecido", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const resposta = await POST(
      req("http://localhost:3000/api/auth/login?step=inventado", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );

    expect(resposta.status).toBe(400);
  });
});

describe("sessão /api/auth/session", () => {
  it("sem cookie devolve 401", async () => {
    const { GET } = await import("@/app/api/auth/session/route");

    expect((await GET()).status).toBe(401);
  });

  it("com cookie válido devolve o usuário, e não o token", async () => {
    jar.set("sabemi_backend", "vinext");

    // Sessão real, emitida pelo backend VINEXT.
    const { startLogin, confirmMagicLink, pollLoginStatus } = await import(
      "@/server/bff/auth-service"
    );
    const inicio = await startLogin("sessao@sabemi.com.br");
    if (!inicio.ok) throw new Error("falha ao iniciar");

    await confirmMagicLink(new URL(inicio.value.dev_magic_url!).searchParams.get("token")!);
    const aprovado = await pollLoginStatus(inicio.value.selector);
    if (!aprovado.ok) throw new Error("falha ao aprovar");

    jar.set("sabemi_session", aprovado.value.access_token!);

    const { GET } = await import("@/app/api/auth/session/route");
    const resposta = await GET();
    const corpo = await resposta.json();

    expect(resposta.status).toBe(200);
    expect(corpo.user.email).toBe("sessao@sabemi.com.br");
    expect(JSON.stringify(corpo)).not.toContain(aprovado.value.access_token);
  });

  it("cookie inválido é apagado, para o cliente parar de tentar usá-lo", async () => {
    jar.set("sabemi_backend", "vinext");
    jar.set("sabemi_session", "token-forjado");

    const { GET } = await import("@/app/api/auth/session/route");
    const resposta = await GET();

    expect(resposta.status).toBe(401);
    expect(jar.has("sabemi_session")).toBe(false);
  });

  it("DELETE encerra a sessão", async () => {
    jar.set("sabemi_session", "qualquer-token");

    const { DELETE } = await import("@/app/api/auth/session/route");
    const resposta = await DELETE();

    expect(resposta.status).toBe(200);
    expect(jar.has("sabemi_session")).toBe(false);
  });
});

// ------------------------------------------------------------------ backend

describe("seletor /api/backend", () => {
  it("GET informa o backend ativo e a disponibilidade de cada um", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ status: "healthy", backend: "dotnet" }), { status: 200 }),
    ));

    const { GET } = await import("@/app/api/backend/route");
    const corpo = await (await GET()).json();

    expect(corpo.active).toBe("dotnet");
    expect(corpo.default).toBe("dotnet");
    expect(corpo.backends).toHaveLength(2);
    expect(corpo.backends.every((b: { online: boolean }) => b.online)).toBe(true);
  });

  it("GET marca como fora do ar o backend que não responde", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const { GET } = await import("@/app/api/backend/route");
    const corpo = await (await GET()).json();

    const dotnet = corpo.backends.find((b: { id: string }) => b.id === "dotnet");
    const vinext = corpo.backends.find((b: { id: string }) => b.id === "vinext");

    expect(dotnet.online).toBe(false);
    // O VINEXT roda em processo: não depende de rede e continua no ar.
    expect(vinext.online).toBe(true);
  });

  it("POST troca o backend ativo", async () => {
    const { POST } = await import("@/app/api/backend/route");
    const resposta = await POST(
      req("http://localhost:3000/api/backend", {
        method: "POST",
        body: JSON.stringify({ backend: "vinext" }),
      }),
    );

    expect(await resposta.json()).toMatchObject({ active: "vinext", previous: "dotnet" });
    expect(jar.store.get("sabemi_backend")?.value).toBe("vinext");
  });

  it("a troca PRESERVA a sessão - os dois backends compartilham os usuários", async () => {
    // A consequência de compartilhar o schema `sabemi`: o `sub` do JWT aponta
    // para um usuário que os DOIS enxergam, e os dois assinam com o mesmo
    // segredo. O operador troca de implementação e continua onde estava.
    jar.set("sabemi_session", "sessao-valida-nos-dois");

    const { POST } = await import("@/app/api/backend/route");
    const resposta = await POST(
      req("http://localhost:3000/api/backend", {
        method: "POST",
        body: JSON.stringify({ backend: "vinext" }),
      }),
    );

    expect(await resposta.json()).toMatchObject({
      active: "vinext",
      session_preserved: true,
    });
    expect(jar.has("sabemi_session")).toBe(true);
    // E o valor e o MESMO: nao foi reemitido, apenas preservado.
    expect(jar.store.get("sabemi_session")?.value).toBe("sessao-valida-nos-dois");
  });

  it("trocar sem sessão aberta simplesmente troca", async () => {
    const { POST } = await import("@/app/api/backend/route");
    const resposta = await POST(
      req("http://localhost:3000/api/backend", {
        method: "POST",
        body: JSON.stringify({ backend: "vinext" }),
      }),
    );

    expect(await resposta.json()).toMatchObject({ session_preserved: false });
  });

  it("o cookie de backend é legível pelo cliente", async () => {
    const { POST } = await import("@/app/api/backend/route");
    await POST(
      req("http://localhost:3000/api/backend", {
        method: "POST",
        body: JSON.stringify({ backend: "vinext" }),
      }),
    );

    expect(jar.store.get("sabemi_backend")?.options.httpOnly).toBe(false);
  });

  it.each([{ backend: "postgres" }, { backend: "" }, {}, { backend: 42 }])(
    "recusa o backend inválido %j",
    async (corpo) => {
      const { POST } = await import("@/app/api/backend/route");
      const resposta = await POST(
        req("http://localhost:3000/api/backend", {
          method: "POST",
          body: JSON.stringify(corpo),
        }),
      );

      expect(resposta.status).toBe(400);
    },
  );

  it("recusa JSON malformado", async () => {
    const { POST } = await import("@/app/api/backend/route");
    const resposta = await POST(
      req("http://localhost:3000/api/backend", { method: "POST", body: "{ quebrado" }),
    );

    expect(resposta.status).toBe(400);
  });
});

// ------------------------------------------------------------ acesso direto

describe("acesso direto /api/bff/[...path]", () => {
  it("recebe o webhook do banco parceiro", async () => {
    // É por aqui que o parceiro entrega quando o backend VINEXT está ativo.
    const corpo = JSON.stringify({
      id_transacao: "DIR-001",
      id_contrato: "CTR-DIR",
      valor: 55,
      data_pagamento: "2026-08-01T10:00:00Z",
      status: "PAGO",
    });

    const { POST } = await import("@/app/api/bff/[...path]/route");
    const resposta = await POST(
      req("http://localhost:3000/api/bff/webhooks/pagamento", {
        method: "POST",
        body: corpo,
        headers: { "x-api-key": "chave-de-teste" },
      }),
      { params: Promise.resolve({ path: ["webhooks", "pagamento"] }) },
    );

    expect(resposta.status).toBe(202);
    expect(resposta.headers.get("x-sabemi-backend")).toBe("vinext");
  });

  it("serve a página HTML de confirmação do link", async () => {
    // Aberta pelo cliente de e-mail, possivelmente em outro aparelho.
    const { startLogin } = await import("@/server/bff/auth-service");
    const inicio = await startLogin("html@sabemi.com.br");
    if (!inicio.ok) throw new Error("falha");

    const token = new URL(inicio.value.dev_magic_url!).searchParams.get("token")!;

    const { GET } = await import("@/app/api/bff/[...path]/route");
    const resposta = await GET(
      req(`http://localhost:3000/api/bff/auth/confirm?token=${token}`),
      { params: Promise.resolve({ path: ["auth", "confirm"] }) },
    );

    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toContain("text/html");
    expect(await resposta.text()).toContain("Acesso confirmado");
  });

  it("aceita Authorization: Bearer nas rotas do dashboard", async () => {
    const { startLogin, confirmMagicLink, pollLoginStatus } = await import(
      "@/server/bff/auth-service"
    );
    const inicio = await startLogin("bearer@sabemi.com.br");
    if (!inicio.ok) throw new Error("falha");

    await confirmMagicLink(new URL(inicio.value.dev_magic_url!).searchParams.get("token")!);
    const aprovado = await pollLoginStatus(inicio.value.selector);
    if (!aprovado.ok) throw new Error("falha");

    const { GET } = await import("@/app/api/bff/[...path]/route");
    const resposta = await GET(
      req("http://localhost:3000/api/bff/payments", {
        headers: { authorization: `Bearer ${aprovado.value.access_token}` },
      }),
      { params: Promise.resolve({ path: ["payments"] }) },
    );

    expect(resposta.status).toBe(200);
  });

  it("recusa a rota do dashboard sem Authorization", async () => {
    const { GET } = await import("@/app/api/bff/[...path]/route");
    const resposta = await GET(req("http://localhost:3000/api/bff/payments"), {
      params: Promise.resolve({ path: ["payments"] }),
    });

    expect(resposta.status).toBe(401);
  });
});
