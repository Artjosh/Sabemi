/**
 * Envio do e-mail de acesso pela Brevo, no backend VINEXT.
 *
 * <b>O que se verifica.</b> O contrato com a Brevo (endpoint, header de
 * autenticação, forma do corpo) e, principalmente, a garantia de que <b>uma falha
 * de e-mail nunca derruba o login</b>: ela vira `false`, o pedido de acesso
 * continua válido no banco e o link segue no log.
 *
 * O último bloco é o mais importante: a PARIDADE com
 * `Sabemi.Application/Auth/LoginEmail.cs`. Os dois backends devem produzir o
 * mesmo e-mail, e o gêmeo em C# não roda nesta suíte - então a comparação é
 * feita contra o arquivo dele.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASSUNTO, montarEmailDeAcesso } from "@/server/bff/login-email";

import { chamadaFetch, jsonResponse, stubFetch } from "../helpers";

/** Recarrega o módulo com a configuração da Brevo que o teste quiser. */
async function comConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [chave, valor] of Object.entries(env)) vi.stubEnv(chave, valor);
  return await import("@/server/bff/brevo");
}

const CONFIG_PADRAO = {
  BREVO_API_KEY: "chave-de-teste",
  BREVO_SENDER_EMAIL: "nao-responda@sabemi.com.br",
  BREVO_SENDER_NAME: "Sabemi",
  BREVO_BASE_URL: "https://api.brevo.test",
  AUTH_MAGIC_LINK_TTL_MINUTES: "15",
};

/** Duble de `fetch` que falha, para os casos de erro de rede e timeout. */
function stubFetchQueFalha(erro: Error) {
  return stubFetch(() => Promise.reject(erro));
}

function respostaOk() {
  return jsonResponse({ messageId: "<abc@brevo>" }, 201);
}

