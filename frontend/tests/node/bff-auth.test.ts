import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginStatusDto, MagicLinkStartDto } from "@/lib/contracts";
import {
  confirmMagicLink,
  pollLoginStatus,
  purgeExpiredLoginRequests,
  startLogin,
  verifyOtp,
} from "@/server/bff/auth-service";
import { fixedTimeEquals, sha256, verifySessionToken } from "@/server/bff/crypto";
import { prisma } from "@/server/bff/db";

/**
 * Login passwordless com polling cross-device - implementacao VINEXT.
 *
 * Espelha os testes do backend .NET, caso a caso. E o que demonstra que a
 * feature foi de fato reproduzida na segunda implementacao e nao apenas
 * proxyada.
 */

async function limpar() {
  await prisma.loginRequest.deleteMany();
  await prisma.appUser.deleteMany();
}

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await prisma.$disconnect();
});

function tokenDoLink(inicio: MagicLinkStartDto): string {
  return new URL(inicio.dev_magic_url!).searchParams.get("token")!;
}

async function iniciar(email = "operador@sabemi.com.br"): Promise<MagicLinkStartDto> {
  const resultado = await startLogin(email);
  if (!resultado.ok) throw new Error(resultado.message);
  return resultado.value;
}

describe("início do login", () => {
  it("devolve o selector e deixa o pedido pendente", async () => {
    const inicio = await iniciar();

    expect(inicio.selector).toBeTruthy();
    expect(inicio.email).toBe("operador@sabemi.com.br");

    const pedido = await prisma.loginRequest.findUniqueOrThrow({
      where: { selector: inicio.selector },
    });
    expect(pedido.status).toBe("PENDENTE");
  });

  it("guarda os segredos apenas como hash", async () => {
    // Um vazamento do banco não pode entregar logins ativos.
    const inicio = await iniciar();

    const pedido = await prisma.loginRequest.findUniqueOrThrow({
      where: { selector: inicio.selector },
    });

    expect(pedido.magicTokenHash).toHaveLength(64);
    expect(pedido.otpCodeHash).toHaveLength(64);

    // O que está gravado é o digest, não o segredo.
    expect(pedido.otpCodeHash).not.toBe(inicio.dev_otp_code);
    expect(pedido.otpCodeHash).toBe(sha256(inicio.dev_otp_code!));
    expect(pedido.magicTokenHash).toBe(sha256(tokenDoLink(inicio)));
  });

  it("gera código OTP de exatamente 6 dígitos", async () => {
    const inicio = await iniciar();

    expect(inicio.dev_otp_code).toMatch(/^\d{6}$/);
  });

  it.each(["", "sem-arroba", "dois@@arrobas.com", "com espaco@x.com", "arroba@sempontofinal"])(
    "recusa o e-mail implausível %j",
    async (email) => {
      const resultado = await startLogin(email);

      expect(resultado.ok).toBe(false);
      if (!resultado.ok) expect(resultado.failure).toBe("invalid_email");
    },
  );

  it("normaliza caixa e espaços do e-mail", async () => {
    const inicio = await iniciar("  Operador@SABEMI.com.BR  ");

    expect(inicio.email).toBe("operador@sabemi.com.br");
  });

  it("um novo pedido invalida o anterior do mesmo e-mail", async () => {
    // Sem isto, links antigos continuariam válidos e quem pedisse duas vezes
    // teria dois códigos funcionando ao mesmo tempo.
    const primeiro = await iniciar();
    const segundo = await iniciar();

    const antigo = await pollLoginStatus(primeiro.selector);
    expect(antigo.ok).toBe(false);

    const novo = await pollLoginStatus(segundo.selector);
    expect(novo.ok).toBe(true);
  });

  it("pedidos de e-mails diferentes coexistem", async () => {
    const a = await iniciar("a@sabemi.com.br");
    const b = await iniciar("b@sabemi.com.br");

    expect((await pollLoginStatus(a.selector)).ok).toBe(true);
    expect((await pollLoginStatus(b.selector)).ok).toBe(true);
  });
});

