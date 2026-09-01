#!/bin/sh
#
# Entrypoint do container VINEXT.
#
# Aplica as migrations do schema `vinext` antes de servir. Este backend e o dono
# desse schema, entao ele e quem deve cria-lo - do mesmo modo que a API .NET e
# dona do schema `dotnet` e aplica as proprias migrations na subida.
#
# `migrate deploy` (e nao `migrate dev`): aplica o que ja existe e nunca gera
# migration nova nem pede confirmacao. E o comando desenhado para producao.
#
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] ERRO: DATABASE_URL nao configurada." >&2
  exit 1
fi

# O PostgreSQL pode ainda estar subindo. O healthcheck do compose ja cobre isso,
# mas o container tambem precisa se defender quando roda fora dele.
echo "[entrypoint] Aplicando migrations do schema 'vinext'..."

tentativa=1
maximo=30

until ./node_modules/.bin/prisma migrate deploy; do
  if [ "$tentativa" -ge "$maximo" ]; then
    echo "[entrypoint] ERRO: nao foi possivel aplicar as migrations apos ${maximo} tentativas." >&2
    exit 1
  fi

  echo "[entrypoint] Banco indisponivel; nova tentativa em 2s (${tentativa}/${maximo})."
  tentativa=$((tentativa + 1))
  sleep 2
done

echo "[entrypoint] Migrations aplicadas. Iniciando o servidor."

# `exec` substitui o shell pelo processo do Node, para que ele receba SIGTERM
# diretamente. Sem isso, o shell seria o PID 1 e o `docker stop` esperaria o
# timeout inteiro antes de matar o processo a forca.
exec "$@"
