/**
 * A regra que impede o sistema de gerar hard bounces.
 *
 * <b>De onde veio.</b> Uma execução da suíte ponta a ponta com provedor de e-mail
 * ativo mandou 26 mensagens para endereços inventados em `@sabemi.com.br`. Todas
 * viraram hard bounce — e bounce não é mensagem perdida, é reputação de envio
 * perdida, de forma acumulativa e irreversível.
 *
 * O primeiro remédio foi a suíte abortar quando havia provedor. Este é o remédio
 * de verdade: endereços que *não podem* receber não recebem tentativa, e a suíte
 * passou a inventar os seus em `@e2e.invalid`.
 *
 * O último bloco é a PARIDADE com `Sabemi.Domain/Auth/EnderecoDeEmail.cs`. Os
 * dois backends compartilham a tabela de pedidos de login, então uma regra que
 * valha em um e não no outro seria uma diferença de comportamento invisível — o
 * gêmeo em C# não roda nesta suíte, então a comparação é feita contra o arquivo.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DOMINIOS_RESERVADOS, podeReceber } from "@/server/bff/email-address";

describe("endereços entregáveis", () => {
  it.each([
    "operador@sabemi.com.br",
    "alguem@gmail.com",
    "com.ponto@sub.dominio.co.uk",
    "MAIUSCULA@SABEMI.COM.BR",
  ])("%s recebe tentativa", (email) => {
    expect(podeReceber(email)).toBe(true);
  });
});

describe("domínios reservados por RFC nunca recebem tentativa", () => {
  // RFC 2606 / 6761: estes TLDs existem para NÃO existirem. Não há MX, nenhuma
  // mensagem chega, e cada tentativa é um hard bounce garantido.
  it.each([
    "e2e-vinext-123@e2e.invalid",
    "qualquer@exemplo.test",
    "alguem@algo.example",
    "dev@app.localhost",
  ])("%s é recusado", (email) => {
    expect(podeReceber(email)).toBe(false);
  });

  it.each(["alguem@invalid", "alguem@test", "alguem@localhost"])(
    "%s é recusado mesmo sem subdomínio",
    (email) => {
      // Sem subdomínio o sufixo ".invalid" não casaria, e o endereço passaria.
      expect(podeReceber(email)).toBe(false);
    },
  );

  it("um ponto final no domínio não esconde o TLD reservado", () => {
    // Raiz explícita é sintaxe legítima de nome de domínio. Sem normalizar,
    // "a@b.invalid." escaparia da regra por um caractere.
    expect(podeReceber("alguem@sub.invalid.")).toBe(false);
  });
});

describe("sem domínio não há onde entregar", () => {
  it.each([null, undefined, "", "   ", "sem-arroba", "termina-em@"])(
    "%s é recusado",
    (email) => {
      expect(podeReceber(email as string | null | undefined)).toBe(false);
    },
  );
});

describe("paridade com o backend .NET", () => {
  it("a lista de domínios reservados é a mesma nos dois", () => {
    // Este teste falha se alguém acrescentar um domínio em um lado e esquecer o
    // outro. Lê o arquivo C# em vez de duplicar a lista, porque uma cópia manual
    // divergiria em silêncio - que é exatamente o que ele existe para pegar.
    const csharp = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../backend-dotnet/src/Sabemi.Domain/Auth/EnderecoDeEmail.cs",
      ),
      "utf-8",
    );

    // Recorta exatamente o literal do array, e não um trecho aproximado: um
    // corte largo poderia pescar uma string de outro membro e o teste passaria
    // por acidente.
    const inicio = csharp.indexOf("DominiosReservados =");
    expect(inicio).toBeGreaterThan(-1);
    const literal = csharp.slice(inicio, csharp.indexOf("];", inicio));
    const doDotnet = [...literal.matchAll(/"(\.[a-z]+)"/g)].map((m) => m[1]);

    expect(doDotnet.length).toBeGreaterThan(0);
    expect([...doDotnet].sort()).toEqual([...DOMINIOS_RESERVADOS].sort());
  });
});