describe("polling", () => {
  it("devolve pending enquanto ninguém confirma", async () => {
    const inicio = await iniciar();

    const resultado = await pollLoginStatus(inicio.selector);

    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.value.status).toBe("pending");
      expect(resultado.value.authenticated).toBe(false);
      // Resposta mínima: ela é pedida a cada 2,5s.
      expect(resultado.value.access_token).toBeUndefined();
    }
  });

  it("fluxo CROSS-DEVICE: o link é confirmado em outro lugar e o polling entra", async () => {
    const inicio = await iniciar();

    expect((await pollLoginStatus(inicio.selector)).ok).toBe(true);

    // "Outro dispositivo" abre o link.
    const confirmado = await confirmMagicLink(tokenDoLink(inicio));
    expect(confirmado).toBe(true);

    // A aba de origem descobre sozinha no ciclo seguinte.
    const resultado = await pollLoginStatus(inicio.selector);

    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      const sessao = resultado.value as LoginStatusDto;
      expect(sessao.status).toBe("approved");
      expect(sessao.authenticated).toBe(true);
      expect(sessao.access_token).toBeTruthy();
      expect(sessao.user?.email).toBe("operador@sabemi.com.br");
    }
  });

  it("o pedido é de uso único: o segundo polling encerra com not_found", async () => {
    // É assim que o cliente sabe parar, em vez de girar até o timeout.
    const inicio = await iniciar();
    await confirmMagicLink(tokenDoLink(inicio));

    expect((await pollLoginStatus(inicio.selector)).ok).toBe(true);

    const segundo = await pollLoginStatus(inicio.selector);
    expect(segundo.ok).toBe(false);
    if (!segundo.ok) expect(segundo.failure).toBe("not_found");
  });

  it("selector inexistente encerra o polling", async () => {
    const resultado = await pollLoginStatus("selector-que-nunca-existiu");

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.failure).toBe("not_found");
  });

  it.each([null, undefined, "", 42])("selector inválido %j encerra o polling", async (valor) => {
    const resultado = await pollLoginStatus(valor);

    expect(resultado.ok).toBe(false);
  });

  it("o token emitido é um JWT válido para o usuário", async () => {
    const inicio = await iniciar();
    await confirmMagicLink(tokenDoLink(inicio));
    const resultado = await pollLoginStatus(inicio.selector);

    if (!resultado.ok) throw new Error("esperava aprovação");

    const claims = await verifySessionToken(resultado.value.access_token!);

    expect(claims).not.toBeNull();
    expect(claims!.email).toBe("operador@sabemi.com.br");
    expect(claims!.sub).toBe(resultado.value.user!.id);
  });
});

describe("magic link", () => {
  it("o primeiro acesso cria a conta - e só na confirmação", async () => {
    const inicio = await iniciar("novo@sabemi.com.br");

    // Apenas pedir o link não cria usuário: senão bastaria digitar e-mails para
    // encher a tabela de contas que nunca provaram posse da caixa.
    expect(await prisma.appUser.count()).toBe(0);

    await confirmMagicLink(tokenDoLink(inicio));

    const usuario = await prisma.appUser.findUniqueOrThrow({
      where: { email: "novo@sabemi.com.br" },
    });
    expect(usuario.email).toBe("novo@sabemi.com.br");
  });

  it("logins repetidos reaproveitam a mesma conta", async () => {
    for (let i = 0; i < 3; i++) {
      const inicio = await iniciar("recorrente@sabemi.com.br");
      await confirmMagicLink(tokenDoLink(inicio));
      await pollLoginStatus(inicio.selector);
    }

    expect(await prisma.appUser.count({ where: { email: "recorrente@sabemi.com.br" } })).toBe(1);
  });

  it.each([null, undefined, "", "token-inventado"])(
    "token %j não aprova nada",
    async (token) => {
      await iniciar();

      expect(await confirmMagicLink(token)).toBe(false);
    },
  );

  it("o token de um pedido não confirma outro", async () => {
    const a = await iniciar("a@sabemi.com.br");
    await iniciar("b@sabemi.com.br");

    // O pedido de "a" foi criado antes; confirmar com o token dele deve aprovar
    // exatamente o pedido de "a", e não o de "b".
    await confirmMagicLink(tokenDoLink(a));

    const pedidoB = await prisma.loginRequest.findFirstOrThrow({
      where: { email: "b@sabemi.com.br" },
    });
    expect(pedidoB.status).toBe("PENDENTE");
  });
});

