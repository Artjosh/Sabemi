/**
 * Regra de exposicao do link e do codigo de acesso.
 *
 * `bffConfig` e um objeto congelado, avaliado uma unica vez na importacao do
 * modulo. Para exercitar ambientes diferentes cada caso precisa reimportar o
 * modulo com o ambiente ja trocado - dai `vi.resetModules()` antes de cada
 * `import()` dinamico.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Reimporta a configuracao com o ambiente informado. */
async function configCom(env: Record<string, string | undefined>) {
  vi.resetModules();

  for (const [chave, valor] of Object.entries(env)) {
    if (valor === undefined) vi.stubEnv(chave, "");
    else vi.stubEnv(chave, valor);
  }

  const { bffConfig } = await import("@/server/bff/config");
  return bffConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("exposicao do link e do OTP no corpo da resposta", () => {
  it("em producao, o padrao e NAO expor", async () => {
    // Falha fechada: sem configuracao explicita, um deploy nunca entrega o
    // codigo de acesso na resposta. Ninguem precisa decidir nada para isso.
    const config = await configCom({
      NODE_ENV: "production",
      AUTH_EXPOSE_LOGIN_CODES: undefined,
    });

    expect(config.isProduction).toBe(true);
    expect(config.auth.exposeLoginCodes).toBe(false);
  });

  it("fora de producao, o padrao e expor", async () => {
    // O outro lado do mesmo padrao: a demonstracao roda sem provedor de e-mail.
    const config = await configCom({
      NODE_ENV: "development",
      AUTH_EXPOSE_LOGIN_CODES: undefined,
    });

    expect(config.auth.exposeLoginCodes).toBe(true);
  });

  it("uma escolha explicita vence o ambiente nos dois sentidos", async () => {
    // A saida existe porque travar em `!isProduction` deixava uma imagem de
    // producao sem provedor de e-mail SEM NENHUM caminho de login: o usuario
    // pedia acesso, recebia `null` e nao havia como entrar. E o inverso tambem
    // precisa valer, para desligar a exposicao numa maquina de desenvolvimento
    // que ja tenha e-mail configurado.
    const ligadoEmProducao = await configCom({
      NODE_ENV: "production",
      AUTH_EXPOSE_LOGIN_CODES: "true",
    });
    expect(ligadoEmProducao.auth.exposeLoginCodes).toBe(true);

    const desligadoEmDesenvolvimento = await configCom({
      NODE_ENV: "development",
      AUTH_EXPOSE_LOGIN_CODES: "false",
    });
    expect(desligadoEmDesenvolvimento.auth.exposeLoginCodes).toBe(false);
  });

  it("ligar em producao registra um aviso na inicializacao", async () => {
    // Expor o codigo em producao e legitimo para uma demonstracao, mas nao pode
    // passar despercebido se essa configuracao for promovida a um ambiente
    // real. O aviso e a unica coisa que separa uma escolha consciente de um
    // acidente.
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await configCom({ NODE_ENV: "production", AUTH_EXPOSE_LOGIN_CODES: "true" });

      expect(aviso).toHaveBeenCalledOnce();
      expect(aviso.mock.calls[0]?.[0]).toContain("AUTH_EXPOSE_LOGIN_CODES=true em producao");
    } finally {
      aviso.mockRestore();
    }
  });

  it("o caminho padrao de producao nao gera aviso", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await configCom({ NODE_ENV: "production", AUTH_EXPOSE_LOGIN_CODES: undefined });

      expect(aviso).not.toHaveBeenCalled();
    } finally {
      aviso.mockRestore();
    }
  });
});
