import type { BackendId } from "@/lib/contracts";

import { handleBffRequest } from "../bff/router";

/**
 * Abstracao de backend - o coracao da feature de troca.
 *
 * <b>O problema.</b> A aplicacao precisa funcionar sobre duas implementacoes
 * completamente diferentes: um serviço .NET do outro lado da rede e um backend
 * TypeScript que roda no mesmo processo do frontend. Sem uma abstracao, cada
 * tela precisaria saber qual dos dois esta ativo e como falar com ele - e a
 * troca viraria uma condicao espalhada por todo o codigo.
 *
 * <b>A solucao.</b> Um unico tipo, {@link BackendAdapter}, com uma unica
 * operacao: dada uma requisicao logica, devolva uma resposta. As duas
 * implementacoes se parecem por fora e nada mais na aplicacao precisa saber
 * qual delas respondeu.
 *
 * Repare no que NAO esta aqui: nao ha metodos `listPayments`, `login`,
 * `getSummary`. Um adapter por operacao obrigaria a alterar a interface e as
 * duas implementacoes a cada novo endpoint. Com uma operacao generica de
 * requisicao, o contrato compartilhado (`contracts/openapi.yaml`) e quem define
 * a superficie - que e exatamente onde essa definicao deve morar.
 */

export interface BackendRequest {
  method: string;
  /** Caminho relativo do contrato, ex.: `payments`, `auth/login-status`. */
  path: string;
  searchParams: URLSearchParams;
  rawBody: string;
  headers: Headers;
  /** JWT da sessao, lido do cookie httpOnly pelo gateway. */
  token: string | null;
}

export interface BackendResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

export interface BackendAdapter {
  readonly id: BackendId;
  readonly label: string;
  /** Descricao curta mostrada no seletor da interface. */
  readonly description: string;
  handle(request: BackendRequest): Promise<BackendResponse>;
}

/**
 * Backend primario: proxy para o serviço ASP.NET Core.
 *
 * O browser nunca fala com ele diretamente. O gateway (que roda no servidor do
 * VINEXT) le o cookie httpOnly, injeta o `Authorization: Bearer` e repassa a
 * chamada. Duas consequencias: o token de sessao jamais e exposto ao JavaScript,
 * e o browser so precisa de requisicoes same-origin - nao ha CORS no caminho
 * normal de uso.
 */
class DotnetBackendAdapter implements BackendAdapter {
  readonly id = "dotnet" as const;
  readonly label = ".NET";
  readonly description = "ASP.NET Core + EF Core + worker dedicado";

  private baseUrl(): string {
    const url =
      process.env.DOTNET_API_URL ??
      process.env.BACKEND_INTERNAL_URL ??
      "http://localhost:8080";
    return url.replace(/\/$/, "");
  }

  async handle(request: BackendRequest): Promise<BackendResponse> {
    const query = request.searchParams.toString();
    const target = `${this.baseUrl()}/${request.path}${query ? `?${query}` : ""}`;

    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");

    // A chave e a assinatura do webhook precisam alcancar o backend .NET
    // intactas: e ele quem as valida, e a assinatura cobre o corpo bruto.
    for (const nome of ["x-api-key", "x-signature"]) {
      const valor = request.headers.get(nome);
      if (valor) headers.set(nome, valor);
    }

    if (request.token) {
      headers.set("Authorization", `Bearer ${request.token}`);
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? request.rawBody : undefined,
        // O dashboard atualiza por polling: uma resposta cacheada mostraria
        // dados velhos e faria o operador acreditar que nada esta chegando.
        cache: "no-store",
        redirect: "manual",
      });
    } catch {
      // O backend .NET estar fora nao pode virar uma tela quebrada. Vira o mesmo
      // ProblemDetails de sempre, que a UI ja sabe exibir.
      return {
        status: 502,
        body: {
          detail:
            "Nao foi possivel conectar ao backend .NET. Verifique se o serviço esta no ar.",
          code: "backend_unreachable",
        },
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const texto = await response.text();

    if (contentType.includes("text/html")) {
      return { status: response.status, body: texto, contentType };
    }

    return {
      status: response.status,
      body: texto ? safeParse(texto) : null,
    };
  }
}

/**
 * Backend alternativo: implementacao TypeScript no proprio ambiente VINEXT.
 *
 * Repare que a chamada e EM PROCESSO - nao ha `fetch` para o proprio servidor.
 * Uma volta pela rede falando consigo mesmo acrescentaria latencia e uma porta
 * a mais para configurar, sem trazer nada. Esta e a vantagem estrutural de um
 * BFF: quando a implementacao vive no mesmo runtime do gateway, o "salto de
 * rede" e uma chamada de funcao.
 */
class VinextBackendAdapter implements BackendAdapter {
  readonly id = "vinext" as const;
  readonly label = "VINEXT / BFF";
  readonly description = "Route handlers TypeScript + Prisma, em processo";

  async handle(request: BackendRequest): Promise<BackendResponse> {
    return handleBffRequest({
      method: request.method,
      path: request.path,
      searchParams: request.searchParams,
      rawBody: request.rawBody,
      headers: request.headers,
      token: request.token,
    });
  }
}

const adapters: Record<BackendId, BackendAdapter> = {
  dotnet: new DotnetBackendAdapter(),
  vinext: new VinextBackendAdapter(),
};

/** Backend usado quando nada foi escolhido - o primario exigido pela vaga. */
export const DEFAULT_BACKEND: BackendId = "dotnet";

export function isBackendId(value: unknown): value is BackendId {
  return value === "dotnet" || value === "vinext";
}

export function getAdapter(id: BackendId): BackendAdapter {
  return adapters[id];
}

/** Metadados dos backends, para montar o seletor da interface. */
export function listBackends(): Array<{ id: BackendId; label: string; description: string }> {
  return Object.values(adapters).map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
  }));
}

function safeParse(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}
