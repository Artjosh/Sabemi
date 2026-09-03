#!/usr/bin/env bash
#
# Teste de fumaca da stack em execucao.
#
# POR QUE ELE EXISTE
# ------------------
# As suites de teste exercitam cada peca a fundo, mas todas rodam com a
# aplicacao montada pelo proprio processo de teste. Este script e o unico que
# exercita a FIACAO REAL: containers separados, rede do Docker, migrations
# aplicadas na subida, o worker em outro processo.
#
# E o que pega a classe de defeito que nenhum teste unitario ou de integracao
# alcanca - variavel de ambiente com o nome errado, serviço apontando para
# `localhost` em vez do nome do container, migration que nao roda no entrypoint.
# Tudo verde e a aplicacao no ar sem funcionar.
#
# Uso:
#   docker compose up -d --wait
#   bash scripts/smoke-test.sh
#
set -euo pipefail

API="${API_URL:-http://localhost:8080}"
WEB="${FRONTEND_URL:-http://localhost:3000}"
API_KEY="${WEBHOOK_API_KEY:-sabemi-dev-api-key}"

falhas=0
sufixo="$(date +%s)"

verde() { printf '\033[32m  OK\033[0m   %s\n' "$1"; }
vermelho() { printf '\033[31m  FALHOU\033[0m %s\n' "$1"; falhas=$((falhas + 1)); }
secao() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Consulta o banco da stack.
#
# As credenciais vem do ambiente porque elas MUDARAM: o banco passou a ser o
# `supabase/postgres`, cujo superusuario e `postgres`, e o schema da aplicacao
# virou `sabemi` (antes eram dois: `dotnet` e `vinext`). Um script com o usuario
# antigo escrito a mao falharia com "database does not exist" - que parece um
# problema da stack, e nao do proprio script.
psql_sabemi() {
  docker compose exec -T postgres     psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -tAc "$1"     2>/dev/null
}

# Compara o codigo HTTP obtido com o esperado.
checar() {
  local descricao="$1" esperado="$2" obtido="$3"
  if [ "$obtido" = "$esperado" ]; then
    verde "$descricao (HTTP $obtido)"
  else
    vermelho "$descricao (esperado $esperado, obtido $obtido)"
  fi
}

# Monta um payload de pagamento valido.
payload() {
  cat <<JSON
{"id_transacao":"$1","id_contrato":"$2","valor":${3:-100.00},"data_pagamento":"2026-08-01T10:00:00Z","status":"${4:-PAGO}"}
JSON
}

# ---------------------------------------------------------------- disponibilidade

secao "Disponibilidade dos servicos"

checar "API .NET responde /health" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")"

checar "Frontend responde" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/")"

checar "Backend VINEXT responde /health" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/api/bff/health")"

# Cada backend precisa se declarar corretamente: e o que o dashboard usa para
# confirmar qual implementacao respondeu depois de uma troca.
if curl -s "$API/health" | grep -q '"backend":"dotnet"'; then
  verde "A API .NET se identifica como 'dotnet'"
else
  vermelho "A API .NET nao se identificou corretamente"
fi

if curl -s "$WEB/api/bff/health" | grep -q '"backend":"vinext"'; then
  verde "O BFF se identifica como 'vinext'"
else
  vermelho "O BFF nao se identificou corretamente"
fi

# ---------------------------------------------------------------------- seguranca

secao "Seguranca do webhook"

checar "Sem X-Api-Key devolve 401 (.NET)" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/webhooks/pagamento" \
     -H 'Content-Type: application/json' -d "$(payload "SEC-$sufixo" CTR-SEC)")"

checar "Com X-Api-Key errada devolve 401 (.NET)" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/webhooks/pagamento" \
     -H 'Content-Type: application/json' -H 'X-Api-Key: errada' \
     -d "$(payload "SEC2-$sufixo" CTR-SEC)")"

checar "Sem X-Api-Key devolve 401 (VINEXT)" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEB/api/bff/webhooks/pagamento" \
     -H 'Content-Type: application/json' -d "$(payload "SEC3-$sufixo" CTR-SEC)")"

checar "Dashboard sem sessao devolve 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/payments")"

# -------------------------------------------------------- ingestao e idempotencia

secao "Ingestao e idempotencia"

for backend in dotnet vinext; do
  if [ "$backend" = "dotnet" ]; then
    url="$API/webhooks/pagamento"
  else
    url="$WEB/api/bff/webhooks/pagamento"
  fi

  trx="IDEM-${backend}-${sufixo}"
  corpo="$(payload "$trx" "CTR-${backend}" 250.75)"

  checar "[$backend] primeira entrega devolve 202" 202 \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url" \
       -H 'Content-Type: application/json' -H "X-Api-Key: $API_KEY" -d "$corpo")"

  checar "[$backend] reentrega devolve 200" 200 \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url" \
       -H 'Content-Type: application/json' -H "X-Api-Key: $API_KEY" -d "$corpo")"

  if curl -s -X POST "$url" -H 'Content-Type: application/json' \
       -H "X-Api-Key: $API_KEY" -d "$corpo" | grep -q '"duplicate":true'; then
    verde "[$backend] a reentrega e marcada como duplicada"
  else
    vermelho "[$backend] a reentrega nao foi marcada como duplicada"
  fi

  checar "[$backend] payload invalido devolve 400" 400 \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url" \
       -H 'Content-Type: application/json' -H "X-Api-Key: $API_KEY" \
       -d "$(payload "BAD-${backend}-${sufixo}" '' -1 XPTO)")"
done

# ------------------------------------------------------- resposta rapida do webhook

