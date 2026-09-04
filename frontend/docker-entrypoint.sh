#!/bin/sh
#
# Entrypoint do container VINEXT.
#
# NAO aplica migrations. Os dois backends compartilham o schema `sabemi`, e quem
# e dono das migrations e o EF Core - a API as aplica na subida.
#
# O que este entrypoint faz e ESPERAR o schema existir. Sem isso, o BFF subiria
# antes da API migrar e falharia na primeira consulta, com um erro de tabela
# inexistente que parece bug de codigo.
#
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] ERRO: DATABASE_URL nao configurada." >&2
  exit 1
fi

# O PostgreSQL pode ainda estar subindo. O healthcheck do compose ja cobre isso,
# mas o container tambem precisa se defender quando roda fora dele.
echo "[entrypoint] Aguardando o schema 'sabemi' (migrado pela API .NET)..."

tentativa=1
maximo=60

# A sonda imprime o erro em vez de engoli-lo. A versao anterior tinha um
# `.catch(() => process.exit(1))` mudo, e por isso uma falha de CONEXAO aparecia
# como "schema ainda nao pronto" - a mensagem mandava conferir se a API migrou,
# quando o problema era o certificado do banco. Sessenta tentativas depois, o
# container morria acusando o serviço errado.
#
# `rejectUnauthorized: false` acompanha a semantica do libpq para `sslmode=require`
# (cifrar sem validar a cadeia), que e a mesma do backend .NET e a que o pooler do
# Supabase exige. Ver `server/bff/db.ts`.
until node -e "
  const { Client } = require('pg');
  const url = new URL(process.env.DATABASE_URL);
  const modo = url.searchParams.get('sslmode');
  const local = ['localhost','127.0.0.1','::1','postgres','db'].includes(url.hostname);
  const ssl = modo === 'disable' || (!modo && local)
    ? false
    : { rejectUnauthorized: modo === 'verify-full' || modo === 'verify-ca' };
  // O \`sslmode\` da connection string VENCE a opcao \`ssl\` passada ao lado, entao
  // ele sai da URL: sem isso o \`require\` continuaria valendo como verify-full e
  // a opcao abaixo seria ignorada em silencio.
  url.searchParams.delete('sslmode');
  const c = new Client({ connectionString: url.toString(), ssl });
  c.connect()
    .then(() => c.query(\"SELECT to_regclass('sabemi.payment_events') IS NOT NULL AS pronto\"))
    .then(r => { c.end(); process.exit(r.rows[0].pronto ? 0 : 1); })
    .catch(e => { console.error('[entrypoint] sonda falhou:', e.message); process.exit(1); });
"; do
  if [ "$tentativa" -ge "$maximo" ]; then
    echo "[entrypoint] ERRO: o schema nao ficou pronto apos ${maximo} tentativas." >&2
    echo "[entrypoint] Verifique se o serviço 'api' subiu e aplicou as migrations." >&2
    exit 1
  fi

  echo "[entrypoint] Schema ainda nao pronto; nova tentativa em 2s (${tentativa}/${maximo})."
  tentativa=$((tentativa + 1))
  sleep 2
done

echo "[entrypoint] Schema pronto. Iniciando o servidor."

# `exec` substitui o shell pelo processo do Node, para que ele receba SIGTERM
# diretamente. Sem isso, o shell seria o PID 1 e o `docker stop` esperaria o
# timeout inteiro antes de matar o processo a forca.
exec "$@"
