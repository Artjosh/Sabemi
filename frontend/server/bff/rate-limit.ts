/**
 * Limite de pedidos por janela fixa, para os endpoints de autenticação.
 *
 * <b>Paridade com o backend .NET</b>, que aplica `RequireRateLimiting("auth")`
 * em `/auth/magic-link`, `/auth/verify-otp` e `/auth/supabase/aprovar`. Mesmo
 * teto (`AUTH_RATE_LIMIT`), mesma janela de um minuto, mesmo `429` com o código
 * `rate_limited`.
 *
 * <b>Uma diferença que não dá para esconder.</b> O .NET particiona pelo endereço
 * do SOCKET (`Connection.RemoteIpAddress`) — o IP real de quem conectou, que o
 * cliente não escolhe. Neste runtime não há acesso ao socket: o IP só chega por
 * cabeçalho (`x-real-ip`, `x-forwarded-for`), que só existe atrás de um proxy e
 * que um cliente direto pode inventar.
 *
 * Daí as duas decisões abaixo:
 *
 *   * **Sem IP, não limita.** Um balde único compartilhado seria pior que nada:
 *     uma pessoa faria dez pedidos e trancaria todo mundo. Quem protege o caso
 *     que importa — o mesmo e-mail pedido em série — é a espera de reenvio em
 *     `auth-service.ts`, que não depende de IP nenhum.
 *   * **O cabeçalho é confiável na medida do proxy.** Atrás de um reverse proxy
 *     que sobrescreve `x-real-ip`, o limite vale. Sem proxy, quem quiser desviar
 *     troca o cabeçalho — é evasão, não escalada, e a espera de reenvio continua
 *     valendo.
 *
 * <b>Estado em memória</b>, como o do .NET. Com mais de uma instância cada uma
 * tem o próprio balde, e o teto efetivo multiplica. É aceitável para o que este
 * limite faz — atrasar força bruta, não contabilizar cota.
 */

/** Contagem de uma janela, por chave. */
interface Janela {
  contagem: number;
  expiraEm: number;
}

const janelas = new Map<string, Janela>();

/** Uma janela por minuto, igual à do .NET (`RateLimit:AuthWindow`). */
const JANELA_MS = 60_000;

/**
 * Registra um pedido e diz se ele passa.
 *
 * `chave` é o particionador — o IP do cliente. `teto` é quantos pedidos cabem na
 * janela.
 */
export function permitir(chave: string, teto: number, agoraMs = Date.now()): boolean {
  if (teto <= 0) return true;

  const atual = janelas.get(chave);

  if (!atual || atual.expiraEm <= agoraMs) {
    janelas.set(chave, { contagem: 1, expiraEm: agoraMs + JANELA_MS });
    limparVencidas(agoraMs);
    return true;
  }

  atual.contagem += 1;
  return atual.contagem <= teto;
}

/**
 * Descarta janelas vencidas.
 *
 * Sem isto o `Map` cresceria para sempre num servidor de vida longa: uma entrada
 * por IP visto, nunca removida. Roda só quando uma janela nova é aberta, o que
 * mantém o custo proporcional ao tráfego real.
 */
function limparVencidas(agoraMs: number): void {
  if (janelas.size < 1000) return;

  for (const [chave, janela] of janelas) {
    if (janela.expiraEm <= agoraMs) janelas.delete(chave);
  }
}

/** Esquece tudo. Existe para os testes não vazarem contagem entre si. */
export function reiniciarLimites(): void {
  janelas.clear();
}

/**
 * IP do cliente, ou `null` quando não há como saber.
 *
 * A ordem segue a do próprio runtime: `cf-connecting-ip` (posto pela Cloudflare,
 * que descarta o que o cliente mandar), depois `x-real-ip`, depois o primeiro
 * salto de `x-forwarded-for`.
 */
export function ipDoCliente(headers: Headers): string | null {
  const encaminhado = headers.get("x-forwarded-for")?.split(",")[0]?.trim();

  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    (encaminhado ? encaminhado : null)
  );
}
