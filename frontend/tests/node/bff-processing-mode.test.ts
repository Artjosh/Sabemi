import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/bff/db";

/**
 * Os dois modos de processamento em background do backend VINEXT.
 *
 * <b>Por que este arquivo existe.</b> A task exige que o webhook responda rapido
 * enquanto a regra pesada roda em background. Havia um jeito so de fazer isso -
 * um laco continuo no processo - e ele funciona em container e nao funciona em
 * serverless, onde a invocacao congela depois da resposta. Passou a haver dois
 * modos (`loop` e `sob-demanda`), e um modo que nunca dispara e uma falha
 * SILENCIOSA: o webhook responde 202, o evento fica PENDENTE para sempre, e nada
 * aparece no log. So o painel denuncia, e horas depois.
 *
 * Estes testes checam a fiacao dos dois: que o modo `loop` NAO agenda nada por
 * requisicao (senao haveria dois consumidores concorrendo no mesmo processo), e
 * que o modo `sob-demanda` agenda - preferindo o `waitUntil` da plataforma
 * quando ele existe, que e o que estende a invocacao para depois da resposta.
 *
 * <b>Por que o import e dinamico.</b> `bffConfig` e congelado na primeira
 * importacao do modulo de configuracao. Trocar `BFF_PROCESSING_MODE` e reimportar
 * com `vi.resetModules()` e o que permite exercitar os dois modos no mesmo
 * arquivo, em vez de deixar um deles sem cobertura.
 */

const SIMBOLO_VERCEL = Symbol.for("@vercel/request-context");

/** Carrega o servico com o ambiente pedido, isolado do resto da suite. */
async function carregar(env: Record<string, string>) {
  vi.resetModules();

  const anterior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    anterior[k] = process.env[k];
    process.env[k] = v;
  }

  const mod = await import("@/server/bff/processing-service");
  return {
    mod,
    restaurar() {
      for (const [k, v] of Object.entries(anterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** Instala um `waitUntil` espiao no lugar do contexto da plataforma. */
function instalarContextoDaPlataforma() {
  const recebidas: Promise<unknown>[] = [];
  const global = globalThis as unknown as Record<symbol, unknown>;
  const anterior = global[SIMBOLO_VERCEL];

  global[SIMBOLO_VERCEL] = {
    get: () => ({
      waitUntil: (p: Promise<unknown>) => {
        recebidas.push(p);
      },
    }),
  };

  return {
    recebidas,
    remover() {
      if (anterior === undefined) delete global[SIMBOLO_VERCEL];
      else global[SIMBOLO_VERCEL] = anterior;
    },
  };
}

beforeEach(async () => {
  await prisma.processingJob.deleteMany();
  await prisma.paymentEvent.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("modo sob-demanda (serverless)", () => {
  it("entrega o ciclo ao waitUntil da plataforma, para rodar após a resposta", async () => {
    const plataforma = instalarContextoDaPlataforma();
    const { mod, restaurar } = await carregar({
      BFF_WORKER_ENABLED: "true",
      BFF_PROCESSING_MODE: "sob-demanda",
    });

    try {
      mod.agendarCicloAposResposta();

      // O que importa nao e o resultado do ciclo, e sim que ele foi ENTREGUE a
      // plataforma. Sem isso a invocacao termina na resposta e o trabalho morre.
      expect(plataforma.recebidas).toHaveLength(1);
      await plataforma.recebidas[0];
    } finally {
      restaurar();
      plataforma.remover();
    }
  });

  it("a promessa entregue à plataforma nunca rejeita", async () => {
    // O ciclo roda depois da resposta: uma excecao ali nao tem para onde subir.
    // Se escapasse, viraria rejeicao nao tratada - que na Vercel conta como
    // erro da invocacao e suja o log de um pedido que respondeu 202. Por isso o
    // `try/catch` dentro de `agendarCicloAposResposta` faz parte do contrato, e
    // e o que esta asserido aqui.
    const plataforma = instalarContextoDaPlataforma();
    const { mod, restaurar } = await carregar({
      BFF_WORKER_ENABLED: "true",
      BFF_PROCESSING_MODE: "sob-demanda",
    });

    try {
      mod.agendarCicloAposResposta();
      await expect(Promise.all(plataforma.recebidas)).resolves.toBeDefined();
    } finally {
      restaurar();
      plataforma.remover();
    }
  });

  it("sem contexto de plataforma, ainda dispara o ciclo", async () => {
    // O modo pode ser forcado fora da Vercel (uma demonstracao, um teste). Sem
    // `waitUntil` o disparo e solto, e num processo de vida longa isso basta.
    const { mod, restaurar } = await carregar({
      BFF_WORKER_ENABLED: "true",
      BFF_PROCESSING_MODE: "sob-demanda",
    });

    try {
      expect(() => mod.agendarCicloAposResposta()).not.toThrow();
    } finally {
      restaurar();
    }
  });
});

describe("modo loop (container)", () => {
  it("não agenda ciclo por requisição — o laço já cuida da fila", async () => {
    // Dois consumidores no MESMO processo nao se corrompem (a reivindicacao usa
    // FOR UPDATE SKIP LOCKED), mas dobrariam as consultas ao banco a cada
    // webhook sem processar um item a mais.
    const plataforma = instalarContextoDaPlataforma();
    const { mod, restaurar } = await carregar({
      BFF_WORKER_ENABLED: "true",
      BFF_PROCESSING_MODE: "loop",
    });

    try {
      mod.agendarCicloAposResposta();
      expect(plataforma.recebidas).toHaveLength(0);
    } finally {
      restaurar();
      plataforma.remover();
    }
  });

  it("com o worker desligado, nenhum dos dois modos dispara nada", async () => {
    // E o estado da suite de testes: quem controla o ciclo e o teste, chamando
    // `runProcessingCycle` na hora que quer observar o resultado.
    const plataforma = instalarContextoDaPlataforma();
    const { mod, restaurar } = await carregar({
      BFF_WORKER_ENABLED: "false",
      BFF_PROCESSING_MODE: "sob-demanda",
    });

    try {
      mod.agendarCicloAposResposta();
      mod.ensureWorkerStarted();
      expect(plataforma.recebidas).toHaveLength(0);
    } finally {
      restaurar();
      plataforma.remover();
    }
  });
});
