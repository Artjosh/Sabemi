/**
 * A regra que impede o sistema de gerar hard bounces.
 *
 * <b>De onde veio.</b> Uma execução da suíte ponta a ponta com provedor de e-mail
 * ativo mandou 26 mensagens para endereços inventados em `@sabemi.com.br`. Todas
 * viraram hard bounce — e bounce não é mensagem perdida, é reputação de envio
 * perdida, de forma acumulativa e irreversível.
 *
 * <b>Espelho de `EnderecoDeEmail.cs`.</b> O segundo teste lê o arquivo C# e
 * compara as listas: os dois backends compartilham a tabela de pedidos de login,
 * então uma regra que valha em um e não no outro seria uma diferença de
 * comportamento invisível.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DOMINIOS_RESERVADOS, podeReceber } from "@/server/bff/email-address";

describe("entrega em domínio reservado nunca é tentada", () => {
  // RFC 2606 / 6761: `.invalid`, `.test`, `.example` e `.localhost` existem para
  // NÃO existirem. Não há MX, nenhuma mensagem chega, e cada tentativa é um hard
  // bounce garantido.
  it.each([
    ["operador@sabemi.com.br", true],
    ["MAIUSCULA@SABEMI.COM.BR", true],

    // Um caso por domínio da lista: é a superfície real da regra.
    ["e2e-vinext-123@e2e.invalid", false],
    ["qualquer@exemplo.test", false],
    ["alguem@algo.example", false],
    ["dev@app.localhost", false],

    // Sem subdomínio o sufixo ".invalid" não casaria, e o endereço passaria.
    ["alguem@invalid", false],

    // Raiz explícita é sintaxe legítima de nome de domínio. Sem normalizar,
    // "a@b.invalid." escaparia da regra por um caractere.
    ["alguem@sub.invalid.", false],

    // Sem domínio não há onde entregar.
    [null, false],
    ["sem-arroba", false],
  ])("%s → %s", (email, esperado) => {
    expect(podeReceber(email as string | null)).toBe(esperado);
  });

  it("a lista de domínios reservados é a mesma do backend .NET", () => {
    // Falha se alguém acrescentar um domínio em um lado e esquecer o outro. Lê o
    // arquivo C# em vez de duplicar a lista, porque uma cópia manual divergiria
    // em silêncio - que é exatamente o que ele existe para pegar.
    const csharp = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../backend-dotnet/src/Sabemi.Domain/Auth/EnderecoDeEmail.cs",
      ),
      "utf-8",
    );

    const inicio = csharp.indexOf("DominiosReservados =");
    expect(inicio).toBeGreaterThan(-1);
    const literal = csharp.slice(inicio, csharp.indexOf("];", inicio));
    const doDotnet = [...literal.matchAll(/"(\.[a-z]+)"/g)].map((m) => m[1]);

    expect([...doDotnet].sort()).toEqual([...DOMINIOS_RESERVADOS].sort());
  });
});
