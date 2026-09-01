import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { getAdapter } from "@/server/backends/registry";
import { BACKEND_COOKIE, SESSION_COOKIE, resolveBackend } from "@/server/session";

/**
 * Gateway same-origin: unico endereco que a interface conhece.
 *
 * Toda chamada de dados do dashboard passa por aqui - `GET /api/gateway/payments`,
 * `GET /api/gateway/payments/summary`, e assim por diante. O handler:
 *
 *   1. le o backend selecionado (cookie) e escolhe o adapter;
 *   2. le o JWT da sessao do cookie httpOnly e o entrega ao adapter;
 *   3. devolve a resposta como veio.
 *
 * <b>Por que isso importa para a troca de backend.</b> A interface nao monta
 * URLs de backend, nao guarda tokens e nao sabe qual implementacao esta ativa.
 * Trocar de backend e trocar um cookie: a proxima requisicao ja sai pelo outro
 * adapter, sem recarregar a aplicacao e sem uma linha de condicional na UI.
 *
 * <b>Por que o token nao vai para o browser.</b> Ele e lido aqui, no servidor, a
 * partir de um cookie que o JavaScript nao enxerga. Um XSS no dashboard nao tem
 * o que roubar.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: NextRequest, segments: string[]): Promise<NextResponse> {
  const jar = await cookies();

  const backendId = resolveBackend(jar.get(BACKEND_COOKIE)?.value);
  const adapter = getAdapter(backendId);
  const token = jar.get(SESSION_COOKIE)?.value ?? null;

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const resposta = await adapter.handle({
    method,
    path: segments.join("/"),
    searchParams: request.nextUrl.searchParams,
    rawBody: hasBody ? await request.text() : "",
    headers: request.headers,
    token,
  });

  const res =
    resposta.contentType?.includes("text/html") && typeof resposta.body === "string"
      ? new NextResponse(resposta.body, {
          status: resposta.status,
          headers: { "content-type": resposta.contentType },
        })
      : NextResponse.json(resposta.body, { status: resposta.status });

  // Deixa explicito quem respondeu. E o que permite ao dashboard confirmar a
  // troca na tela, e a um teste verificar que ela nao e apenas cosmetica.
  res.headers.set("x-sabemi-backend", backendId);

  return res;
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  return handle(request, (await ctx.params).path);
}
export async function POST(request: NextRequest, ctx: Ctx) {
  return handle(request, (await ctx.params).path);
}
export async function PUT(request: NextRequest, ctx: Ctx) {
  return handle(request, (await ctx.params).path);
}
export async function PATCH(request: NextRequest, ctx: Ctx) {
  return handle(request, (await ctx.params).path);
}
export async function DELETE(request: NextRequest, ctx: Ctx) {
  return handle(request, (await ctx.params).path);
}
