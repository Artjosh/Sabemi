# Instalação

Do clone até a stack no ar, acessível pelo celular.

## Requisito

**Docker** com Compose. Nada mais — .NET, Node e PostgreSQL rodam dentro dos
containers.

Para desenvolver fora do Docker, veja [Sem Docker](#sem-docker) no fim.

---

## 1. Clonar e configurar

```bash
git clone <url-do-repositorio>
cd TesteZallpy
cp .env.example .env
```

O `.env` já vem com valores que funcionam. Nada é obrigatório preencher para
subir — o envio de e-mail e o Supabase são opcionais, e estão em
[`CONFIGURACAO.md`](CONFIGURACAO.md).

## 2. Subir

```bash
node scripts/subir.mjs
```

Detecta o IP desta máquina na rede, sobe tudo e imprime os endereços. As
migrations são aplicadas sozinhas.

Sem Node instalado, ou para ficar só em `localhost`:

```bash
docker compose up -d --wait
```

## 3. Abrir

O script imprime os dois endereços. Do computador **e do celular na mesma rede
Wi-Fi**:

| Serviço | URL |
| --- | --- |
| **Painel** | `http://<ip>:3000` |
| API .NET (Swagger) | `http://<ip>:8080/swagger` |
| Backend VINEXT | `http://<ip>:3000/api/bff/health` |

## 4. Entrar

Não há senha. Informe qualquer e-mail: o **link de acesso e o código de 6 dígitos
aparecem na própria tela**.

Abrir o link em **outro aparelho** também funciona — a aba original entra sozinha
pelo polling. É o fluxo cross-device, e é o motivo de o passo 2 detectar o IP: com
`localhost`, o link aberto no celular apontaria para o próprio celular.

O link também vai para o log: `docker compose logs api | grep ACESSO`.

## 5. Enviar um webhook

```bash
curl -X POST http://localhost:8080/webhooks/pagamento \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: sabemi-dev-api-key' \
  -d '{
    "id_transacao": "TRX-0001",
    "id_contrato":  "CTR-8823",
    "valor":         1249.90,
    "data_pagamento":"2026-09-01T13:45:00Z",
    "status":        "PAGO"
  }'
```

Responde `202` em milissegundos. Reenvie: responde `200` com `"duplicate": true`
e **não** reprocessa. Envie o mesmo `id_transacao` ao outro backend
(`:3000/api/bff/webhooks/pagamento`) e ele também responde `200` — a idempotência
vale para o sistema, não para cada metade.

---

## Acesso pela rede

As portas sempre foram publicadas em todas as interfaces; o que dependia de
configuração era o **link de acesso**, montado a partir de uma URL fixa.
`scripts/subir.mjs` resolve isso preenchendo `API_PUBLIC_URL` e
`FRONTEND_PUBLIC_URL` com o IP detectado.

**Se o celular não abrir**, é o firewall do sistema. Libere as portas 3000 e 8080
para a rede privada:

```powershell
# Windows, PowerShell como administrador
New-NetFirewallRule -DisplayName "Sabemi 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Sabemi 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -Profile Private
```

Para fixar um endereço — um domínio, ou um IP que não muda — preencha as duas
variáveis no `.env`. Havendo valor ali, o script o respeita em vez de detectar.

**Por que não derivar do cabeçalho `Host` da requisição**, que dispensaria a
detecção: cada backend monta o link para si mesmo, em portas diferentes (`:3000`
no VINEXT, `:8080` no .NET). O pedido de login chega ao .NET atravessando o
gateway pela rede interna do Docker, então o `Host` que ele enxerga é `api:8080`
— endereço que só existe entre containers. Detectar o IP uma vez, na subida,
acerta os dois backends e não depende de um cabeçalho que o cliente controla.

---

## Verificar que está tudo certo

```bash
bash scripts/smoke-test.sh
```

Percorre os endpoints principais dos dois backends. Para as suítes completas,
veja [`TESTES.md`](TESTES.md).

---

## Parar e limpar

```bash
docker compose down          # para tudo, mantém o banco
docker compose down -v       # apaga também o volume do PostgreSQL
```

---

## Sem Docker

Requisitos: **.NET SDK 10**, **Node 24+**, **pnpm**, e um PostgreSQL.

```bash
# 1. Banco
docker compose up -d postgres

# 2. Migrations (aplica no banco e confere o modelo do Prisma)
node scripts/migrar.mjs

# 3. Backend .NET — API (8080) e Worker, em terminais separados
cd backend-dotnet
dotnet run --project src/Sabemi.Api
dotnet run --project src/Sabemi.Worker

# 4. Frontend + backend VINEXT (3000)
cd frontend
pnpm install
cp .env.example .env
pnpm dev
```

> Não existe `prisma migrate` neste projeto. O EF Core é o dono do schema; o
> Prisma apenas o descreve. O script do passo 2 cuida dos dois lados.
