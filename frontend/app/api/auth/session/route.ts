import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getAdapter } from "@/server/backends/registry";
import { BACKEND_COOKIE, SESSION_COOKIE, resolveBackend } from "@/server/session";

/**
 * Ciclo de vida da sessao do browser.
 *
 *   * `GET`    - restaura a sessao no F5. Le o cookie httpOnly, pergunta
 *                `auth/me` ao backend ativo e devolve o usuario.
 *   * `DELETE` - encerra a sessao apagando o cookie.
 *
 * O `GET` e o que permite ao provider de autenticacao do cliente saber quem
 * esta logado sem nunca ver o token: ele recebe apenas o objeto do usuario.
 *
 * A validacao e sempre delegada ao backend, e nao feita aqui. E ele quem detem
 * a verdade sobre a sessao; um token expirado ou revogado precisa ser recusado
 * por quem o emitiu, nao por uma decodificacao local que ignoraria uma revogacao.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (!token) {
    return NextResponse.json({ detail: "Sem sessao.", code: "no_session" }, { status: 401 });
  }

  const backendId = resolveBackend(jar.get(BACKEND_COOKIE)?.value);
  const adapter = getAdapter(backendId);

  const resposta = await adapter.handle({
    method: "GET",
    path: "auth/me",
    searchParams: new URLSearchParams(),
    rawBody: "",
    headers: new Headers(),
    token,
  });

  if (resposta.status >= 400) {
    // Sessao invalida: apaga o cookie para o cliente parar de tentar usa-lo a
    // cada carga de pagina.
    jar.delete(SESSION_COOKIE);
    return NextResponse.json(resposta.body, { status: resposta.status });
  }

  return NextResponse.json({ user: resposta.body, backend: backendId }, { status: 200 });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true }, { status: 200 });
}
