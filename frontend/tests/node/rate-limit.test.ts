/**
 * Limite por janela fixa dos endpoints de autenticação.
 *
 * Espelha o `RequireRateLimiting("auth")` do backend .NET. O que se verifica aqui
 * é a contagem e a virada da janela; o que o limite *alcança* neste runtime está
 * documentado em `server/bff/rate-limit.ts` — e o motivo de a proteção que não
 * depende de IP (a espera de reenvio) ser a principal.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { ipDoCliente, permitir, reiniciarLimites } from "@/server/bff/rate-limit";

beforeEach(() => reiniciarLimites());

describe("contagem por janela", () => {
  it("deixa passar até o teto e recusa o excedente", () => {
    const t0 = 1_000_000;

    for (let i = 0; i < 3; i++) {
      expect(permitir("ip", 3, t0), `pedido ${i + 1} devia passar`).toBe(true);
    }

    expect(permitir("ip", 3, t0)).toBe(false);
  });

  it("a janela vira depois de um minuto", () => {
    const t0 = 1_000_000;
    permitir("ip", 1, t0);
    expect(permitir("ip", 1, t0)).toBe(false);

    // Janela fixa: 60s após o primeiro pedido, a contagem recomeça.
    expect(permitir("ip", 1, t0 + 60_000)).toBe(true);
  });

  it("cada chave conta separado", () => {
    // Sem isto, uma pessoa trancaria todo mundo - que é exatamente o motivo de
    // não existir um balde único quando o IP é desconhecido.
    const t0 = 1_000_000;
    permitir("a", 1, t0);

    expect(permitir("a", 1, t0)).toBe(false);
    expect(permitir("b", 1, t0)).toBe(true);
  });

  it("teto zero desliga o limite", () => {
    for (let i = 0; i < 50; i++) expect(permitir("ip", 0, 1)).toBe(true);
  });
});

describe("origem do cliente", () => {
  it.each([
    [{ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "2.2.2.2" }, "1.1.1.1"],
    [{ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" }, "2.2.2.2"],
    [{ "x-forwarded-for": "3.3.3.3, 4.4.4.4" }, "3.3.3.3"],
  ])("%o → %s", (headers, esperado) => {
    // A precedência importa: `cf-connecting-ip` é posto pela Cloudflare, que
    // descarta o que o cliente mandar; `x-forwarded-for` é o mais fraco, e dele
    // só vale o primeiro salto.
    expect(ipDoCliente(new Headers(headers))).toBe(esperado);
  });

  it("sem cabeçalho algum devolve null, e o chamador NÃO limita", () => {
    // Um balde único compartilhado seria pior que não limitar: bastaria uma
    // pessoa gastar o teto para trancar todos os outros.
    expect(ipDoCliente(new Headers())).toBeNull();
  });
});
