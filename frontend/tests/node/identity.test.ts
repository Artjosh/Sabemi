/**
 * Provedor de identidade do backend VINEXT.
 *
 * <b>Espelho de `SupabaseIdentityProviderTests.cs`.</b> Os dois backends
 * compartilham a tabela de pedidos de login, então precisam concordar sobre o
 * que aprova um pedido - e os mesmos cenários rodam nos dois lados.
 *
 * <b>O que se verifica.</b> O contrato com o GoTrue (endpoints, o `redirect_to`
 * carregando o selector, o header do gateway) e as três decisões que separam
 * este modo de uma integração ingênua:
 *
 *   1. uma falha do GoTrue ainda produz um pedido gravável, porque o selector já
 *      foi entregue ao cliente e um pedido ausente daria "seu acesso expirou";
 *   2. indisponibilidade NÃO é código inválido - senão uma queda de dois segundos
 *      consumiria o orçamento de tentativas do usuário;
 *   3. o token é validado CONTRA o GoTrue, e não localmente, para recusar token
 *      revogado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_SUPABASE = {
  AUTH_PROVIDER: "supabase",
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_ANON_KEY: "chave-anon",
  BFF_PUBLIC_BASE_URL: "http://localhost:3000",
  AUTH_MAGIC_LINK_TTL_MINUTES: "15",
};

/** Recarrega o módulo com o ambiente que o teste quiser. */
async function comAmbiente(env: Record<string, string>) {
  vi.resetModules();
  for (const [chave, valor] of Object.entries(env)) vi.stubEnv(chave, valor);
  return await import("@/server/bff/identity/supabase");
}

/**
 * Responde por CAMINHO, para um teste cobrir mais de uma chamada.
 *
 * Devolve o espião, para as asserções sobre o que foi enviado.
 */
function stubFetchPorCaminho(
  rotas: Record<string, { status: number; corpo?: unknown }>,
  explodirCom?: Error,
) {
  const espiao = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    if (explodirCom) throw explodirCom;

    const caminho = new URL(String(url)).pathname;
    const rota = rotas[caminho];

    if (!rota) {
      return new Response(JSON.stringify({ msg: "caminho não configurado" }), {
        status: 404,
      });
    }

    return new Response(JSON.stringify(rota.corpo ?? {}), { status: rota.status });
  });

  vi.stubGlobal("fetch", espiao);
  return espiao;
}

