/**
 * Apoio aos testes ponta a ponta.
 *
 * <b>O que estes testes sao.</b> Eles falam com a stack REAL pela rede - quatro
 * containers, PostgreSQL de verdade, worker em outro processo - exatamente como
 * um navegador e o banco parceiro fariam. Nada e substituido por duble.
 *
 * <b>Por que sem navegador.</b> A logica de interface ja e coberta pelos testes
 * de componente (jsdom + Testing Library). O que falta provar aqui e a
 * INTEGRACAO: que o polling atravessa gateway, backend e banco; que a troca de
 * backend muda de fato a origem dos dados; que o worker de outro container
 * conclui o trabalho. Um navegador automatizado acrescentaria minutos de
 * execucao e uma fonte grande de instabilidade sem cobrir nada disso melhor.
 *
 * O cliente HTTP abaixo carrega cookies como um navegador carregaria - e o que
 * permite exercitar a sessao em cookie httpOnly de ponta a ponta.
 */

import { describe } from "vitest";

/**
 * Ha provedor de e-mail ativo na stack?
 *
 * Preenchida pelo `global-setup.ts`, que consulta o `/health` dos dois backends
 * antes da coleta. Quem consome e o `descreveComLogin` abaixo, para PULAR os
 * blocos que autenticam: eles usam enderecos inventados, e com provedor ativo
 * cada login vira um hard bounce na conta.
 *
 * Ausente = a suite foi rodada sem o globalSetup (um arquivo isolado, por
 * exemplo). Nesse caso vale `false`, que e o comportamento anterior: os testes
 * rodam. A guarda em `sessaoAutenticada` continua sendo a rede de seguranca.
 */
export const EMAIL_PROVIDER_ATIVO = process.env.E2E_EMAIL_PROVIDER_ATIVO === "1";

/**
 * `describe` para blocos que precisam de uma sessao autenticada.
 *
 * Identico a `describe`, exceto que se pula quando ha provedor de e-mail ativo.
 * Existe para o arquivo de teste declarar a dependencia UMA vez, em vez de
 * repetir `describe.skipIf(EMAIL_PROVIDER_ATIVO)` em cada bloco - onze deles
 * hoje, e a repeticao e onde se esquece um.
 */
export const descreveComLogin = describe.skipIf(EMAIL_PROVIDER_ATIVO);

export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8080";
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const API_KEY = process.env.E2E_API_KEY ?? "sabemi-dev-api-key";

/**
 * Cookie jar minimo, com a semantica que estes testes precisam.
 *
 * Guarda apenas nome e valor, e trata `Max-Age=0` / `Expires` no passado como
 * remocao - que e como o servidor apaga o cookie de sessao no logout e na troca
 * de backend. Sem isso, um teste de "a troca encerrou a sessao" continuaria
 * mandando o cookie antigo e passaria por engano.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorver(response: Response): void {
    const enviados = response.headers.getSetCookie?.() ?? [];

    for (const bruto of enviados) {
      const [par, ...atributos] = bruto.split(";");
      const separador = par.indexOf("=");
      if (separador < 0) continue;

      const nome = par.slice(0, separador).trim();
      const valor = par.slice(separador + 1).trim();

      const removido = atributos.some((a) => {
        const attr = a.trim().toLowerCase();
        if (attr === "max-age=0") return true;
        if (!attr.startsWith("expires=")) return false;
        const quando = Date.parse(attr.slice("expires=".length));
        return Number.isFinite(quando) && quando <= Date.now();
      });

      if (removido || valor === "") {
        this.cookies.delete(nome);
      } else {
        this.cookies.set(nome, valor);
      }
    }
  }

  get header(): string {
    return [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; ");
  }

  tem(nome: string): boolean {
    return this.cookies.has(nome);
  }

  valor(nome: string): string | undefined {
    return this.cookies.get(nome);
  }
}

export interface Resposta<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * Cliente HTTP com cookies - o mais proximo de um navegador que estes testes
 * precisam.
 */
export class Cliente {
  readonly jar = new CookieJar();

  constructor(private readonly base: string) {}

