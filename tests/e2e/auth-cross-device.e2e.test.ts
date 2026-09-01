import { describe, expect, it } from "vitest";

import {
  BACKENDS,
  Cliente,
  WEB_URL,
  aguardarAte,
  navegador,
} from "./support";

/**
 * Autenticacao por polling cross-device, ponta a ponta.
 *
 * <b>O cenario reproduzido.</b> O operador pede o acesso no desktop e abre o
 * link no celular. Sao dois CLIENTES HTTP distintos, com cookie jars separados -
 * e a unica forma honesta de provar "cross-device": se fosse o mesmo cliente, o
 * teste passaria mesmo que a aprovacao dependesse de estado local.
 *
 * <b>Por que isto nao e redundante com os testes de integracao.</b> Aqueles
 * exercitam cada backend isoladamente, em processo. Aqui a aprovacao atravessa
 * a rede, o gateway, o backend e o PostgreSQL, com o cookie de sessao sendo
 * gravado por um container e lido por outro. E onde um erro de fiacao aparece.
 */

/** Aba do desktop: pede o acesso e fica no polling. */
async function pedirAcesso(desktop: Cliente, email: string) {
  const resposta = await desktop.post<{
    selector: string;
    dev_magic_url: string;
    dev_otp_code: string;
  }>("/api/auth/login?step=start", { email });

  expect(resposta.status).toBe(200);
  expect(resposta.body.selector).toBeTruthy();
  expect(resposta.body.dev_magic_url).toBeTruthy();

  return resposta.body;
}

/** Um ciclo de polling, como a aba faz a cada 2,5s. */
function consultar(desktop: Cliente, selector: string) {
  return desktop.post<{
    status: string;
    authenticated: boolean;
    user?: { email: string };
  }>("/api/auth/login?step=poll", { selector });
}

describe("autenticação cross-device por polling", () => {
  it("o desktop entra sozinho depois que o celular abre o link", async () => {
    const desktop = navegador();
    const email = `cross-${Date.now()}@sabemi.com.br`;

    // ---- Passo 1: o desktop pede o acesso.
    const pedido = await pedirAcesso(desktop, email);

    // ---- Passo 2: o polling responde "pending" - ninguém confirmou ainda.
    const antes = await consultar(desktop, pedido.selector);
    expect(antes.status).toBe(200);
    expect(antes.body.status).toBe("pending");
    expect(antes.body.authenticated).toBe(false);
    expect(desktop.jar.tem("sabemi_session")).toBe(false);

    // ---- Passo 3: OUTRO dispositivo abre o link do e-mail.
    // Cliente novo, cookie jar próprio: não compartilha nada com o desktop.
    const celular = new Cliente("");
    const confirmacao = await celular.get(pedido.dev_magic_url);

    expect(confirmacao.status).toBe(200);
    expect(String(confirmacao.body)).toContain("Acesso confirmado");
    // O celular NÃO recebe sessão: quem entra é a aba que iniciou o login.
    expect(celular.jar.tem("sabemi_session")).toBe(false);

    // ---- Passo 4: o desktop descobre sozinho, no ciclo seguinte.
    const aprovado = await aguardarAte(
      "o polling do desktop detectar a aprovação",
      async () => {
        const r = await consultar(desktop, pedido.selector);
        return r.body.status === "approved" ? r : null;
      },
      { prazoMs: 20_000, intervaloMs: 500 },
    );

    expect(aprovado.body.authenticated).toBe(true);
    expect(aprovado.body.user?.email).toBe(email);

    // ---- Passo 5: a sessão veio em cookie, e o token não vazou no corpo.
    expect(desktop.jar.tem("sabemi_session")).toBe(true);
    expect(JSON.stringify(aprovado.body)).not.toContain("eyJ");

    // ---- Passo 6: o cookie dá acesso real ao dashboard.
    const dashboard = await desktop.get("/api/gateway/payments");
    expect(dashboard.status).toBe(200);
  });

  it("o pedido é de uso único: o polling seguinte encerra com 404", async () => {
    // É assim que o cliente sabe parar, em vez de girar até o prazo de 15 min.
    const desktop = navegador();
    const pedido = await pedirAcesso(desktop, `unico-${Date.now()}@sabemi.com.br`);

    await new Cliente("").get(pedido.dev_magic_url);

    const primeiro = await consultar(desktop, pedido.selector);
    expect(primeiro.body.status).toBe("approved");

    const segundo = await consultar(desktop, pedido.selector);
    expect(segundo.status).toBe(404);
  });

  it("o código OTP autentica na própria aba, sem abrir o link", async () => {
    const desktop = navegador();
    const email = `otp-${Date.now()}@sabemi.com.br`;
    const pedido = await pedirAcesso(desktop, email);

    const resposta = await desktop.post<{ authenticated: boolean; user?: { email: string } }>(
      "/api/auth/login?step=otp",
      { selector: pedido.selector, code: pedido.dev_otp_code },
    );

    expect(resposta.status).toBe(200);
    expect(resposta.body.authenticated).toBe(true);
    expect(resposta.body.user?.email).toBe(email);
    expect(desktop.jar.tem("sabemi_session")).toBe(true);

    // Também aqui o token fica fora do corpo.
    expect(JSON.stringify(resposta.body)).not.toContain("eyJ");
  });

  it("o código incorreto não autentica e não grava cookie", async () => {
    const desktop = navegador();
    const pedido = await pedirAcesso(desktop, `errado-${Date.now()}@sabemi.com.br`);

    const resposta = await desktop.post("/api/auth/login?step=otp", {
      selector: pedido.selector,
      code: "000000",
    });

    expect(resposta.status).toBe(400);
    expect(desktop.jar.tem("sabemi_session")).toBe(false);
  });

  it("a sessão sobrevive a um F5 e o logout a encerra", async () => {
    const desktop = navegador();
    const email = `sessao-${Date.now()}@sabemi.com.br`;
    const pedido = await pedirAcesso(desktop, email);

    await new Cliente("").get(pedido.dev_magic_url);
    await consultar(desktop, pedido.selector);

    // F5: o AuthProvider restaura a sessão a partir do cookie httpOnly.
    const restaurada = await desktop.get<{ user: { email: string } }>("/api/auth/session");
    expect(restaurada.status).toBe(200);
    expect(restaurada.body.user.email).toBe(email);

    // Logout.
    const saida = await desktop.request("/api/auth/session", { method: "DELETE" });
    expect(saida.status).toBe(200);
    expect(desktop.jar.tem("sabemi_session")).toBe(false);

    // E o acesso realmente acabou.
    const depois = await desktop.get("/api/gateway/payments");
    expect(depois.status).toBe(401);
  });

  it("um selector inventado nunca autentica", async () => {
    const invasor = navegador();

    const resposta = await consultar(invasor, "selector-que-nunca-existiu");

    expect(resposta.status).toBe(404);
    expect(invasor.jar.tem("sabemi_session")).toBe(false);
  });
});

