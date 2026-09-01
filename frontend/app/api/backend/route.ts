import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { DEFAULT_BACKEND, getAdapter, isBackendId, listBackends } from "@/server/backends/registry";
import {
  BACKEND_COOKIE,
  SESSION_COOKIE,
  backendCookieOptions,
  resolveBackend,
} from "@/server/session";

/**
 * Seletor de backend.
 *
 *   * `GET`  - qual esta ativo, quais existem e se cada um responde.
 *   * `POST` - troca o backend ativo.
 *
 * <b>Por que a troca encerra a sessao.</b> Cada backend tem o proprio banco - o
 * .NET e dono do schema `dotnet`, o VINEXT do `vinext`. O usuario criado em um
 * nao existe no outro, e o `sub` do JWT aponta para um identificador que o novo
 * backend nao conhece. Manter o cookie produziria uma sessao que parece valida
 * e falha na primeira consulta, com um 401 sem explicacao.
 *
 * Apagar o cookie na troca torna a consequencia imediata e legivel: o operador
 * volta para a tela de login e entra no backend que escolheu. A interface avisa
 * disso antes de trocar.
 *
 * Essa e a decisao arquitetural que mantem a troca HONESTA: os dois backends
 * sao de fato independentes, e nao duas fachadas sobre o mesmo banco.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const jar = await cookies();
  const ativo = resolveBackend(jar.get(BACKEND_COOKIE)?.value);

  // Consulta a saude de cada backend em paralelo: o seletor mostra quais estao
  // no ar antes de o operador tentar trocar para um que esta fora.
  const backends = await Promise.all(
    listBackends().map(async (meta) => {
      try {
        const resposta = await getAdapter(meta.id).handle({
          method: "GET",
          path: "health",
          searchParams: new URLSearchParams(),
          rawBody: "",
          headers: new Headers(),
          token: null,
        });
        return { ...meta, online: resposta.status === 200 };
      } catch {
        return { ...meta, online: false };
      }
    }),
  );

  return NextResponse.json({ active: ativo, default: DEFAULT_BACKEND, backends });
}

export async function POST(request: NextRequest) {
  let body: { backend?: unknown };
  try {
    body = (await request.json()) as { backend?: unknown };
  } catch {
    return NextResponse.json({ detail: "JSON invalido.", code: "malformed_json" }, { status: 400 });
  }

  if (!isBackendId(body.backend)) {
    return NextResponse.json(
      { detail: "Backend invalido. Use 'dotnet' ou 'vinext'.", code: "invalid_backend" },
      { status: 400 },
    );
  }

  const jar = await cookies();
  const anterior = resolveBackend(jar.get(BACKEND_COOKIE)?.value);

  jar.set(BACKEND_COOKIE, body.backend, backendCookieOptions());

  // Sessao emitida pelo backend anterior nao vale no novo - ver acima.
  const sessaoEncerrada = anterior !== body.backend && jar.has(SESSION_COOKIE);
  if (sessaoEncerrada) {
    jar.delete(SESSION_COOKIE);
  }

  return NextResponse.json({
    active: body.backend,
    previous: anterior,
    session_cleared: sessaoEncerrada,
  });
}
