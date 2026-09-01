import { NextResponse, type NextRequest } from "next/server";

import { handleBffRequest } from "@/server/bff/router";

/**
 * Acesso HTTP direto ao backend VINEXT.
 *
 * O gateway chama este backend em processo, sem passar por aqui. Esta rota
 * existe para os casos em que o chamador nao e a interface:
 *
 *   * o banco parceiro entregando o webhook em
 *     `POST /api/bff/webhooks/pagamento`;
 *   * o link do e-mail sendo aberto em `GET /api/bff/auth/confirm`, possivelmente
 *     em outro aparelho;
 *   * a demonstracao do backend isoladamente, sem a interface no caminho.
 *
 * Os dois caminhos - HTTP e em processo - despacham para
 * {@link handleBffRequest}. E o mesmo codigo executando; nao ha uma versao "web"
 * e outra "interna" que possam divergir.
 *
 * A autenticacao aqui vem do proprio contrato: o webhook valida ApiKey/HMAC, e
 * as rotas do dashboard exigem `Authorization: Bearer`. O cookie httpOnly nao e
 * lido nesta rota de proposito - quem usa cookie e a interface, e a interface
 * passa pelo gateway.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: NextRequest, segments: string[]): Promise<NextResponse> {
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  // O corpo e lido como texto, nao como JSON: a assinatura HMAC e calculada
  // sobre os bytes exatos que chegaram. Reserializar mudaria espacos e ordem de
  // chaves, e nenhuma assinatura valida conferiria.
  const rawBody = hasBody ? await request.text() : "";

  const authorization = request.headers.get("authorization");
  const token = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : null;

  const resposta = await handleBffRequest({
    method,
    path: segments.join("/"),
    searchParams: request.nextUrl.searchParams,
    rawBody,
    headers: request.headers,
    token,
  });

  if (resposta.contentType?.includes("text/html") && typeof resposta.body === "string") {
    return new NextResponse(resposta.body, {
      status: resposta.status,
      headers: { "content-type": resposta.contentType },
    });
  }

  const res = NextResponse.json(resposta.body, { status: resposta.status });
  res.headers.set("x-sabemi-backend", "vinext");
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
