import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import type { LoginStatusDto } from "@/lib/contracts";
import { getAdapter } from "@/server/backends/registry";
import { BACKEND_COOKIE, SESSION_COOKIE, resolveBackend, sessionCookieOptions } from "@/server/session";

/**
 * Conclusao do login - onde o token vira cookie e some do alcance do browser.
 *
 * Tres passos, todos no servidor:
 *
 *   * `?step=start` - inicia o pedido e devolve o `selector` para o polling.
 *   * `?step=poll`  - o polling em si. Enquanto pendente devolve `{status:"pending"}`;
 *                     quando aprovado, GRAVA O COOKIE e devolve so o usuario.
 *   * `?step=otp`   - valida o codigo de 6 digitos, com o mesmo desfecho.
 *
 * <b>O detalhe que define a seguranca do fluxo.</b> O backend devolve
 * `access_token` no corpo. Este handler o intercepta, grava em cookie
 * `httpOnly` e o REMOVE da resposta que segue para o browser. O cliente recebe
 * apenas `{ status, user }` - nunca o token. Repassar o corpo do backend
 * direto, mesmo sem o cliente usar o campo, deixaria o token no
 * `response.json()` ao alcance de qualquer script.
 *
 * Funciona identicamente nos dois backends, porque os dois cumprem o mesmo
 * contrato de login.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const step = request.nextUrl.searchParams.get("step") ?? "poll";

  const jar = await cookies();
  const backendId = resolveBackend(jar.get(BACKEND_COOKIE)?.value);
  const adapter = getAdapter(backendId);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "JSON invalido.", code: "malformed_json" }, { status: 400 });
  }

  if (step === "start") {
    const resposta = await adapter.handle({
      method: "POST",
      path: "auth/magic-link",
      searchParams: new URLSearchParams(),
      rawBody: JSON.stringify({ email: body.email }),
      headers: new Headers(),
      token: null,
    });

    return NextResponse.json(resposta.body, { status: resposta.status });
  }

  if (step === "otp") {
    const resposta = await adapter.handle({
      method: "POST",
      path: "auth/verify-otp",
      searchParams: new URLSearchParams(),
      rawBody: JSON.stringify({ selector: body.selector, code: body.code }),
      headers: new Headers(),
      token: null,
    });

    return finalizeLogin(resposta.status, resposta.body, backendId);
  }

  if (step === "poll") {
    const selector = String(body.selector ?? "");
    const resposta = await adapter.handle({
      method: "POST",
      path: "auth/login-status",
      searchParams: new URLSearchParams({ selector }),
      rawBody: JSON.stringify({ selector }),
      headers: new Headers(),
      token: null,
    });

    return finalizeLogin(resposta.status, resposta.body, backendId);
  }

  return NextResponse.json({ detail: "Step invalido.", code: "invalid_step" }, { status: 400 });
}

/**
 * Grava a sessao quando aprovada e devolve ao browser um corpo SEM o token.
 */
async function finalizeLogin(
  status: number,
  body: unknown,
  backendId: string,
): Promise<NextResponse> {
  if (status >= 400) {
    return NextResponse.json(body, { status });
  }

  const resultado = body as LoginStatusDto;

  // Ainda pendente: o cliente continua o polling.
  if (resultado.status !== "approved" || !resultado.access_token) {
    return NextResponse.json({ status: resultado.status, authenticated: false }, { status: 200 });
  }

  const jar = await cookies();
  jar.set(
    SESSION_COOKIE,
    resultado.access_token,
    sessionCookieOptions(resultado.expires_in ?? 60 * 60 * 24),
  );

  // O token fica de fora do corpo, deliberadamente.
  return NextResponse.json(
    {
      status: "approved",
      authenticated: true,
      user: resultado.user ?? null,
      backend: backendId,
    },
    { status: 200 },
  );
}
