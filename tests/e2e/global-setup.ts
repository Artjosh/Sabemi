/**
 * Verifica que a stack esta no ar ANTES de coletar os testes.
 *
 * <b>Por que existe.</b> Sem a stack, os 50 testes falham em cascata com erros
 * de conexao que nao dizem o que fazer. Uma consulta, no processo principal,
 * antes da coleta, troca isso por uma mensagem com o comando que resolve.
 *
 * <b>Por que nao verifica mais provedor de e-mail.</b> Verificava: houve uma
 * versao em que os testes de login eram PULADOS quando havia provedor
 * configurado, porque a suite autenticava com enderecos inventados em dominio
 * real e cada login virava um hard bounce.
 *
 * Isso era contornar o problema. Hoje a suite usa `@e2e.invalid` (ver
 * `emailDeTeste`, em support.ts) e os dois backends recusam entrega em dominio
 * reservado por RFC antes de chamar o provedor. Nao ha envio a evitar, entao
 * nao ha nada a pular - os 50 rodam sempre, com provedor ligado ou nao.
 */

const WEB = process.env.E2E_WEB_URL ?? "http://localhost:3000";
const API = process.env.E2E_API_URL ?? "http://localhost:8080";

async function respondeu(url: string): Promise<boolean> {
  try {
    const resposta = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return resposta.ok;
  } catch {
    return false;
  }
}

export default async function setup() {
  const [bff, dotnet] = await Promise.all([
    respondeu(`${WEB}/api/bff/health`),
    respondeu(`${API}/health`),
  ]);

  if (bff && dotnet) return;

  const quais = [!dotnet && `API .NET (${API})`, !bff && `BFF (${WEB})`]
    .filter(Boolean)
    .join(" e ");

  throw new Error(
    `A stack não respondeu: ${quais}.\n\n` +
      "Suba antes de rodar a suíte:\n" +
      "  AUTH_RATE_LIMIT=500 docker compose up -d --wait",
  );
}