describe("OTP", () => {
  it("o código correto autentica na hora", async () => {
    const inicio = await iniciar();

    const resultado = await verifyOtp(inicio.selector, inicio.dev_otp_code!);

    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.value.authenticated).toBe(true);
      expect(resultado.value.access_token).toBeTruthy();
    }
  });

  it("o código correto consome o pedido", async () => {
    const inicio = await iniciar();
    await verifyOtp(inicio.selector, inicio.dev_otp_code!);

    expect((await pollLoginStatus(inicio.selector)).ok).toBe(false);
  });

  it("o código incorreto falha mas mantém o pedido vivo", async () => {
    const inicio = await iniciar();

    const resultado = await verifyOtp(inicio.selector, "000000");

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.failure).toBe("invalid_code");

    // Um erro de digitação não pode destruir o pedido.
    expect((await pollLoginStatus(inicio.selector)).ok).toBe(true);
  });

  it("cada erro conta uma tentativa", async () => {
    const inicio = await iniciar();

    await verifyOtp(inicio.selector, "111111");
    await verifyOtp(inicio.selector, "222222");

    const pedido = await prisma.loginRequest.findUniqueOrThrow({
      where: { selector: inicio.selector },
    });
    expect(pedido.otpTentativas).toBe(2);
  });

  it("força bruta destrói o pedido - nem o código correto entra depois", async () => {
    const inicio = await iniciar();

    for (let i = 0; i < 5; i++) {
      await verifyOtp(inicio.selector, "111111");
    }

    const comCodigoCerto = await verifyOtp(inicio.selector, inicio.dev_otp_code!);

    expect(comCodigoCerto.ok).toBe(false);
    if (!comCodigoCerto.ok) expect(comCodigoCerto.failure).toBe("too_many_attempts");

    expect((await pollLoginStatus(inicio.selector)).ok).toBe(false);
  });

  it("o código de um pedido não serve para outro", async () => {
    const a = await iniciar("a@sabemi.com.br");
    const b = await iniciar("b@sabemi.com.br");

    const resultado = await verifyOtp(a.selector, b.dev_otp_code!);

    expect(resultado.ok).toBe(false);
  });

  it.each([
    [null, "123456"],
    ["sel", null],
    ["", ""],
  ])("selector %j e código %j são recusados", async (selector, code) => {
    const resultado = await verifyOtp(selector, code);

    expect(resultado.ok).toBe(false);
  });
});

describe("expiração", () => {
  it("o pedido expirado não pode mais ser consultado", async () => {
    const inicio = await iniciar();

    // Empurra a expiração para o passado em vez de esperar 15 minutos.
    await prisma.loginRequest.update({
      where: { selector: inicio.selector },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });

    const resultado = await pollLoginStatus(inicio.selector);

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.failure).toBe("not_found");
  });

  it("o link expirado não aprova", async () => {
    const inicio = await iniciar();
    await prisma.loginRequest.update({
      where: { selector: inicio.selector },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });

    expect(await confirmMagicLink(tokenDoLink(inicio))).toBe(false);
  });

  it("o OTP expirado é recusado", async () => {
    const inicio = await iniciar();
    await prisma.loginRequest.update({
      where: { selector: inicio.selector },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });

    const resultado = await verifyOtp(inicio.selector, inicio.dev_otp_code!);

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.failure).toBe("not_found");
  });

  it("a limpeza remove apenas os vencidos", async () => {
    // Sem esta varredura, a tabela consultada a cada 2,5s pelo polling cresceria
    // para sempre com pedidos abandonados.
    const vencido = await iniciar("vencido@sabemi.com.br");
    await prisma.loginRequest.update({
      where: { selector: vencido.selector },
      data: { expiraEm: new Date(Date.now() - 1000) },
    });

    const valido = await iniciar("valido@sabemi.com.br");

    const removidos = await purgeExpiredLoginRequests();

    expect(removidos).toBe(1);
    expect((await pollLoginStatus(valido.selector)).ok).toBe(true);
  });
});

describe("primitivas criptográficas", () => {
  it("o hash é determinístico e sensível à entrada", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(sha256("abc")).not.toBe(sha256("abd"));
    expect(sha256("abc")).toHaveLength(64);
  });

  it("a comparação em tempo constante distingue corretamente", () => {
    expect(fixedTimeEquals("segredo", "segredo")).toBe(true);
    expect(fixedTimeEquals("segredo", "segred0")).toBe(false);
    // Comprimentos diferentes são rejeitados antes: timingSafeEqual exige
    // buffers do mesmo tamanho, e o comprimento não é o segredo.
    expect(fixedTimeEquals("segredo", "segredo-maior")).toBe(false);
    expect(fixedTimeEquals("", "")).toBe(true);
  });

  it("token de sessão adulterado é recusado", async () => {
    const inicio = await iniciar();
    await confirmMagicLink(tokenDoLink(inicio));
    const resultado = await pollLoginStatus(inicio.selector);

    if (!resultado.ok) throw new Error("esperava aprovação");

    const token = resultado.value.access_token!;
    const adulterado = `${token.slice(0, -4)}AAAA`;

    expect(await verifySessionToken(adulterado)).toBeNull();
  });

  it.each(["", "nao-e-um-jwt", "a.b.c"])("token %j inválido devolve null", async (token) => {
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("token expirado é recusado", async () => {
    // O relógio avança além da validade da sessão.
    const inicio = await iniciar();
    await confirmMagicLink(tokenDoLink(inicio));
    const resultado = await pollLoginStatus(inicio.selector);

    if (!resultado.ok) throw new Error("esperava aprovação");
    const token = resultado.value.access_token!;

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 3600 * 1000);

    const claims = await verifySessionToken(token);

    vi.useRealTimers();

    expect(claims).toBeNull();
  });
});
