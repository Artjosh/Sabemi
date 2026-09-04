/**
 * Uma variável de ambiente que vale só em metade do sistema.
 *
 * <b>O bug que originou isto.</b> `AUTH_EXPOSE_LOGIN_CODES` desliga o atalho de
 * desenvolvimento — o link e o código OTP que vêm no corpo da resposta de login.
 * Ela era lida corretamente pelos dois backends, mas o `docker-compose.yml` só a
 * entregava ao serviço `frontend`. O serviço `api` lê o mesmo valor sob outro
 * nome (`Auth__ExposeLoginCodesInDevelopment`) e não recebia nada.
 *
 * O efeito: definir `AUTH_EXPOSE_LOGIN_CODES=false` desligava o atalho no VINEXT
 * e deixava o .NET devolvendo `dev_otp_code` no corpo. Quem definisse a variável
 * acreditaria ter desligado nos dois — e um atalho que entrega o código de acesso
 * a quem chamar o endpoint com um e-mail qualquer é o caminho inteiro para dentro
 * do painel.
 *
 * <b>Por que um teste, e não só a correção.</b> Uma flag de segurança que produz
 * confiança sem produzir efeito é pior que nenhuma flag, e a falha é silenciosa:
 * nada quebra, nada aparece no log, e os dois backends respondem 200. A única
 * forma de perceber é comparar as respostas dos dois — que é justamente o que
 * ninguém faz depois de mudar uma variável de ambiente.
 *
 * Este teste lê o compose porque é lá que o bug morava: os dois backends estavam
 * certos, o cabeamento entre eles é que não.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** Bloco `environment:` de um serviço do compose, como texto. */
function ambienteDo(compose: string, servico: string): string {
  const inicio = compose.indexOf(`\n  ${servico}:`);
  expect(inicio, `serviço \`${servico}\` não existe no compose`).toBeGreaterThan(-1);

  // Até o próximo serviço no mesmo nível de indentação.
  const proximo = compose.slice(inicio + 1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return proximo < 0 ? compose.slice(inicio) : compose.slice(inicio, inicio + 1 + proximo);
}

const RAIZ = resolve(import.meta.dirname, "../../..");

describe("as variáveis que valem para os DOIS backends chegam aos dois", () => {
  it("AUTH_EXPOSE_LOGIN_CODES alimenta `api` e `frontend` em desenvolvimento", () => {
    const compose = readFileSync(resolve(RAIZ, "docker-compose.yml"), "utf-8");

    // O .NET lê sob outro nome; o que precisa ser o mesmo é a FONTE.
    expect(ambienteDo(compose, "api")).toContain(
      "Auth__ExposeLoginCodesInDevelopment: ${AUTH_EXPOSE_LOGIN_CODES",
    );
    expect(ambienteDo(compose, "frontend")).toContain(
      "AUTH_EXPOSE_LOGIN_CODES: ${AUTH_EXPOSE_LOGIN_CODES",
    );
  });

  it("em produção os dois falham FECHADOS, sem depender do ambiente", () => {
    // Aqui o valor não vem de `.env`: não deve existir variável que ligue o
    // atalho num servidor de produção, nem por engano.
    const prod = readFileSync(resolve(RAIZ, "docker-compose.prod.yml"), "utf-8");

    expect(ambienteDo(prod, "api")).toContain(
      'Auth__ExposeLoginCodesInDevelopment: "false"',
    );
    expect(ambienteDo(prod, "frontend")).toContain('AUTH_EXPOSE_LOGIN_CODES: "false"');
  });

  it("a variável está no `.env.example`, com valor vazio", () => {
    // Uma flag de segurança que não aparece no template é uma flag que ninguém
    // sabe que existe - foi assim que a divergência sobreviveu.
    const exemplo = readFileSync(resolve(RAIZ, ".env.example"), "utf-8");

    expect(exemplo).toMatch(/^AUTH_EXPOSE_LOGIN_CODES=\s*$/m);
  });
});
