import { vi } from "vitest";

/**
 * Auxiliares compartilhados pelos testes.
 */

/** Assinatura do `fetch` global, como os testes precisam observa-la. */
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Substitui o `fetch` global por um duble tipado.
 *
 * <b>Por que a assinatura e anotada explicitamente.</b> Com
 * `vi.fn(async () => resposta)`, o TypeScript infere um mock SEM parametros: o
 * teste roda, mas `mock.calls[0][0]` nao existe no tipo e `pnpm typecheck`
 * falha. Como o typecheck e um passo do CI, o erro so apareceria la - depois do
 * push, e longe de quem escreveu o teste.
 *
 * Declarando `FetchImpl`, `mock.calls` vira `[string, RequestInit?][]` e a
 * inspecao dos argumentos passa a ser verificada pelo compilador.
 */
export function stubFetch(resposta: Response | (() => Promise<Response>)) {
  const impl: FetchImpl = async () =>
    typeof resposta === "function" ? resposta() : resposta;

  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Resposta JSON pronta, no formato que os backends devolvem. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Le a URL e as opcoes de uma chamada registrada pelo duble de `fetch`.
 *
 * Concentra aqui a unica assercao de tipo necessaria: o mock foi chamado, entao
 * a entrada existe - algo que o TypeScript nao consegue provar sozinho a partir
 * de um indice de array.
 */
export function chamadaFetch(
  mock: ReturnType<typeof stubFetch>,
  indice = 0,
): { url: string; init: RequestInit; headers: Headers } {
  const chamada = mock.mock.calls[indice];

  if (!chamada) {
    throw new Error(`O fetch nao foi chamado ${indice + 1} vez(es).`);
  }

  const [url, init = {}] = chamada;

  return {
    url,
    init,
    headers: new Headers(init.headers),
  };
}
