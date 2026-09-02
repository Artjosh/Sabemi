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

until node -e "
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect()
    .then(() => c.query(\"SELECT to_regclass('sabemi.payment_events') IS NOT NULL AS pronto\"))
    .then(r => { c.end(); process.exit(r.rows[0].pronto ? 0 : 1); })
    .catch(() => process.exit(1));
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