/** Corpo JSON da chamada capturada. */
function corpoEnviado(espiao: ReturnType<typeof stubFetch>) {
  return JSON.parse(String(chamadaFetch(espiao).init.body));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("envio pela Brevo", () => {
  it("um domínio reservado não gera nem a CHAMADA", async () => {
    // O ponto do teste é o espião não ter sido chamado: não basta a Brevo
    // recusar depois, a requisição não pode sair. Uma tentativa de entrega em
    // domínio reservado é um hard bounce garantido, e bounce corrói a
    // entregabilidade de tudo o mais que a conta envia.
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    const enviou = await enviarEmailDeAcesso(
      "e2e-vinext-123@e2e.invalid",
      "https://app/x",
      "123456",
    );

    expect(enviou).toBe(false);
    expect(espiao).not.toHaveBeenCalled();
  });

  it("chama o endpoint transacional da v3", async () => {
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    const enviou = await enviarEmailDeAcesso("a@b.c", "https://app/x", "123456");

    expect(enviou).toBe(true);
    const { url, init } = chamadaFetch(espiao);
    expect(url).toBe("https://api.brevo.test/v3/smtp/email");
    expect(init.method).toBe("POST");
  });

  it("autentica com o header `api-key`", async () => {
    // A Brevo usa `api-key`, e não `Authorization: Bearer`. Errar isto devolve
    // 401 com uma mensagem que não diz qual header ela esperava.
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await enviarEmailDeAcesso("a@b.c", "https://app/x", "123456");

    expect(chamadaFetch(espiao).headers.get("api-key")).toBe("chave-de-teste");
  });

  it("o corpo tem a forma que a Brevo espera", async () => {
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await enviarEmailDeAcesso("destino@sabemi.com.br", "https://app/c?token=abc", "654321");

    const corpo = corpoEnviado(espiao);

    expect(corpo.sender).toEqual({
      email: "nao-responda@sabemi.com.br",
      name: "Sabemi",
    });

    // `to` é uma LISTA, mesmo com um destinatário só - a Brevo recusa objeto.
    expect(corpo.to).toEqual([{ email: "destino@sabemi.com.br" }]);
    expect(corpo.subject).toBe(ASSUNTO);
    expect(corpo.htmlContent).toBeTruthy();
    expect(corpo.textContent).toBeTruthy();
  });

  it("o link e o código chegam nos DOIS corpos", async () => {
    // O texto alternativo não é decoração: alguns clientes corporativos bloqueiam
    // HTML por política, e um código que não chega é um usuário que não entra.
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await enviarEmailDeAcesso("a@b.c", "https://app/c?token=TOKEN123", "987654");

    const corpo = corpoEnviado(espiao);

    expect(corpo.htmlContent).toContain("TOKEN123");
    expect(corpo.htmlContent).toContain("987654");
    expect(corpo.textContent).toContain("TOKEN123");
    expect(corpo.textContent).toContain("987654");
  });

  it("o texto leva o link SEM escape de HTML", async () => {
    // Uma URL com `&amp;` no corpo em texto quebra ao ser colada no navegador.
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await enviarEmailDeAcesso("a@b.c", "https://app/c?token=t&extra=1", "111111");

    expect(corpoEnviado(espiao).textContent).toContain("token=t&extra=1");
  });

  it("pede para não receber resposta automática", async () => {
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await enviarEmailDeAcesso("a@b.c", "https://app/x", "222222");

    expect(corpoEnviado(espiao).headers["Auto-Submitted"]).toBe("auto-generated");
  });

  it("tem timeout: o `fetch` do Node não tem um por padrão", async () => {
    // Sem isto, uma Brevo lenta seguraria a resposta do login por minutos -
    // indistinguível de uma página travada para quem está na tela.
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await enviarEmailDeAcesso("a@b.c", "https://app/x", "333333");

    expect(chamadaFetch(espiao).init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("falhas não derrubam o login", () => {
  it.each([400, 401, 429, 500])("HTTP %i devolve false sem lançar", async (status) => {
    // A garantia central. Uma falha de e-mail NÃO pode virar 500 no endpoint de
    // login: ela vira `false`, e a tela mostra o link em vez de mandar o usuário
    // procurar um e-mail que nunca vai chegar.
    stubFetch(jsonResponse({ message: "erro" }, status));
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await expect(enviarEmailDeAcesso("a@b.c", "https://app/x", "444444")).resolves.toBe(
      false,
    );
  });

  it("um erro de rede devolve false sem lançar", async () => {
    stubFetchQueFalha(new Error("ECONNREFUSED"));
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await expect(enviarEmailDeAcesso("a@b.c", "https://app/x", "555555")).resolves.toBe(
      false,
    );
  });

  it("um timeout devolve false sem lançar", async () => {
    const abortado = new Error("The operation was aborted");
    abortado.name = "TimeoutError";
    stubFetchQueFalha(abortado);

    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await expect(enviarEmailDeAcesso("a@b.c", "https://app/x", "666666")).resolves.toBe(
      false,
    );
  });

  it("sem chave configurada, não chama a Brevo", async () => {
    // Uma chave vazia enviada à Brevo devolve 401 e polui o log com um erro que
    // não é erro.
    const espiao = stubFetch(respostaOk());
    const { enviarEmailDeAcesso } = await comConfig({
      ...CONFIG_PADRAO,
      BREVO_API_KEY: "",
    });

    const enviou = await enviarEmailDeAcesso("a@b.c", "https://app/x", "777777");

    expect(enviou).toBe(false);
    expect(espiao).not.toHaveBeenCalled();
  });

  it("não retenta automaticamente", async () => {
    // Deliberado: quem espera é o usuário na tela de login. Retentar com backoff
    // multiplicaria a espera por um e-mail que pode nunca sair; quem quer outro
    // e-mail clica em "reenviar", e aí o pedido novo gera um código novo.
    const espiao = stubFetch(jsonResponse({}, 500));
    const { enviarEmailDeAcesso } = await comConfig(CONFIG_PADRAO);

    await enviarEmailDeAcesso("a@b.c", "https://app/x", "888888");

    expect(espiao).toHaveBeenCalledTimes(1);
  });
});

describe("paridade do e-mail com o backend .NET", () => {
  /**
   * O gêmeo em C# não roda nesta suíte, então a comparação é feita contra o
   * arquivo dele. Um parser por expressão regular é frágil em geral, mas aqui é
   * adequado: se a forma do arquivo mudar, este teste falha ruidosamente - que é
   * exatamente o que se quer.
   */
  function fonteDoDotNet(): string {
    return readFileSync(
      resolve(__dirname, "../../../backend-dotnet/src/Sabemi.Application/Auth/LoginEmail.cs"),
      "utf8",
    );
  }

  it("o assunto é o mesmo nos dois backends", () => {
    // O usuário não deveria receber e-mails com assuntos diferentes dependendo
    // de qual backend atendeu o pedido - e ele nem sabe que existem dois.
    const fonte = fonteDoDotNet();
    const m = /public const string Assunto = "([^"]+)"/.exec(fonte);

    expect(m, "constante `Assunto` não encontrada no LoginEmail.cs").not.toBeNull();
    expect(ASSUNTO).toBe(m![1]);
  });

  it("as frases do corpo são as mesmas", () => {
    // Compara as frases que o usuário lê. Não compara o HTML inteiro: espaços e
    // indentação diferem entre uma raw string do C# e um template literal do
    // TypeScript, e um teste que quebrasse por indentação seria abandonado na
    // primeira formatação automática.
    const fonte = fonteDoDotNet();
    const { html, text } = montarEmailDeAcesso("https://app/x", "123456", 15);

    const frases = [
      "Acesso ao painel Sabemi",
      "Você pediu acesso ao painel de conciliação de pagamentos.",
      "Entrar no painel",
      "Se preferir, digite este código na tela em que você pediu o acesso:",
      "servem uma única vez.",
      "ninguém entra na sua conta.",
    ];

    for (const frase of frases) {
      expect(html + text, `frase ausente no VINEXT: ${frase}`).toContain(frase);
      expect(fonte, `frase ausente no .NET: ${frase}`).toContain(frase);
    }
  });

  it("os dois dizem o prazo de validade", () => {
    // Evita o suporte que começa com "cliquei no link de ontem e não funcionou".
    const { html, text } = montarEmailDeAcesso("https://app/x", "123456", 15);

    expect(html).toContain("15 minutos");
    expect(text).toContain("15 minutos");
    expect(fonteDoDotNet()).toContain("{minutosDeValidade} minutos");
  });

  it("o HTML usa estilo inline, e não uma folha no <head>", () => {
    // Clientes de e-mail descartam <style> no <head> (o Gmail, entre eles).
    const { html } = montarEmailDeAcesso("https://app/x", "123456", 15);

    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).toContain('style="');
  });

  it("escapa o que vai para o HTML", () => {
    // Os valores vêm do servidor hoje, mas escapar sempre é mais barato do que
    // auditar a origem de cada um a cada mudança.
    const { html } = montarEmailDeAcesso('https://app/x?a="><script>', "1<2", 15);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
  });
});
