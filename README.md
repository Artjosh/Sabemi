# Sabemi · Webhooks de Pagamento

Serviço de recebimento de notificações de pagamento com **idempotência garantida
no banco**, **processamento assíncrono resiliente** e **painel administrativo**.

A mesma aplicação roda sobre **dois backends independentes** — .NET (primário) e
VINEXT/BFF — alternáveis por um botão na interface. Os dois compartilham o mesmo
schema, então trocar de backend não troca os dados nem pede novo login.

---

## Começar

```bash
git clone <url-do-repositorio>
cd TesteZallpy
cp .env.example .env
node scripts/subir.mjs
```

Requisito: **Docker**. O script detecta o IP desta máquina na rede, sobe tudo e
imprime os endereços — o painel abre no computador e no celular. As migrations
são aplicadas sozinhas.

Passo a passo, firewall e instalação sem Docker: [`docs/INSTALACAO.md`](docs/INSTALACAO.md).

---

## Documentação

Os quatro primeiros formam uma trilha, na ordem, com navegação no topo de cada um.

| Documento | Para quê |
| --- | --- |
| [`INSTALACAO.md`](docs/INSTALACAO.md) | Clonar, subir e acessar pela rede — **comece aqui** |
| [`CONFIGURACAO.md`](docs/CONFIGURACAO.md) | Variáveis do `.env`, e-mail, Supabase, observabilidade |
| [`TESTES.md`](docs/TESTES.md) | As suítes, como rodá-las e o que cobrem |
| [`DEPLOY.md`](docs/DEPLOY.md) | Produção, secrets e escala |
| [`APRESENTACAO.md`](docs/APRESENTACAO.md) | Arquitetura e as decisões técnicas, com o porquê de cada uma |
| [`HANDOFF.md`](docs/HANDOFF.md) | Contexto para continuar o trabalho, incluindo as armadilhas já pisadas |

---

## O que o sistema faz

**Recebe** `POST /webhooks/pagamento` autenticado por ApiKey e, opcionalmente,
assinatura HMAC. Responde em milissegundos: o trabalho pesado não bloqueia a
resposta.

**Não duplica.** A idempotência é do `id_transacao` e vive no banco, como índice
único — não em memória, nem em cache. Vinte entregas simultâneas do mesmo evento
produzem um registro só, e uma reentrega pelo *outro* backend também é
reconhecida como duplicata.

**Processa em background**, com fila durável em PostgreSQL (`FOR UPDATE SKIP
LOCKED`), retentativa com backoff, classificação de falha por causa e recuperação
de itens órfãos.

**Mostra tudo** num painel com filtros, diagnóstico de erro em português e um
botão de reenfileirar que recusa o que já teve sucesso.

**Autentica sem senha**, por magic link com confirmação cross-device: o link
aberto no celular faz a aba do computador entrar sozinha, por polling.

---

## Estrutura

```
contracts/openapi.yaml        Contrato único que os dois backends implementam
backend-dotnet/               Backend primário — ASP.NET Core, EF Core, worker próprio
frontend/                     Interface VINEXT + backend alternativo (BFF, Prisma)
supabase/                     Init do banco e chaves da plataforma local
scripts/migrar.mjs            Migrations (local ou remoto) + verificação do Prisma
scripts/verificar-email.mjs   Diagnóstico do envio de e-mail, sob demanda
scripts/smoke-test.sh         Verificação da stack em execução
tests/e2e/                    Ponta a ponta contra a stack em containers
docs/APRESENTACAO.md          Arquitetura e decisões técnicas
docs/HANDOFF.md               Estado atual, o que falta e como continuar
```
