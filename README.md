# Sabemi · Webhooks de Pagamento

Serviço de recebimento de notificações de pagamento com **idempotência garantida
no banco**, **processamento assíncrono resiliente** e **painel administrativo**.

A mesma aplicação roda sobre **dois backends independentes** — .NET (primário) e
VINEXT/BFF — alternáveis por um botão na interface. Os dois compartilham o mesmo
schema, então trocar de backend não troca os dados nem pede novo login.

📄 Arquitetura e decisões técnicas: [`docs/APRESENTACAO.md`](docs/APRESENTACAO.md)
🤝 Contexto para continuar o trabalho: [`docs/HANDOFF.md`](docs/HANDOFF.md)

---

## Subir tudo (recomendado)

Requisito: **Docker**.

```bash
git clone <url-do-repositorio>
cd TesteZallpy
cp .env.example .env
docker compose up --build
```

| Serviço             | URL                                     |
| ------------------- | --------------------------------------- |
| Painel              | <http://localhost:3000>                 |
| API .NET (Swagger)  | <http://localhost:8080/swagger>         |
| Backend VINEXT      | <http://localhost:3000/api/bff/health>  |
| Métricas — API      | <http://localhost:8080/metrics>         |
| Métricas — Worker   | <http://localhost:9464/metrics>         |
| Métricas — BFF      | <http://localhost:9465/metrics>         |

As migrations são aplicadas automaticamente na subida.

### Entrar no painel

Não há senha. Informe qualquer e-mail e o **link de acesso aparece na própria
tela** — clique nele ou digite o código de 6 dígitos. O link também vai para o
log: `docker compose logs api | grep ACESSO`.

> Abrir o link em **outro aparelho** também funciona: a aba original entra
> sozinha pelo polling.

Com `BREVO_API_KEY` configurada, o e-mail é enviado de verdade e o link deixa de
aparecer na tela. Em produção (`docker-compose.prod.yml`) os códigos nunca são
exibidos.

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
`"duplicate": true` e **não** reprocessa.

Envie o mesmo `id_transacao` para o **outro backend**
(`http://localhost:3000/api/bff/webhooks/pagamento`) e ele também responde `200`:
a idempotência vale para o sistema, não para cada metade.

---

## Modos opcionais

### Plataforma Supabase completa

Sobe GoTrue (Auth), Kong, PostgREST, `postgres-meta` e o Studio ao lado da stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.supabase.yml up -d
```

| Serviço          | URL                        |
| ---------------- | -------------------------- |
| Gateway (Kong)   | <http://localhost:54321>   |
| Studio           | <http://localhost:54323>   |

### Autenticação pelo GoTrue

```bash
AUTH_PROVIDER=supabase docker compose \
  -f docker-compose.yml -f docker-compose.supabase.yml up -d
```

O GoTrue passa a emitir o magic link, gerar o OTP, enviar o e-mail e validar o
código. O polling cross-device continua funcionando — o pedido de login com
`selector` permanece local, porque o GoTrue não tem esse conceito.

> Sem `SMTP_*` configurado, o link fica no log do container do GoTrue e **não**
> aparece na resposta: ele é montado dentro do GoTrue e nunca passa pela nossa
> aplicação.

### Tracing (Jaeger)

```bash
docker compose --profile observabilidade up -d
# e no .env:  OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

Interface em <http://localhost:16686>. Use `4318` (OTLP/HTTP), não `4317` (gRPC):
o exportador do BFF só fala HTTP.

---

## Apontar para um Supabase remoto

Uma linha no `.env`:

```bash
# Dashboard > Project Settings > Database > Connection string > URI
DATABASE_URL=postgresql://postgres.SEU_REF:SENHA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require
```

Depois:

```bash
node scripts/migrar.mjs        # aplica as migrations no banco remoto
docker compose up -d           # SEM o overlay do Supabase local
```

Os **dois backends** leem essa mesma variável — o .NET aceita o formato URL desde
`PostgresConnectionString`. Use a porta **5432** (conexão direta), e não 6543 (o
pooler em transaction mode não suporta DDL de migration).

TLS é exigido automaticamente para qualquer host que não seja local, mesmo sem
`sslmode` na URL.

---

## Desenvolvimento local (sem Docker)

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
> Prisma apenas o descreve. O script acima cuida dos dois lados.

---

## Configuração

Copie `.env.example` para `.env`. **Tudo tem padrão de desenvolvimento** — o
compose sobe sem você configurar nada. Há dois arquivos:

| Arquivo             | Quem lê                                                     |
| ------------------- | ----------------------------------------------------------- |
| `.env` (raiz)       | O Docker Compose, que repassa aos três containers            |
| `frontend/.env`     | Só quem roda `pnpm dev` **fora** do Docker                   |

Nenhuma variável do frontend pode receber o prefixo `NEXT_PUBLIC_`: são segredos
e configuração de servidor, e o prefixo as empacotaria no bundle do browser.

### Banco

| Variável | Para que serve |
| --- | --- |
| `DATABASE_URL` | Conexão — **a mesma para os dois backends** |
| `POSTGRES_*` | Superusuário. Usado pela plataforma Supabase e pelas migrations |
| `APP_DB_USER` / `APP_DB_PASSWORD` | Papel da aplicação. Os backends não usam `postgres` |

**`DATABASE_URL` vazia** faz o compose usar o Postgres desta stack. Preenchida,
ela vence — é assim que se aponta para um Supabase remoto (veja acima).

O .NET aceita tanto o formato URL quanto o nativo do Npgsql. Antes ele exigia
`ConnectionStrings__Postgres` em sintaxe própria, e apontar a stack para outro
banco significava transcrever a mesma informação em dois formatos — com um erro
de transcrição aparecendo como falha de autenticação em apenas um dos backends.

> **Não acrescente `?schema=` na URL.** O parâmetro é desnecessário (cada ORM
> qualifica as tabelas pelo schema do modelo) e o driver `pg` o interpretava como
> o **usuário** da conexão, produzindo
> `password authentication failed for user "sabemi"` — um erro que aponta para
> credenciais quando a causa é o parser da URL.

### Autenticação

| Variável | Para que serve |
| --- | --- |
| `AUTH_PROVIDER` | `local` (magic link próprio) ou `supabase` (GoTrue) |
| `AUTH_EXPOSE_LOGIN_CODES` | Entrega link e código na resposta |
| `AUTH_RATE_LIMIT` | Pedidos de login por minuto, por IP |
| `JWT_SECRET` | Assina a sessão. Mín. 32 caracteres, **o mesmo nos dois backends** |
| `API_PUBLIC_URL` / `FRONTEND_PUBLIC_URL` | Base do link de acesso |

`AUTH_EXPOSE_LOGIN_CODES` vazio segue o ambiente: ligado fora de produção,
desligado em produção. Um valor explícito vence nos dois sentidos — e ligá-lo em
produção registra um aviso na inicialização, porque nesse modo **qualquer um que
peça acesso com um e-mail entra como aquele e-mail**.

As URLs públicas precisam ser alcançáveis pelo **navegador**, possivelmente de
outro aparelho: para testar o fluxo cross-device na sua rede, troque `localhost`
pelo IP da máquina.

`AUTH_RATE_LIMIT=10` é o valor de produção. A suíte ponta a ponta sobe a stack
com `500` porque faz dezenas de logins do mesmo IP em segundos — enfraquecer o
limite para todo mundo seria pior.

### E-mail

| Variável | Para que serve |
| --- | --- |
| `BREVO_API_KEY` | Ativa o envio real. Vazio = link vai só para o log |
| `BREVO_SENDER_EMAIL` | Remetente. Precisa ser de um domínio **verificado** na Brevo |
| `SMTP_*` | Usadas **pelo GoTrue**, não pelos backends |

Os dois backends usam a **mesma conta e o mesmo remetente**: o e-mail de acesso é
o mesmo produto, venha de qual backend vier.

Se o remetente não for de um domínio verificado, a Brevo recusa com `400` — e a
mensagem dela não deixa isso óbvio. O log do backend mostra o corpo da resposta.

> **Nas `SMTP_*`, preencha os três ou nenhum.** O GoTrue só registra o link no
> log quando **não há** host de SMTP. Com host definido e sem usuário/senha, ele
> tenta enviar, falha, e o pedido de acesso volta sem link em lugar nenhum — o
> login fica sem saída.

### Supabase

| Variável | Para que serve |
| --- | --- |
| `SUPABASE_URL` | Gateway. `http://localhost:54321` local, `https://SEU_REF.supabase.co` remoto |
| `SUPABASE_ANON_KEY` | Chave pública, exigida pelo Kong |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave administrativa. **Não** é usada no fluxo de login |
| `SUPABASE_JWT_SECRET` | Segredo que assina as três chaves acima |

As chaves são **derivadas** do `SUPABASE_JWT_SECRET`: trocar o segredo sem
regenerá-las quebra a plataforma. Regenere as três de uma vez:

```bash
node supabase/gerar-chaves.mjs
```

