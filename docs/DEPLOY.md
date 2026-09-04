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

### Outra topologia: partido entre dois provedores

O acima sobe os quatro containers num host só. Há um segundo caminho, em que o
frontend e o backend VINEXT rodam na **Vercel**, os dois containers .NET num host
de containers, e um **Supabase** é o banco compartilhado — com os dois lados
competindo pela mesma fila.

A Vercel não executa .NET, e o laço de fila do VINEXT não sobrevive a serverless;
as duas coisas têm solução e estão descritas em
[`DEPLOY-SERVERLESS.md`](DEPLOY-SERVERLESS.md).

---

Fim da trilha. Para entender **por que** o sistema é assim, [`APRESENTACAO.md`](APRESENTACAO.md).