secao "Resposta rapida (a regra de ~2s nao bloqueia)"

tempo="$(curl -s -o /dev/null -w '%{time_total}' -X POST "$API/webhooks/pagamento" \
  -H 'Content-Type: application/json' -H "X-Api-Key: $API_KEY" \
  -d "$(payload "FAST-$sufixo" CTR-FAST)")"

# `bc` nem sempre existe no runner; a comparacao e feita com awk.
if awk -v t="$tempo" 'BEGIN { exit !(t < 1.5) }'; then
  verde "O webhook respondeu em ${tempo}s (regra de 2s roda em background)"
else
  vermelho "O webhook demorou ${tempo}s - a regra pode estar bloqueando a resposta"
fi

# ----------------------------------------------------- processamento em background

secao "Processamento em background"

trx="PROC-$sufixo"
curl -s -o /dev/null -X POST "$API/webhooks/pagamento" \
  -H 'Content-Type: application/json' -H "X-Api-Key: $API_KEY" \
  -d "$(payload "$trx" "CTR-PROC-$sufixo" 99.99)"

# O processamento roda em OUTRO processo: a espera precisa ser por sondagem.
#
# Nao se afirma QUAL worker processou, e isso mudou de proposito. Com o schema
# compartilhado, o worker .NET e o laco do BFF consomem a MESMA fila - quem
# reivindica primeiro e uma corrida legitima, e exigir um deles especificamente
# faria este teste falhar de forma intermitente por um comportamento correto.
#
# O que importa e que o trabalho enfileirado por um processo foi concluido por
# outro. Qual dos dois nao muda o resultado para quem opera.
processado=0
for _ in $(seq 1 30); do
  if psql_sabemi \
       "SELECT status_processamento FROM sabemi.payment_events WHERE id_transacao = '$trx'" \
       | grep -qi 'SUCESSO'; then
    processado=1
    break
  fi
  sleep 2
done

if [ "$processado" = "1" ]; then
  verde "O evento foi processado em background e o job foi concluido"
else
  vermelho "O evento nao foi processado em 60s"
fi

# O efeito colateral tambem precisa ter acontecido: evento processado com
# contrato desatualizado seria uma transacao pela metade.
total="$(psql_sabemi \
  "SELECT valor_total_liquidado FROM sabemi.contract_statuses WHERE id_contrato = 'CTR-PROC-$sufixo'" \
  | tr -d ' 
')"

if [ "$total" = "99.99" ]; then
  verde "O contrato foi consolidado com o valor correto ($total)"
else
  vermelho "O contrato ficou com valor inesperado: '${total:-vazio}'"
fi

# ---------------------------------------------------------------- autenticacao

secao "Autenticacao por polling"

inicio="$(curl -s -X POST "$API/auth/magic-link" \
  -H 'Content-Type: application/json' -d '{"email":"smoke@sabemi.com.br"}')"

selector="$(printf '%s' "$inicio" | sed -n 's/.*"selector":"\([^"]*\)".*/\1/p')"

if [ -n "$selector" ]; then
  verde "O pedido de login devolveu um selector"
else
  vermelho "O pedido de login nao devolveu selector"
fi

if curl -s -X POST "$API/auth/login-status?selector=$selector" | grep -q '"status":"pending"'; then
  verde "O polling responde 'pending' antes da confirmacao"
else
  vermelho "O polling nao respondeu 'pending'"
fi

checar "Selector inexistente encerra o polling com 404" 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login-status?selector=nao-existe")"

# ------------------------------------------------------------- troca de backend

secao "Troca de backend"

jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

if curl -s -c "$jar" "$WEB/api/backend" | grep -q '"active":"dotnet"'; then
  verde "O backend primario e o .NET"
else
  vermelho "O backend primario nao e o .NET"
fi

curl -s -c "$jar" -b "$jar" -o /dev/null -X POST "$WEB/api/backend" \
  -H 'Content-Type: application/json' -d '{"backend":"vinext"}'

# O header do gateway declara quem REALMENTE respondeu - nao quem foi pedido.
respondeu="$(curl -s -c "$jar" -b "$jar" -D - -o /dev/null "$WEB/api/gateway/health" \
  | tr -d '\r' | sed -n 's/^[Xx]-[Ss]abemi-[Bb]ackend: //p')"

if [ "$respondeu" = "vinext" ]; then
  verde "Apos a troca, o gateway despacha para o VINEXT"
else
  vermelho "Apos a troca, o gateway respondeu por '${respondeu:-desconhecido}'"
fi

curl -s -c "$jar" -b "$jar" -o /dev/null -X POST "$WEB/api/backend" \
  -H 'Content-Type: application/json' -d '{"backend":"dotnet"}'

respondeu="$(curl -s -c "$jar" -b "$jar" -D - -o /dev/null "$WEB/api/gateway/health" \
  | tr -d '\r' | sed -n 's/^[Xx]-[Ss]abemi-[Bb]ackend: //p')"

if [ "$respondeu" = "dotnet" ]; then
  verde "A troca de volta para o .NET tambem funciona"
else
  vermelho "A troca de volta respondeu por '${respondeu:-desconhecido}'"
fi

checar "Backend invalido e recusado" 400 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEB/api/backend" \
     -H 'Content-Type: application/json' -d '{"backend":"inventado"}')"

# ------------------------------------------------------------------- resultado

secao "Resultado"

if [ "$falhas" -eq 0 ]; then
  printf '\033[32mTodas as verificacoes passaram.\033[0m\n'
  exit 0
fi

printf '\033[31m%d verificacao(oes) falharam.\033[0m\n' "$falhas"
exit 1
