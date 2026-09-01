# Sabemi · Webhooks de Pagamento

Serviço de recebimento de notificações de pagamento com **idempotência garantida
no banco**, **processamento assíncrono resiliente** e **painel administrativo**.

A mesma aplicação roda sobre **dois backends independentes** — .NET (primário) e
VINEXT/BFF — alternáveis por um botão na interface.

📄 Arquitetura e decisões técnicas: [`docs/APRESENTACAO.md`](docs/APRESENTACAO.md)

---

## Subir tudo (recomendado)

Requisito: **Docker**.

```bash
git clone <url-do-repositorio>
cd TesteZallpy
docker compose up --build
```

| Serviço            | URL                                     |
| ------------------ | --------------------------------------- |
| Painel             | <http://localhost:3000>                 |
| API .NET (Swagger) | <http://localhost:8080/swagger>         |
| Backend VINEXT     | <http://localhost:3000/api/bff/health>  |

As migrations dos dois schemas são aplicadas automaticamente na subida.

### Entrar no painel

Não há senha. Informe qualquer e-mail e o **link de acesso aparece na própria
tela** (atalho de desenvolvimento) — clique nele ou digite o código de 6 dígitos.
O link também vai para o log: `docker compose logs api | grep ACESSO`.

> Abrir o link em **outro aparelho** também funciona: a aba original entra
> sozinha pelo polling. Em produção os códigos nunca são exibidos.

### Enviar um webhook

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

Responde `202` em milissegundos. Reenvie o mesmo comando: responde `200` com
`"duplicate": true` e **não** reprocessa. Acompanhe no painel.

---

## Desenvolvimento local (sem Docker)

Requisitos: **.NET SDK 10**, **Node 24+**, **pnpm**, e um PostgreSQL.

```bash
# 1. Banco
docker compose up -d postgres

# 2. Backend .NET — API (porta 8080) e Worker, em terminais separados
cd backend-dotnet
dotnet run --project src/Sabemi.Api
dotnet run --project src/Sabemi.Worker

# 3. Frontend + backend VINEXT (porta 3000)
cd frontend
pnpm install
cp .env.example .env
pnpm prisma migrate deploy
pnpm dev
```

---

## Variáveis de ambiente

Copie `.env.example` para `.env`. Tudo tem padrão de desenvolvimento; o compose
sobe sem configurar nada.

| Variável                   | Para que serve                                                    |
| -------------------------- | ----------------------------------------------------------------- |
| `JWT_SECRET`               | Assina a sessão. Mín. 32 caracteres, **o mesmo nos dois backends** |
| `WEBHOOK_API_KEY`          | Valor esperado no header `X-Api-Key`                              |
| `WEBHOOK_SIGNATURE_SECRET` | Segredo do HMAC-SHA256 (`X-Signature`). Vazio desliga             |
| `WEBHOOK_REQUIRE_SIGNATURE`| `true` exige assinatura em toda chamada                           |
| `POSTGRES_*`               | Credenciais e porta do banco                                       |
| `API_PUBLIC_URL`           | Base do link de acesso — precisa ser alcançável pelo navegador    |
| `FRONTEND_PUBLIC_URL`      | Idem, para o backend VINEXT                                       |
| `PROCESSING_*`             | Duração da regra simulada, tamanho do lote, tentativas            |

Em produção, `docker-compose.prod.yml` **recusa subir** sem os segredos reais.

---

## Testes

```bash
# Backend .NET — 158 testes (unidade + integração com PostgreSQL real)
cd backend-dotnet
dotnet test Sabemi.slnx --settings coverlet.runsettings --results-directory TestResults
python scripts/check-coverage.py TestResults --min 80

# Frontend + BFF — 249 testes. Precisa do PostgreSQL no ar
cd frontend
pnpm test              # sem cobertura
pnpm test:coverage     # com o limiar de 80% aplicado
```

Os testes de integração sobem PostgreSQL sozinhos via **Testcontainers**; basta
ter Docker. O limiar de 80% é verificado nos dois lados e **o CI falha abaixo
dele**.

Com a stack no ar, o teste de fumaça exercita a fiação real (containers, rede,
migrations, worker em outro processo):

```bash
docker compose up -d --wait
bash scripts/smoke-test.sh
```

---

## Deploy

O CI publica três imagens no GitHub Container Registry a cada push na `main`:
`api`, `worker` e `frontend` (multi-arquitetura, com SBOM e proveniência).

No servidor de destino:

```bash
export IMAGE_PREFIX=<owner>/<repo>
export JWT_SECRET=<segredo com 32+ caracteres>
export WEBHOOK_API_KEY=<chave combinada com o parceiro>
export WEBHOOK_SIGNATURE_SECRET=<segredo do HMAC>
export POSTGRES_PASSWORD=<senha forte>
export API_PUBLIC_URL=https://api.seu-dominio
export FRONTEND_PUBLIC_URL=https://painel.seu-dominio

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build
```

Para o deploy automático por SSH, configure os segredos do repositório
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` e
`DEPLOY_API_URL`. Sem eles, o workflow publica as imagens e informa que não há
alvo configurado.

A sobreposição de produção usa imagens em vez de build, fecha a porta do
PostgreSQL, exige assinatura HMAC, sobe duas réplicas do worker e nunca expõe os
códigos de login.

### Escalar o processamento

```bash
docker compose up -d --scale worker=3
```

As réplicas consomem a mesma fila sem conflito — a reivindicação usa
`FOR UPDATE SKIP LOCKED`.

---

## Estrutura

```
contracts/openapi.yaml   Contrato único que os dois backends implementam
backend-dotnet/          Backend primário — ASP.NET Core, EF Core, worker próprio
frontend/                Interface VINEXT + backend alternativo (BFF, Prisma)
docs/APRESENTACAO.md     Arquitetura e decisões técnicas
scripts/smoke-test.sh    Verificação da stack em execução
```
