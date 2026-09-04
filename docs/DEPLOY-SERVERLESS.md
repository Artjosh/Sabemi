# Deploy dividido — Vercel + host de containers + Supabase

[← README](../README.md) · [1. Instalação](INSTALACAO.md) · [2. Configuração](CONFIGURACAO.md) · [3. Testes](TESTES.md) · [4. Deploy](DEPLOY.md)

---

O [`DEPLOY.md`](DEPLOY.md) descreve o caminho de um host só: os quatro containers
juntos. Este documento descreve o outro, em que o sistema roda **partido entre
dois provedores** — que é a topologia que o projeto realmente quer demonstrar.

```
                    ┌───────────────────────────────┐
   Navegador ──────▶│  VERCEL                       │
                    │  Frontend + backend VINEXT    │
                    │  Funções em Fluid compute     │
                    └───────────┬───────────────────┘
                                │ gateway HTTP, quando o
                                │ operador escolhe ".NET"
                                ▼
                    ┌───────────────────────────────┐
                    │  HOST DE CONTAINERS           │
                    │  api .NET  ·  worker .NET     │
                    └───────────┬───────────────────┘
                                │
             ┌──────────────────┴──────────────────┐
             ▼                                     ▼
        ┌────────────────────────────────────────────┐
        │  SUPABASE — schema `sabemi`, um só         │
        │  As duas metades compartilham as tabelas,  │
        │  os usuários e a MESMA FILA                │
        └────────────────────────────────────────────┘
```

## Por que esta divisão, e não tudo na Vercel

**A Vercel não executa .NET.** Não há runtime; o `api` e o `worker` não têm como
rodar lá. Isso não é configurável.

