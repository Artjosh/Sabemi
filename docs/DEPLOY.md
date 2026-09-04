# Deploy

[← README](../README.md) · [1. Instalação](INSTALACAO.md) · [2. Configuração](CONFIGURACAO.md) · [3. Testes](TESTES.md) · **4. Deploy**

---

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

### O .NET usa a conexão DIRETA; o VINEXT usa o pooler

Contra um Supabase, os dois backends precisam de portas diferentes — e isso não
é preferência, é o que funciona.

| Serviço | Porta | Por quê |
| --- | --- | --- |
| `api`, `worker` (.NET) | **5432** direta | ver os dois motivos abaixo |
| `frontend` (VINEXT) | **6543** pooler | Prisma/`pg` funcionam bem nele |

**1. O Npgsql trava contra o pooler em modo transação.** O login do .NET
pendurava 30 s e estourava com `TimeoutException: Timeout during reading
attempt` num `UPDATE` — o driver esperando dados que o Supavisor nunca entrega.
Não é lock: `pg_locks` mostrava zero locks não concedidos e nenhuma transação
presa. O VINEXT, no MESMO pooler, respondia em menos de um segundo; o problema é
do par Npgsql + Supavisor.

**2. O `api` roda migrations na subida**, e o pooler em modo transação não
executa DDL. Isso passou despercebido no primeiro deploy só porque as migrations
já tinham sido aplicadas à mão pela conexão direta. Num banco limpo, teria
falhado na primeira subida.

O sintoma do primeiro caso engana: o serviço responde `200` no `/health`, o painel
abre, e só o login trava — porque é a primeira rota que escreve.

### Duas variáveis de URL pública que só aparecem no deploy

Os dois backends montam o link de confirmação do acesso, e cada um tem a sua
base:

- `Auth__PublicBaseUrl` (ou `API_PUBLIC_URL`) — o .NET
- `BFF_PUBLIC_BASE_URL` — o VINEXT

Sem elas o link sai apontando para `http://localhost:3000`, e o e-mail de acesso
leva a lugar nenhum. Localmente ninguém percebe: `localhost` é justamente onde a
pessoa está.

### Railway: as três imagens vindas do repositório

O caminho usado no deploy real deste projeto. Três serviços, todos apontando
para o **mesmo repositório** — o Railway constrói pelos Dockerfiles, sem passar
por registry.

| Serviço | Root directory | Como se diferencia |
| --- | --- | --- |
| `api` | `backend-dotnet` | `APP_PROJECT=Sabemi.Api` |
| `worker` | `backend-dotnet` | `APP_PROJECT=Sabemi.Worker` |
| `frontend` | `frontend` | Dockerfile próprio |

`api` e `worker` saem do **mesmo Dockerfile**: ele recebe `APP_PROJECT` como
`ARG` e publica o projeto correspondente. O Railway expõe as variáveis do
serviço como *build args*, então basta declarar a variável — que é exatamente a
intenção registrada no comentário do `backend-dotnet/Dockerfile`.

Quatro coisas que precisam de atenção, e nenhuma delas dá erro claro se estiver
errada:

- **`DATABASE_URL` igual nos três.** Se um apontar para outro banco, cada metade
  enxerga uma fila diferente e nada nunca se encontra — sem erro nenhum.
- **`JWT_SECRET` igual nos três.** É o que faz a troca de backend em runtime não
  deslogar ninguem: os dois assinam a sessão com o mesmo segredo. Diferentes, e
  trocar de backend no painel derruba a sessão — um logout que parece aleatório.
- **`ASPNETCORE_HTTP_PORTS=8080`** no `api`. O Dockerfile fixa
  `ASPNETCORE_URLS=http://+:8080`, e o Railway injeta `PORT`; declarar a porta
  evita o serviço subir escutando no lugar errado.
- **`DOTNET_API_URL` é a URL PÚBLICA do `api`.** No compose é `http://api:8080`
  pela rede interna; aqui o gateway do frontend precisa do domínio público.

O `worker` **não recebe domínio** — não tem rota de negócio. E não pode dormir:
num plano que suspende serviços ociosos ele para de varrer a fila e o painel
mostra "Na fila" crescendo para sempre, com os dois backends aparentemente
saudáveis.

O banco é um **Supabase remoto**, migrado uma vez pela porta 5432 (direta) e
consumido pela 6543 (pooler) — ver a seção 1 de
[`DEPLOY-SERVERLESS.md`](DEPLOY-SERVERLESS.md), que vale igual aqui.

### Outra topologia: partido entre dois provedores

O acima sobe os quatro containers num host só. Há um segundo caminho, em que o
frontend e o backend VINEXT rodam na **Vercel**, os dois containers .NET num host
de containers, e um **Supabase** é o banco compartilhado — com os dois lados
competindo pela mesma fila.

A Vercel não executa .NET, e o laço de fila do VINEXT não sobrevive a serverless;
as duas coisas têm solução e estão descritas em
[`DEPLOY-SERVERLESS.md`](DEPLOY-SERVERLESS.md).

**Esse caminho está bloqueado hoje** por um defeito de bundling entre `vinext` e
`nitro` (as duas em beta) — o pacote gerado não executa. O documento traz o erro
exato e como reproduzi-lo em um comando. Use o caminho de containers acima.

---

Fim da trilha. Para entender **por que** o sistema é assim, [`APRESENTACAO.md`](APRESENTACAO.md).