A `service_role` ignora RLS e permite administrar usuários. O fluxo de acesso não
precisa dela — manter a chave privilegiada fora do caminho quente reduz o estrago
de um log vazado.

### Webhook

| Variável | Para que serve |
| --- | --- |
| `WEBHOOK_API_KEY` | Valor esperado no header `X-Api-Key` |
| `WEBHOOK_SIGNATURE_SECRET` | Segredo do HMAC-SHA256 (`X-Signature`). Vazio desliga |
| `WEBHOOK_REQUIRE_SIGNATURE` | `true` exige assinatura em toda chamada |

A `ApiKey` diz **quem** está chamando; a assinatura diz que o **corpo está
intacto**. Em produção deixe `WEBHOOK_REQUIRE_SIGNATURE=true` — a ApiKey sozinha
não protege o conteúdo.

### Processamento

| Variável | Para que serve |
| --- | --- |
| `PROCESSING_SIMULATED_WORK` / `_MS` | A regra pesada simulada (~2 s) |
| `PROCESSING_BATCH_SIZE` | Itens reivindicados por ciclo |
| `PROCESSING_MAX_ATTEMPTS` | Tentativas antes da falha definitiva |

Há duas variáveis para a duração porque os formatos diferem: o .NET usa
`TimeSpan` (`00:00:02`) e o Node, milissegundos. **É este o tempo que o webhook
não paga** — ele responde antes, e o processamento acontece em outro processo.

### Observabilidade

| Variável | Para que serve |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Liga o tracing. Vazio = só métricas |
| `OTEL_SERVICE_NAMESPACE` | Agrupa os serviços no coletor |

As métricas estão **sempre** ligadas e não dependem de nada externo. O tracing é
opcional: sem endpoint, a stack sobe normalmente.

Use `4318` (OTLP/HTTP), e não `4317` (gRPC): o .NET aceita os dois, mas o
exportador do BFF só fala HTTP — apontar para a porta errada faz os traces do
VINEXT sumirem em silêncio, porque o exportador falha em segundo plano sem
derrubar nada.

---

Em produção, `docker-compose.prod.yml` **recusa subir** sem os segredos reais: a
sintaxe `${VAR:?mensagem}` impede que um valor de desenvolvimento chegue lá.

## Testes

**641 testes** no total.

```bash
# Backend .NET — 255 testes (unidade + integração com PostgreSQL real)
cd backend-dotnet
dotnet test Sabemi.slnx --settings coverlet.runsettings --results-directory TestResults
python scripts/check-coverage.py TestResults --min 80

# Frontend + BFF — 336 testes. Precisa do PostgreSQL no ar
cd frontend
pnpm test              # sem cobertura
pnpm test:coverage     # com o limiar aplicado
```

Os testes de integração do .NET sobem PostgreSQL sozinhos via **Testcontainers**;
basta ter Docker. Os do frontend usam um banco isolado (`sabemi_test`), criado e
migrado automaticamente antes de rodar — isso mantém a suíte independente da
stack de desenvolvimento, cujo worker consumiria a mesma fila.

O limiar de 80 % é verificado nos dois lados e **o CI falha abaixo dele**.
Cobertura atual: **83,6 %** no .NET, **89,2 %** de linhas no frontend.

### Ponta a ponta — 50 testes contra a stack real

Atravessam a fiação de verdade: containers separados, rede do Docker, worker em
outro processo. Rodam contra os **dois backends**.

```bash
AUTH_RATE_LIMIT=500 docker compose up -d --wait

cd tests/e2e && pnpm install && pnpm test
```

O teto de login é elevado porque a suíte faz dezenas de autenticações do mesmo IP
em segundos — em produção o limite é 10/min. Detalhes em
[`tests/e2e/README.md`](tests/e2e/README.md).

Varredura rápida da stack:

```bash
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
export DATABASE_URL=<conexão do banco de produção>
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

> Ao escalar, remova o mapeamento fixo da porta de métricas do worker: várias
> réplicas não podem disputar a mesma porta do host.

---

## Estrutura

```
contracts/openapi.yaml        Contrato único que os dois backends implementam
backend-dotnet/               Backend primário — ASP.NET Core, EF Core, worker próprio
frontend/                     Interface VINEXT + backend alternativo (BFF, Prisma)
supabase/                     Init do banco e chaves da plataforma local
scripts/migrar.mjs            Migrations (local ou remoto) + verificação do Prisma
scripts/smoke-test.sh         Verificação da stack em execução
tests/e2e/                    Ponta a ponta contra a stack em containers
docs/APRESENTACAO.md          Arquitetura e decisões técnicas
docs/HANDOFF.md               Estado atual, o que falta e como continuar
```