/** Corpo JSON da n-ésima chamada. */
function corpoDa(espiao: ReturnType<typeof vi.fn>, indice = 0) {
  const init = espiao.mock.calls[indice]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

const ROTAS_OK = {
  "/auth/v1/otp": { status: 200 },
  "/auth/v1/verify": { status: 200 },
  "/auth/v1/user": { status: 200, corpo: { email: "operador@sabemi.com.br" } },
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("desafio delegado ao GoTrue", () => {
  it("leva o selector, pede para criar o usuário e não guarda segredo algum", async () => {
    // Cinco aspectos do MESMO pedido de desafio, em um caso só. Separá-los em
    // cinco testes repetia a montagem sem cobrir ramo novo. Espelha
    // `SupabaseIdentityProviderTests.O_desafio_delegado_ao_GoTrue_...`.
    const espiao = stubFetchPorCaminho(ROTAS_OK);
    const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

    const r = await provedorSupabase.iniciarDesafio("novo@sabemi.com.br", "SEL-ABC");

    expect(r.emailEnviado).toBe(true);
    expect(String(espiao.mock.calls[0]?.[0])).toContain("/auth/v1/otp");

    // A peça que faz o cross-device funcionar. Sem o selector no `redirect_to`,
    // o clique no celular autenticaria apenas o celular - que é o comportamento
    // padrão do GoTrue e justamente o que não serve aqui.
    const url = decodeURIComponent(String(espiao.mock.calls[0]?.[0]));
    expect(url).toContain("selector=SEL-ABC");
    expect(url).toContain("/auth/supabase/confirm");

    // Não há tela de cadastro neste sistema: o primeiro acesso com um e-mail
    // cria a conta, igual ao modo local. Com `create_user: false`, um e-mail novo
    // receberia erro em vez de um convite.
    expect(corpoDa(espiao)).toMatchObject({
      email: "novo@sabemi.com.br",
      create_user: true,
    });

    // `apikey`, e não `Authorization`. Sem ele o Kong recusa antes de chegar ao
    // GoTrue, com um erro que não menciona o header que faltou.
    const headers = (espiao.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.apikey).toBe("chave-anon");

    // A diferença estrutural entre os dois modos: aqui quem guarda e valida os
    // segredos é o GoTrue. Um hash nosso na linha seria um segredo que ninguém
    // usa - e daria a impressão de que o pedido pode ser validado localmente.
    expect(r.magicTokenHash).toBeNull();
    expect(r.otpCodeHash).toBeNull();
    expect(r.magicUrl).toBeNull();
    expect(r.otpCode).toBeNull();
  });

  it("um GoTrue que falha não impede o pedido de existir", async () => {
    // Parece contraintuitivo, e é deliberado: o selector já vai para o cliente,
    // que já começa a pollar. Um pedido ausente daria 404 e a tela diria "seu
    // acesso expirou" - quando o que houve foi falha de envio.
    //
    // Recusa HTTP e erro de rede são caminhos diferentes com o MESMO contrato.
    stubFetchPorCaminho({ "/auth/v1/otp": { status: 400, corpo: { msg: "erro" } } });
    const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

    const recusado = await provedorSupabase.iniciarDesafio("a@b.c", "SEL-1");
    expect(recusado.emailEnviado).toBe(false);
    expect(recusado.magicTokenHash).toBeNull();

    stubFetchPorCaminho({}, new Error("ECONNREFUSED"));
    const { provedorSupabase: outro } = await comAmbiente(CONFIG_SUPABASE);

    await expect(outro.iniciarDesafio("a@b.c", "SEL-1")).resolves.toMatchObject({
      emailEnviado: false,
    });
  });
});

describe("verificação do código", () => {
  it("um código aceito pelo GoTrue é válido", async () => {
    stubFetchPorCaminho(ROTAS_OK);
    const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

    expect(await provedorSupabase.verificarOtp("a@b.c", null, "123456")).toBe("valido");
  });

  it("verifica com o tipo `email`, e não `magiclink`", async () => {
    // `email` é o tipo do OTP de acesso. `magiclink` valida o token longo do
    // link, que não é o que o usuário digita - e o GoTrue devolveria 400 sem
    // dizer que o tipo estava errado.
    const espiao = stubFetchPorCaminho(ROTAS_OK);
    const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

    await provedorSupabase.verificarOtp("a@b.c", null, " 123456 ");

    expect(corpoDa(espiao)).toMatchObject({ type: "email", token: "123456" });
  });

  it.each([400, 401])("o GoTrue dizendo não (%i) é código INVÁLIDO", async (status) => {
    stubFetchPorCaminho({ "/auth/v1/verify": { status } });
    const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

    expect(await provedorSupabase.verificarOtp("a@b.c", null, "000000")).toBe("invalido");
  });

  it.each([500, 503])(
    "o GoTrue QUEBRADO (%i) é INDISPONÍVEL, e não código errado",
    async (status) => {
      // A distinção que protege o usuário: indisponibilidade não consome o
      // orçamento de tentativas, e a tela diz "tente de novo em instantes" em vez
      // de "código incorreto".
      stubFetchPorCaminho({ "/auth/v1/verify": { status } });
      const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

      expect(await provedorSupabase.verificarOtp("a@b.c", null, "123456")).toBe(
        "indisponivel",
      );
    },
  );

  it("um erro de rede na verificação é INDISPONÍVEL", async () => {
    stubFetchPorCaminho({}, new Error("timeout"));
    const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

    expect(await provedorSupabase.verificarOtp("a@b.c", null, "123456")).toBe(
      "indisponivel",
    );
  });
});

describe("validação do token de acesso", () => {
  it("um token válido devolve o e-mail do dono, normalizado", async () => {
    const espiao = stubFetchPorCaminho(ROTAS_OK);
    const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

    const email = await provedorSupabase.verificarTokenDeAcesso("jwt-valido");

    expect(email).toBe("operador@sabemi.com.br");

    // Pergunta ao GoTrue em vez de validar a assinatura localmente: validar local
    // aceitaria um token JÁ REVOGADO, e um logout no GoTrue continuaria
    // autenticando por todo o tempo de vida do JWT.
    expect(String(espiao.mock.calls[0]?.[0])).toContain("/auth/v1/user");

    const headers = (espiao.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer jwt-valido");

    // Normalização: o e-mail é a chave da sessão, e "Operador@Sabemi.COM.BR"
    // precisa dar a MESMA sessão que "operador@sabemi.com.br".
    stubFetchPorCaminho({
      "/auth/v1/user": { status: 200, corpo: { email: "  Operador@Sabemi.COM.BR " } },
    });
    const { provedorSupabase: comCaixa } = await comAmbiente(CONFIG_SUPABASE);

    expect(await comCaixa.verificarTokenDeAcesso("jwt")).toBe("operador@sabemi.com.br");
  });

  it("nada além de um token válido com e-mail concede acesso", async () => {
    // Quatro maneiras de não ter um dono confiável, um contrato só: devolver
    // null, que o chamador traduz em 401. Não há caminho de "talvez" aqui - na
    // dúvida, o acesso é negado.
    const cenarios: [string, Record<string, { status: number; corpo?: unknown }>, Error?][] = [
      // Token recusado pelo GoTrue.
      ["jwt-invalido", { "/auth/v1/user": { status: 401 } }],

      // É por e-mail que este sistema identifica o operador; sem ele não há como
      // comparar com o pedido.
      ["jwt", { "/auth/v1/user": { status: 200, corpo: { id: "abc" } } }],

      // Rede caída.
      ["jwt", {}, new Error("rede")],
    ];

    for (const [token, rotas, erro] of cenarios) {
      stubFetchPorCaminho(rotas, erro);
      const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

      expect(await provedorSupabase.verificarTokenDeAcesso(token)).toBeNull();
    }

    // Token vazio nem chega a virar chamada: um "" enviado ao GoTrue voltaria 401
    // e poluiria o log com um erro que não é erro.
    const espiao = stubFetchPorCaminho(ROTAS_OK);
    const { provedorSupabase } = await comAmbiente(CONFIG_SUPABASE);

    expect(await provedorSupabase.verificarTokenDeAcesso("")).toBeNull();
    expect(espiao).not.toHaveBeenCalled();
  });
});

describe("escolha do provedor", () => {
  /** O índice resolve o provedor na carga do módulo. */
  async function escolher(env: Record<string, string>) {
    vi.resetModules();
    for (const [chave, valor] of Object.entries(env)) vi.stubEnv(chave, valor);
    return await import("@/server/bff/identity");
  }

  it("o padrão é o modo local", async () => {
    const { identityProvider } = await escolher({ AUTH_PROVIDER: "" });

    expect(identityProvider.kind).toBe("LOCAL");
  });

  it("`supabase` com chaves escolhe o GoTrue", async () => {
    const { identityProvider } = await escolher(CONFIG_SUPABASE);

    expect(identityProvider.kind).toBe("SUPABASE");
  });

  it("`supabase` SEM chaves falha na carga, e não no primeiro login", async () => {
    // Cair para o modo local em silêncio seria pior: quem pediu Supabase acharia
    // que está usando Supabase, e o comportamento observável é quase igual - até
    // o dia em que alguém procura o usuário no painel do Supabase e não o
    // encontra.
    await expect(
      escolher({ AUTH_PROVIDER: "supabase", SUPABASE_URL: "", SUPABASE_ANON_KEY: "" }),
    ).rejects.toThrow(/SUPABASE_URL/);
  });

  it("um valor desconhecido cai no local, sem quebrar", async () => {
    // Um typo em `AUTH_PROVIDER` não deve impedir a stack de subir: o modo local
    // funciona sozinho, e o log da inicialização diz qual provedor está ativo.
    const { identityProvider } = await escolher({ AUTH_PROVIDER: "gotrue" });

    expect(identityProvider.kind).toBe("LOCAL");
  });
});

describe("provedor local", () => {
  it("gera hash dos DOIS segredos", async () => {
    // Um vazamento do banco não pode entregar logins ativos.
    vi.resetModules();
    vi.stubEnv("BREVO_API_KEY", "");

    const { provedorLocal } = await import("@/server/bff/identity/local");
    const r = await provedorLocal.iniciarDesafio("a@b.c", "SEL-1");

    // SHA-256 em hex: 64 caracteres. O mesmo formato do backend .NET - é o que
    // faz um pedido criado por um deles ser validável pelo outro.
    expect(r.magicTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.otpCodeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("devolve link e código, ao contrário do modo Supabase", async () => {
    vi.resetModules();
    vi.stubEnv("BREVO_API_KEY", "");

    const { provedorLocal } = await import("@/server/bff/identity/local");
    const r = await provedorLocal.iniciarDesafio("a@b.c", "SEL-1");

    expect(r.magicUrl).toContain("/api/bff/auth/confirm?token=");
    expect(r.otpCode).toMatch(/^\d{6}$/);
  });

  it("sem chave da Brevo, não afirma que enviou", async () => {
    // `email_sent` decide o que a tela diz. Uma promessa errada aqui manda o
    // usuário procurar um e-mail que nunca vai chegar.
    vi.resetModules();
    vi.stubEnv("BREVO_API_KEY", "");

    const { provedorLocal } = await import("@/server/bff/identity/local");

    expect((await provedorLocal.iniciarDesafio("a@b.c", "SEL-1")).emailEnviado).toBe(
      false,
    );
  });

  it("valida o OTP contra o hash gravado", async () => {
    vi.resetModules();
    vi.stubEnv("BREVO_API_KEY", "");

    const { provedorLocal } = await import("@/server/bff/identity/local");
    const { sha256 } = await import("@/server/bff/crypto");

    const hash = sha256("123456");

    expect(await provedorLocal.verificarOtp("a@b.c", hash, "123456")).toBe("valido");
    expect(await provedorLocal.verificarOtp("a@b.c", hash, "654321")).toBe("invalido");
  });

  it("um pedido SEM hash é inválido, e não um erro", async () => {
    // Acontece se o provedor for trocado com pedidos em voo: o pedido nasceu no
    // modo Supabase e o local assumiu. O usuário recebe "código incorreto" e pede
    // um acesso novo - que já sairá pelo provedor certo.
    vi.resetModules();
    const { provedorLocal } = await import("@/server/bff/identity/local");

    expect(await provedorLocal.verificarOtp("a@b.c", null, "123456")).toBe("invalido");
  });

  it("não valida token externo: aqui não existe um", async () => {
    vi.resetModules();
    const { provedorLocal } = await import("@/server/bff/identity/local");

    expect(await provedorLocal.verificarTokenDeAcesso("qualquer-jwt")).toBeNull();
  });
});