/**
 * O mesmo fluxo, exercitado contra CADA backend.
 *
 * O corpo do teste e identico; so muda qual implementacao esta selecionada. E a
 * demonstracao mais direta de que a feature foi reproduzida nos dois, e nao
 * apenas no primario.
 */
describe.each(BACKENDS)("autenticação no backend $nome", (backend) => {
  it("completa o login cross-device", async () => {
    const desktop = navegador();

    // Seleciona o backend antes de entrar - é o que a tela de login permite.
    const troca = await desktop.post<{ active: string }>("/api/backend", {
      backend: backend.id,
    });
    expect(troca.body.active).toBe(backend.id);

    const email = `${backend.id}-${Date.now()}@sabemi.com.br`;
    const pedido = await pedirAcesso(desktop, email);

    // O link aponta para o backend selecionado.
    if (backend.id === "vinext") {
      expect(pedido.dev_magic_url).toContain("/api/bff/auth/confirm");
    } else {
      expect(pedido.dev_magic_url).toContain("/auth/confirm");
    }

    await new Cliente("").get(pedido.dev_magic_url);

    const aprovado = await consultar(desktop, pedido.selector);
    expect(aprovado.body.status).toBe("approved");
    expect(aprovado.body.user?.email).toBe(email);

    // A sessão emitida por este backend vale nas consultas dele.
    const dashboard = await desktop.get("/api/gateway/payments");
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("x-sabemi-backend")).toBe(backend.id);
  });
});

describe("o token de sessão nunca alcança o navegador", () => {
  it("nenhuma resposta do fluxo de login contém o JWT", async () => {
    // A propriedade central do padrão BFF adotado. Se o token aparecesse em
    // qualquer corpo, um XSS no painel poderia lê-lo com response.json().
    const desktop = navegador();
    const email = `xss-${Date.now()}@sabemi.com.br`;

    const corpos: string[] = [];

    const inicio = await desktop.post<{ selector: string; dev_magic_url: string }>(
      "/api/auth/login?step=start",
      { email },
    );
    corpos.push(JSON.stringify(inicio.body));

    await new Cliente("").get(inicio.body.dev_magic_url);

    const aprovado = await consultar(desktop, inicio.body.selector);
    corpos.push(JSON.stringify(aprovado.body));

    const sessao = await desktop.get("/api/auth/session");
    corpos.push(JSON.stringify(sessao.body));

    const dashboard = await desktop.get("/api/gateway/payments");
    corpos.push(JSON.stringify(dashboard.body));

    for (const corpo of corpos) {
      // Todo JWT HS256 começa com este prefixo ({"alg":"HS256" em base64url).
      expect(corpo).not.toContain("eyJhbGciOiJIUzI1NiI");
      expect(corpo).not.toContain("access_token");
    }

    // E o token existe de fato - está no cookie, fora do alcance do JavaScript.
    expect(desktop.jar.valor("sabemi_session")).toMatch(/^eyJ/);
  });
});