  async request<T = unknown>(
    caminho: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<Resposta<T>> {
    const { json, headers, ...resto } = init;

    const finais = new Headers(headers);
    if (json !== undefined) {
      finais.set("Content-Type", "application/json");
    }
    if (this.jar.header) {
      finais.set("Cookie", this.jar.header);
    }

    const response = await fetch(`${this.base}${caminho}`, {
      ...resto,
      headers: finais,
      body: json !== undefined ? JSON.stringify(json) : resto.body,
      redirect: "manual",
    });

    this.jar.absorver(response);

    const texto = await response.text();
    let body: unknown = null;
    if (texto) {
      try {
        body = JSON.parse(texto);
      } catch {
        body = texto;
      }
    }

    return { status: response.status, body: body as T, headers: response.headers };
  }

  get<T = unknown>(caminho: string, init: RequestInit = {}) {
    return this.request<T>(caminho, { ...init, method: "GET" });
  }

  post<T = unknown>(caminho: string, json?: unknown, init: RequestInit = {}) {
    return this.request<T>(caminho, { ...init, method: "POST", json });
  }
}

/** Cliente do navegador: fala com o frontend (gateway same-origin). */
export function navegador() {
  return new Cliente(WEB_URL);
}

/** Cliente do banco parceiro: fala direto com o backend escolhido. */
export function parceiro(base: string = API_URL) {
  return new Cliente(base);
}

/** Identificador unico por execucao, para os testes nao colidirem entre si. */
export function idUnico(prefixo: string): string {
  return `${prefixo}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** Payload de pagamento valido. */
export function pagamento(over: Record<string, unknown> = {}) {
  return {
    id_transacao: idUnico("E2E"),
    id_contrato: idUnico("CTR"),
    valor: 100.0,
    data_pagamento: "2026-08-01T10:00:00Z",
    status: "PAGO",
    ...over,
  };
}

/**
 * Espera uma condicao por sondagem.
 *
 * O worker roda em outro container e nao ha como saber quando terminou senao
 * perguntando. Uma pausa fixa seria instavel nos dois sentidos: curta demais em
 * maquina carregada, e desperdicio quando esta livre.
 */
export async function aguardarAte<T>(
  descricao: string,
  tentar: () => Promise<T | null>,
  { prazoMs = 60_000, intervaloMs = 500 } = {},
): Promise<T> {
  const limite = Date.now() + prazoMs;

  while (Date.now() < limite) {
    const resultado = await tentar();
    if (resultado !== null && resultado !== undefined) return resultado;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }

  throw new Error(`Tempo esgotado aguardando: ${descricao}`);
}

/** Configuracao de um backend, para os testes que rodam contra os dois. */
export interface BackendSobTeste {
  id: "dotnet" | "vinext";
  nome: string;
  /** Onde o banco parceiro entrega o webhook. */
  webhookUrl: string;
  /** Base para chamadas diretas ao backend (sem passar pelo gateway). */
  base: string;
  /** Prefixo dos caminhos do contrato nessa base. */
  prefixo: string;
}

/**
 * Os dois backends, exercitados pelos mesmos testes.
 *
 * E assim que se demonstra que os dois cumprem o mesmo contrato: o teste e um
 * so, e roda duas vezes.
 */
export const BACKENDS: BackendSobTeste[] = [
  {
    id: "dotnet",
    nome: ".NET",
    webhookUrl: `${API_URL}/webhooks/pagamento`,
    base: API_URL,
    prefixo: "",
  },
  {
    id: "vinext",
    nome: "VINEXT/BFF",
    webhookUrl: `${WEB_URL}/api/bff/webhooks/pagamento`,
    base: WEB_URL,
    prefixo: "/api/bff",
  },
];

/**
 * Sessao autenticada, reaproveitada dentro do mesmo arquivo de teste.
 *
 * <b>Por que cachear.</b> Cada login consome uma vaga do rate limit do endpoint
 * de autenticacao (por IP). Refazer o login a cada verificacao estouraria o
 * limite - e, pior, estaria testando o login de novo em vez de testar o que o
 * teste se propoe. Um operador real tambem nao reautentica a cada clique.
 *
 * Os testes cujo objeto E o login (o fluxo cross-device, o rate limit) criam a
 * propria sessao e nao passam por aqui.
 */
const sessoesEmCache = new Map<string, Cliente>();

export async function sessaoAutenticada(
  backendId: "dotnet" | "vinext",
): Promise<Cliente> {
  const jaTemos = sessoesEmCache.get(backendId);
  if (jaTemos) return jaTemos;

  const cliente = navegador();

  const troca = await cliente.post<{ active: string }>("/api/backend", { backend: backendId });
  if (troca.body.active !== backendId) {
    throw new Error(`Nao foi possivel selecionar o backend ${backendId}.`);
  }

  const inicio = await cliente.post<{
    selector: string;
    dev_magic_url: string;
    email_sent: boolean;
  }>("/api/auth/login?step=start", {
    email: `e2e-${backendId}-${Date.now()}@sabemi.com.br`,
  });

  if (inicio.status !== 200) {
    throw new Error(
      `Falha ao iniciar o login no backend ${backendId}: HTTP ${inicio.status}. ` +
        `Se for 429, suba a stack com AUTH_RATE_LIMIT maior (ver tests/e2e/README.md).`,
    );
  }

  // A suite autentica com enderecos INVENTADOS. Se a stack tiver um provedor de
  // e-mail configurado, ela envia para eles de verdade - e cada um vira um hard
  // bounce, que e exatamente o que corroi reputacao de envio.
  //
  // Aconteceu neste projeto: uma execucao com SMTP ativo gerou 26 bounces antes
  // de alguem perceber. Documentar nao impede; abortar impede.
  if (inicio.body.email_sent) {
    throw new Error(
      "A stack esta com um provedor de e-mail ATIVO, e esta suite autentica com " +
        "enderecos inventados - cada login vira um hard bounce na conta.\n\n" +
        "Suba a stack de teste sem provedor:\n" +
        "  AUTH_RATE_LIMIT=500 BREVO_API_KEY= SMTP_HOST= docker compose up -d --wait",
    );
  }

  // Confirma o link, como faria o aparelho que abriu o e-mail.
  await new Cliente("").get(inicio.body.dev_magic_url);

  const aprovado = await cliente.post<{ status: string }>("/api/auth/login?step=poll", {
    selector: inicio.body.selector,
  });

  if (aprovado.body.status !== "approved") {
    throw new Error(`O login no backend ${backendId} nao foi aprovado.`);
  }

  sessoesEmCache.set(backendId, cliente);
  return cliente;
}

/**
 * Garante que o backend indicado esta selecionado para a sessao em cache.
 *
 * Trocar de backend encerra a sessao, entao alternar entre eles exige refazer o
 * login. Reafirmar a selecao antes de usar a sessao evita que um teste anterior
 * a tenha deixado apontando para o outro.
 */
export async function comBackend(backendId: "dotnet" | "vinext"): Promise<Cliente> {
  const cliente = await sessaoAutenticada(backendId);

  const atual = await cliente.get<{ active: string }>("/api/backend");
  if (atual.body.active !== backendId) {
    // A sessao foi invalidada por uma troca; descarta o cache e refaz.
    sessoesEmCache.delete(backendId);
    return sessaoAutenticada(backendId);
  }

  return cliente;
}
