# frontend/ — interface **e** backend alternativo

Este diretório não é só o frontend. Ele contém **duas coisas** que costumam viver
em repositórios separados:

1. a **interface** do painel (React Server Components, VINEXT);
2. o **backend alternativo** completo — o BFF, em `server/bff/`, que implementa o
   mesmo contrato que a API .NET, com o próprio ORM, a própria fila e o próprio
   laço de processamento.

O README do projeto está na raiz: [`../README.md`](../README.md).
A arquitetura está em [`../docs/APRESENTACAO.md`](../docs/APRESENTACAO.md).

---

## Como rodar

```bash
pnpm install
cp .env.example .env

# O banco precisa estar no ar e migrado (o EF Core é o dono do schema):
cd .. && node scripts/migrar.mjs && cd frontend

pnpm dev        # interface + BFF na porta 3000
```

---

## Scripts

| Comando               | O que faz                                                      |
| --------------------- | -------------------------------------------------------------- |
| `pnpm dev`            | Servidor de desenvolvimento                                     |
| `pnpm build`          | Build de produção (`output: standalone`)                        |
| `pnpm start`          | Serve o build local                                             |
| `pnpm test`           | Suíte completa — prepara o banco de teste antes                 |
| `pnpm test:coverage`  | Idem, com o limiar de cobertura aplicado                        |
| `pnpm typecheck`      | `tsc --noEmit`                                                  |
| `pnpm db:check`       | O modelo do Prisma corresponde ao banco?                        |
| `pnpm db:test:setup`  | Cria e migra o banco isolado da suíte (`sabemi_test`)           |

**Não há `prisma migrate` aqui, e isso é deliberado.** Os dois backends
compartilham o schema `sabemi`, e duas ferramentas emitindo DDL para as mesmas
tabelas produziriam divergência silenciosa. O EF Core migra; o Prisma descreve. O
`pnpm db:check` é o que mantém a descrição honesta — e ele também roda no CI.

---

## Onde está o quê

```
app/                    Rotas do VINEXT (RSC) e route handlers
  api/gateway/          Gateway: despacha para o backend selecionado no cookie
  api/bff/              Entrada do backend alternativo
components/
  dashboard/            Tabela de eventos, detalhe, tooltip de falha
  ui/                   Primitivas shadcn/ui sobre Radix
lib/
  contracts.ts          Tipos do contrato compartilhado
  api-client.ts         Cliente HTTP da interface
server/
  backends/             Adapter que abstrai os dois backends
  bff/                  O BACKEND ALTERNATIVO, inteiro:
    payments-service.ts   ingestão e consulta
    processing-service.ts fila durável (SKIP LOCKED) e regra pesada
    requeue-service.ts    reenfileiramento manual
    failure-catalog.ts    classificação de falha (gêmeo do C#)
    identity/             provedor de identidade (local ou GoTrue)
    brevo.ts              envio do e-mail de acesso
    telemetry*.ts         métricas e tracing
prisma/schema.prisma    DESCRIÇÃO do schema criado pelo EF Core
tests/
  node/                 Contra PostgreSQL real
  browser/              jsdom + Testing Library
```

---

## Estilo: três tecnologias, três papéis

- **Bootstrap** — `bootstrap-grid.css`, do qual usamos o grid, para o esqueleto
  responsivo. O Bootstrap completo traria um *reboot* que brigaria com o
  *preflight* do Tailwind.
- **Tailwind** — todo o estilo visual, e o único dono do espaçamento.
- **shadcn/ui** — componentes com comportamento (dialog, select, tooltip), sobre
  Radix, por acessibilidade de teclado e foco.

`bootstrap-grid.css` também embarca a API de utilitários do Bootstrap, toda com
`!important` e com nomes que colidem com os do Tailwind (`.p-5`, `.px-3`,
`.mb-4`) — o que fazia o espaçamento do painel renderizar em valores que ninguém
escreveu. `postcss.config.mjs` remove essas regras do bundle; o porquê está lá.

Os ícones são servidos de `public/fonts/`, e não pelo `@font-face` que vem no
CSS do `bootstrap-icons`: o `@import` perde a base do `url()` e a fonte dava 404
— o que fazia **todos** os ícones caírem no mesmo glifo de fallback. Se algum
ícone parecer errado, comece por aqui:

```bash
curl -s -o /dev/null -w "%{http_code}
" http://localhost:3000/fonts/bootstrap-icons.woff2
```

A divisão e as duas armadilhas — a colisão de `!important` e a fonte que dava
404 — estão documentadas nos comentários de `app/globals.css` e
`postcss.config.mjs`, que é onde quem for mexer vai olhar.