O que a Vercel executa é a metade VINEXT — e executa bem, via o plugin do
[Nitro](https://v3.nitro.build/), que traduz a saída do Vite para o formato de
funções da plataforma. Ver [`frontend/vite.config.vercel.ts`](../frontend/vite.config.vercel.ts).

## O problema que essa divisão cria, e como ele é resolvido

O backend VINEXT processava a fila com um laço contínuo (`for(;;)`) iniciado na
primeira requisição. **Isso não sobrevive a serverless**: a invocação congela
depois da resposta. O laço rodaria enquanto a função estivesse quente e pararia
sem aviso, deixando eventos em `PENDENTE` — sem erro, sem log, e visível só no
painel, horas depois.

A troca são dois modos, em [`server/bff/config.ts`](../frontend/server/bff/config.ts):

| Modo | Como o trabalho acontece | Onde |
| --- | --- | --- |
| `loop` | laço contínuo enquanto o processo viver | container, VPS |
| `sob-demanda` | cada requisição que enfileira agenda um ciclo para depois da resposta | Vercel |

O padrão é detectado (a Vercel define `VERCEL` no ambiente) e pode ser forçado
com `BFF_PROCESSING_MODE`.

No modo `sob-demanda`, o ciclo é entregue ao **`waitUntil`** da plataforma, que
estende a invocação para além da resposta. O webhook responde em milissegundos e
os ~2 s da regra pesada rodam em seguida, no mesmo pedido — que é exatamente o
que a task original pede, agora atendido pela primitiva nativa em vez de um laço.

`waitUntil` **não tem retry**: se a promessa rejeitar, nada re-executa. Isso não
é um furo aqui, e a razão é a decisão de arquitetura mais importante do projeto:
**a fila é uma tabela**. Um ciclo que morre no meio não perde o item — o *lease*
expira e ele volta a ficar reivindicável.

### Quem varre os órfãos: o worker .NET, de graça

`processing_jobs` **não tem discriminador de backend**. A fila é compartilhada, a
reivindicação usa `FOR UPDATE SKIP LOCKED`, e qualquer consumidor drena qualquer
item. Então o `worker` .NET no host de containers já é o varredor dos jobs órfãos
do VINEXT, sem nenhum agendador extra.

Isso fortalece a demonstração em vez de enfraquecê-la: **dois serviços, em
provedores diferentes, competindo pela mesma fila sem se atropelar**, e a coluna
`reivindicado_por` registrando qual dos dois processou cada evento.

> **Cron da Vercel não é necessário** — e não seria suficiente: no plano Hobby a
> cadência mínima é **uma vez por dia**. Cadência de 1 minuto exige Pro. Com o
> worker .NET consumindo a mesma fila, nada disso é preciso.

---

## 1. Supabase

Crie o projeto e guarde **duas** connection strings — a distinção importa:

| Uso | Porta | Por quê |
| --- | --- | --- |
| Migrations (`scripts/migrar.mjs`) | **5432** (direta) | o pooler em *transaction mode* não executa DDL |
| Aplicação (Vercel e containers) | **6543** (pooler) | serverless abre conexão por invocação; o Postgres direto não aguenta |

```bash
# uma vez, da sua máquina, com a porta 5432
DATABASE_URL='postgresql://postgres.REF:SENHA@aws-1-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require' \
  node scripts/migrar.mjs

# confirme que EF Core e Prisma concordam com o schema publicado
node scripts/migrar.mjs --verificar
```

**Não acrescente `?schema=` na URL.** O driver `pg` interpreta esse parâmetro
como *usuário* da conexão e o erro fala de autenticação, não de parsing.

## 2. Host de containers (`api` + `worker`)

O CI já publica as três imagens no GHCR a cada push na `main`. Crie **dois**
serviços apontando para `api` e `worker` — o `frontend` vai para a Vercel, e o
`postgres` do compose não existe aqui.

Variáveis, nos dois:

```
DATABASE_URL=<connection string do pooler, porta 6543>
JWT_SECRET=<o MESMO segredo da Vercel — ver a nota abaixo>
WEBHOOK_API_KEY=<chave combinada com o parceiro>
WEBHOOK_SIGNATURE_SECRET=<segredo do HMAC>
Auth__ExposeLoginCodesInDevelopment=false
```

Só no `api`:

```
ASPNETCORE_ENVIRONMENT=Production
API_PUBLIC_URL=https://<url-publica-do-api>
FRONTEND_PUBLIC_URL=https://<url-do-painel-na-vercel>
```

Três detalhes que custam tempo se passarem batido:

- **A porta.** O `Dockerfile` fixa `ASPNETCORE_URLS=http://+:8080`. Declare 8080
  como porta do serviço, ou defina `ASPNETCORE_HTTP_PORTS=${PORT}` se a
  plataforma injetar `PORT`.
- **Não há `depends_on`.** No compose o `worker` espera o `api` terminar as
  migrations. Sem ordenação ele apenas registra "aguardando o schema" até o `api`
  migrar — não quebra, e você já migrou no passo 1.
- **O `worker` não precisa de porta pública.** Nenhuma rota de negócio nele.

## 3. Vercel (frontend + backend VINEXT)

Conecte o repositório e configure o projeto com a raiz em `frontend/`:

| Campo | Valor |
| --- | --- |
| Root Directory | `frontend` |
| Build Command | `pnpm build:vercel` |
| Output Directory | *(deixe vazio — o Nitro escreve em `.vercel/output`)* |
| Install Command | `pnpm install --frozen-lockfile` |

Variáveis de ambiente:

```
DATABASE_URL=<connection string do pooler, porta 6543>
JWT_SECRET=<o MESMO segredo do host de containers>
WEBHOOK_API_KEY=<a mesma chave>
WEBHOOK_SIGNATURE_SECRET=<o mesmo segredo>
DOTNET_API_URL=https://<url-publica-do-api>
FRONTEND_PUBLIC_URL=https://<url-do-painel-na-vercel>
AUTH_EXPOSE_LOGIN_CODES=false
BREVO_API_KEY=<para o e-mail de acesso funcionar>
BREVO_SENDER_EMAIL=<remetente verificado na Brevo>
```

`BFF_PROCESSING_MODE` **não precisa ser definido** — a Vercel define `VERCEL` e o
modo `sob-demanda` é escolhido sozinho. Defina apenas se quiser forçar o
contrário, para depurar.

### `JWT_SECRET` tem de ser idêntico nos dois lados

É o que faz a troca de backend em runtime não deslogar ninguém: os dois assinam a
sessão com o mesmo segredo, e o cookie emitido por um é aceito pelo outro. Com
segredos diferentes, trocar de backend no painel derruba a sessão — e o sintoma
(um logout aparentemente aleatório) não aponta para a causa.

### A `api` .NET fica exposta na internet

A Vercel não alcança a rede interna do host de containers, então `DOTNET_API_URL`
é a URL pública. A `api` já exige ApiKey/HMAC no webhook e sessão nas rotas do
painel, mas é uma superfície a mais — vale restringir por origem no provedor, se
ele oferecer.

---

## 4. Verificar que as duas metades estão de pé

```bash
WEB=https://<painel-na-vercel>
API=https://<api-no-host-de-containers>

# cada backend responde por si, e o campo `backend` diz QUEM respondeu
curl -s $API/health
curl -s $WEB/api/bff/health

# webhook no VINEXT (Vercel): deve responder rápido, com 202
curl -s -o /dev/null -w "%{http_code} em %{time_total}s\n" \
  -X POST $WEB/api/bff/webhooks/pagamento \
  -H "Content-Type: application/json" -H "X-Api-Key: $WEBHOOK_API_KEY" \
  -d '{"id_transacao":"DEPLOY-1","id_contrato":"CTR-DEPLOY","valor":10,
       "data_pagamento":"2026-01-01T00:00:00Z","status":"PAGO"}'

# a MESMA entrega, repetida: 200 e `duplicate: true`, sem reprocessar
# (idempotência atravessando dois provedores, pelo índice único no Supabase)

# o mesmo id_transacao entregue ao .NET reconhece a duplicata do outro lado
curl -s -X POST $API/webhooks/pagamento \
  -H "Content-Type: application/json" -H "X-Api-Key: $WEBHOOK_API_KEY" \
  -d '{"id_transacao":"DEPLOY-1","id_contrato":"CTR-DEPLOY","valor":10,
       "data_pagamento":"2026-01-01T00:00:00Z","status":"PAGO"}'
```

Alguns segundos depois, o evento deve aparecer como `SUCESSO` no painel — e o
detalhe mostra o contrato consolidado. Se ficar preso em `PENDENTE`:

1. Confira `DATABASE_URL` nos **dois** lados: eles têm de apontar para o mesmo
   banco, ou cada metade enxerga uma fila diferente e nada nunca se encontra.
2. Confira se o `worker` está de pé. Ele é o varredor de órfãos; sem ele, um
   `waitUntil` que morreu deixa o item esperando o lease expirar sem ninguém
   para reivindicá-lo.

## 5. O que esta topologia custa

| Provedor | Plano | Observação |
| --- | --- | --- |
| Vercel | Hobby | suficiente; o cron não é usado |
| Host de containers | o mais barato com serviço sempre ligado | o `worker` roda 24/7 — é o que pesa |
| Supabase | free | atenção à pausa por inatividade no free tier |

O `worker` **não pode dormir**. Num free tier que suspende serviços ociosos, ele
para de varrer a fila e o painel mostra "Na fila" crescendo para sempre — com os
dois backends aparentemente saudáveis.
