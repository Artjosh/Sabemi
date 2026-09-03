# Sabemi · Webhooks de Pagamento

### Arquitetura e decisões técnicas

---

## 1. Propósito

Um banco parceiro notifica a Sabemi, por webhook, sempre que liquida um seguro ou
uma parcela de empréstimo. O serviço construído aqui precisa:

- receber essas notificações e responder **rápido**;
- **nunca** processar a mesma transação duas vezes, mesmo sob reentregas;
- **persistir** todo evento recebido — inclusive os inválidos;
- executar a regra de negócio de forma **resiliente**, sem perder trabalho;
- exibir tudo em um **painel administrativo**.

Sobre esses requisitos, o projeto reproduz duas features de um sistema anterior:
**autenticação passwordless com polling cross-device** e **troca de backend em
tempo de execução**.

O resultado é uma aplicação que roda sobre **duas implementações de backend
independentes**, alternáveis por um botão, sem que a interface saiba qual está
ativa.

---

## 2. Visão geral

```
                      ┌──────────────────────────────┐
   Navegador ────────▶│   Frontend VINEXT (:3000)    │
                      │                              │
                      │  React Server Components     │
                      │  Gateway  /api/gateway/*     │
                      │  Sessão   cookie httpOnly    │
                      └───────────┬──────────────────┘
                                  │  escolhe pelo cookie
                    ┌─────────────┴──────────────┐
                    ▼                            ▼
        ┌───────────────────────┐    ┌───────────────────────┐
        │  BACKEND PRIMÁRIO     │    │  BACKEND ALTERNATIVO  │
        │  .NET  (:8080)        │    │  VINEXT / BFF         │
        │                       │    │  (no mesmo processo)  │
        │  ASP.NET Core         │    │  Route handlers TS    │
        │  EF Core              │    │  Prisma               │
        └───────────┬───────────┘    └───────────┬───────────┘
                    │                            │
        ┌───────────▼───────────┐                │
        │  Worker .NET          │                │
        │  (container próprio)  │                │
        └───────────┬───────────┘                │
                    │                            │
                    ▼                            ▼
            ┌───────────────────────────────────────┐
            │      PostgreSQL (Supabase local)      │
            │                                       │
            │        schema `sabemi` — UM só        │
            │   EF Core migra · Prisma descreve     │
            └───────────────────────────────────────┘

   Banco parceiro ──▶ POST /webhooks/pagamento          (.NET)
                  ──▶ POST /api/bff/webhooks/pagamento  (VINEXT)
```

Quatro containers: `postgres`, `api`, `worker`, `frontend`. Dois overlays
opcionais: `docker-compose.supabase.yml` (plataforma Supabase completa —
GoTrue, Kong, PostgREST, Studio) e o profile `observabilidade` (Jaeger).

**O schema é um só, e é isso que faz a troca de backend valer a pena.** Um
evento entregue a um backend aparece no painel do outro; uma reentrega no .NET
reconhece como duplicata algo que entrou pelo VINEXT; e trocar de backend não
pede novo login, porque a tabela de usuários também é compartilhada.

O preço dessa escolha é que duas ferramentas de migration não podem disputar as
mesmas tabelas. **O EF Core é o dono**; o Prisma apenas descreve o mesmo modelo
para poder consultar. O que mantém a descrição honesta é um passo de CI que
compara os dois (`prisma migrate diff`) e falha se divergirem.

---

## 3. O contrato compartilhado

`contracts/openapi.yaml` é a peça que sustenta tudo o mais. Ele define os
endpoints, os formatos e — o que mais importa — **os códigos de resposta e seus
significados**. Os dois backends o implementam de forma independente; qualquer
divergência entre eles é um bug de contrato, não uma diferença aceitável.

| Código | Significado                                              |
| ------ | -------------------------------------------------------- |
| `202`  | Evento novo, aceito e enfileirado                        |
| `200`  | Reentrega de transação conhecida — nada foi reprocessado |
| `400`  | Payload inválido — mas **persistido** para auditoria     |
| `401`  | `X-Api-Key` ausente ou incorreta                         |
| `403`  | `X-Signature` inválida para o corpo recebido             |

O parceiro distingue os cinco casos sem precisar interpretar o corpo.

O contrato é validado no CI, e os tipos TypeScript derivados dele
(`lib/contracts.ts`) são consumidos pela interface, pelo backend VINEXT e pelos
adapters — uma divergência quebra a compilação antes de chegar ao navegador.

---

## 4. Idempotência

**Requisito:** o mesmo `id_transacao` não pode ser processado duas vezes, mesmo
quando o banco parceiro reenvia por timeout de rede.

**Solução:** um índice **único** sobre `id_transacao` na tabela de eventos
brutos. A inserção é otimista — tenta-se gravar, e a violação de unicidade *é* o
sinal de duplicidade.

Verificar antes de inserir não substitui isso. Sob concorrência, duas réplicas
recebendo a mesma reentrega passariam ambas pelo `SELECT` e ambas tentariam
inserir. Aqui, quem arbitra é o banco: uma insere, a outra recebe o erro `23505`
(PostgreSQL) ou `P2002` (Prisma) e responde “duplicado”.

Há uma consulta prévia no código, mas o papel dela é outro: no caso comum de
reentrega, ela evita gerar uma exceção e poluir o log. **A correção não depende
dela.**

> Verificado por teste: 20 reentregas simultâneas produzem exatamente um `202` e
> dezenove `200` — nos dois backends.

---

## 5. Persistência

Duas tabelas por schema, como pede a task.

**`payment_events`** — o log de eventos brutos. Append-only. Guarda o corpo
exatamente como chegou (`jsonb`), o que torna a tabela uma trilha de auditoria
real e não apenas um resumo.

Um payload reprovado na validação **também** vira uma linha aqui, com
`status_processamento = INVALIDO` e o motivo. Descartá-lo tornaria a falha
invisível justamente quando ela mais precisa ser vista.

**`contract_statuses`** — o estado consolidado. Mutável. A chave primária é o
próprio `id_contrato`: não há razão para uma chave sintética quando o
identificador de negócio já é único e estável.

Duas tabelas de apoio: `processing_jobs` (a fila) e `login_requests` +
`users` (autenticação).

### O ciclo de vida de um evento

A task pede filtros por “Sucesso” e “Erro”. O modelo tem seis estados, porque o
processamento é assíncrono e um par sucesso/erro esconderia informação que o
operador precisa:

| Estado        | Significado                                            |
| ------------- | ------------------------------------------------------ |
| `PENDENTE`    | Persistido, aguardando o worker                        |
| `PROCESSANDO` | Reivindicado, regra em execução                        |
| `SUCESSO`     | Concluído, contrato atualizado                         |
| `ERRO`        | Falhou após esgotar as tentativas                      |
| `INVALIDO`    | Reprovado na validação — nunca chegou a ser enfileirado |
| `DUPLICADO`   | Reentrega de transação conhecida                       |

`ERRO` e `INVALIDO` são separados de propósito: o primeiro é um problema nosso, o
segundo é do payload do parceiro. Causas diferentes, ações diferentes.

---

## 6. ORM e migrations

A especificação sugeria **Prisma**. Prisma não gera cliente para .NET — usá-lo no
backend primário exigiria um processo Node intermediário só para acessar o banco
a partir do C#, acrescentando um salto de rede e um ponto de falha sem ganho
algum.

O requisito real é demonstrar **ORM com migrations**. A solução adotada não
descarta o Prisma; **coloca cada ORM onde ele é a escolha natural**:

| Backend | ORM         | Papel no schema `sabemi`               |
| ------- | ----------- | -------------------------------------- |
| .NET    | EF Core 10  | **Dono**: cria e evolui (`dotnet ef`)  |
| VINEXT  | Prisma 7    | **Descreve**: consulta e grava         |

### Um schema só, e um dono só

Uma versão anterior deste projeto usava **schemas separados** (`dotnet` e
`vinext`), com o argumento de que assim cada ORM podia migrar o seu sem enxergar
o do outro como deriva. O argumento era bom; o resultado, não.

Com dois schemas, trocar de backend trocava também o conjunto de dados: um evento
entregue a um devolvia `404` no outro, e o operador precisava fazer login de novo
porque a tabela de usuários era outra. Para um painel de conciliação, isso não é
uma demonstração de independência — é um sistema que perde dados de vista.

Hoje **o schema é um só**. O que isso compra:

- um evento entregue a um backend aparece no painel do outro;
- uma reentrega no .NET reconhece como duplicata algo que entrou pelo VINEXT — a
  idempotência vale para o sistema, não para cada metade;
- trocar de backend não pede novo login.

E o preço é real: duas ferramentas de migration **não podem** disputar as mesmas
tabelas. Cada uma acharia que é a dona, e a última a rodar venceria.

### Como a divisão é mantida honesta

O EF Core migra. O Prisma tem um `schema.prisma` que **descreve** o mesmo modelo —
sem pasta de migrations, sem `prisma migrate deploy` em lugar nenhum.

Uma descrição que ninguém verifica envelhece em silêncio, e o sintoma seria o pior
possível: o backend VINEXT lendo colunas que não existem, com o erro aparecendo em
runtime, longe da causa. Por isso o CI roda `prisma migrate diff` e **falha se os
dois divergirem**.

O mesmo passo está no script de migração, que serve local e remoto:

```bash
node scripts/migrar.mjs          # aplica as migrations e confere o Prisma
node scripts/migrar.mjs --verificar   # só confere
```

Ele usa o SDK do .NET quando existe e cai para `backend-dotnet/schema.sql` —
gerado por `dotnet ef migrations script --idempotent`, versionado, e verificado no
CI — quando não existe. Assim quem trabalha no frontend não precisa instalar o SDK
para preparar um banco.

### O bug que a unificação criou, e que só um teste pegou

Ao passar a compartilhar tabelas, os dois ORMs começaram a gravar os mesmos enums
com **grafias diferentes**: o EF Core escrevia o nome do membro em C# (`Sucesso`),
o Prisma escrevia o valor do contrato da API (`SUCESSO`).

Nada dava erro. As consultas funcionavam e devolviam **menos linhas do que
deviam** — um filtro por situação no .NET não encontrava os eventos processados
pelo VINEXT, e os contadores somavam cada grafia em separado. É o pior tipo de
falha em um painel de conciliação: silenciosa e plausível.

A correção foi adotar MAIÚSCULAS como grafia canônica (a mesma do contrato
público), com um conversor no mapeamento e uma migration normalizando o que já
estava gravado. E ela expôs um segundo: o SQL bruto da fila comparava com o
literal `'Pendente'` e **parou de reivindicar itens** — de novo sem erro, só
trabalho que nunca acontecia. Hoje os literais derivam do enum, então uma
renomeação futura quebra o build em vez de silenciar a fila.

---

## 7. Processamento em background

**Requisito:** a regra pesada (~2 s) não pode bloquear o webhook, e o mecanismo
não pode perder trabalho em silêncio.

O segundo requisito elimina as soluções óbvias. `Task.Run`, `setTimeout` ou uma
fila em memória atendem o primeiro e falham no segundo: se o processo cair entre
o `202 Accepted` e o fim do processamento, o trabalho desaparece sem deixar
registro.

**A fila é uma tabela.** O evento e o job são gravados na **mesma transação** do
webhook — ou os dois existem, ou nenhum existe. Não há janela em que um evento
foi aceito sem trabalho enfileirado.

O consumo usa `SELECT … FOR UPDATE SKIP LOCKED`: cada worker pula as linhas
travadas por outro em vez de esperar por elas. N réplicas consomem a mesma fila
sem que duas peguem o mesmo item.

```
Webhook ──▶ [ evento + job ]  ── mesma transação ──▶  PostgreSQL
   │                                                       │
   └──▶ 202 em ~40 ms                                       │
                                                            ▼
                                          Worker: SKIP LOCKED ──▶ regra 2 s
                                                            │
                                     [ contrato + job ] ── mesma transação
```

**Por que não um broker.** RabbitMQ ou Redis resolveriam a fila, mas trariam de
volta o problema que se quer evitar: mensagem e evento passariam a viver em
sistemas diferentes, sem transação comum, e a falha entre gravar um e publicar o
outro seria exatamente o trabalho perdido em silêncio. Com a fila no mesmo banco,
a atomicidade é de graça. Em troca, abre-se mão de vazão muito alta — que não é o
problema aqui.

### Resiliência

- **Retentativa com backoff exponencial** (base 2, teto de 5 min).
- **Falha definitiva** após esgotar as tentativas, com o motivo registrado.
- **Recuperação de órfãos**: um item preso em `PROCESSANDO` além do
  *visibility timeout* volta para a fila. É o que faz a entrega *at-least-once*
  ser verdade e não apenas intenção — sem isso, um `kill -9` no meio de um item o
  deixaria travado para sempre.
- **Concorrência otimista** no contrato (coluna `xmin` do PostgreSQL): dois
  workers atualizando o mesmo contrato não se sobrescrevem.

A regra pesada roda **fora** da transação. Segurar uma transação aberta durante
2 s prenderia uma conexão e as travas das linhas por todo esse tempo — com
dezenas de itens em paralelo, é assim que o pool se esgota.

---

## 8. Segurança do webhook

A task pedia “Signature **ou** ApiKey”. Os dois foram implementados, porque
respondem a perguntas diferentes:

- **`X-Api-Key`** — *quem está chamando?* Simples, mas é um segredo estático:
  quem o intercepta pode reenviar qualquer corpo.
- **`X-Signature`** — *este corpo chegou intacto?* HMAC-SHA256 sobre o corpo
  bruto. Alterar um centavo do valor em trânsito invalida a requisição, e o
  segredo nunca trafega — só a prova de que o remetente o possui.

Dois detalhes decidem a correção:

1. A assinatura é calculada sobre os **bytes brutos**, nunca sobre o JSON
   reserializado. Reserializar muda espaços e ordem de chaves e quebraria a
   assinatura de forma aparentemente aleatória. Por isso o endpoint lê o corpo
   como texto antes de desserializar.
2. Todas as comparações usam **tempo constante**. Comparar com `==` retorna assim
   que dois bytes diferem, e essa diferença, medida com paciência, revela o
   segredo caractere a caractere.

**Falha fechada:** sem `ApiKey` configurada, o endpoint rejeita tudo. Aberto por
omissão seria o pior modo de falha possível.

Não há janela de timestamp contra replay — a idempotência já a torna inofensiva:
reenviar a mesma notificação assinada não produz efeito algum.

---

## 9. Autenticação por polling

Reproduzida do projeto de referência, adaptada a esta arquitetura.

### O fluxo

O operador informa o e-mail e recebe duas formas de entrar: um **link**, clicável
em qualquer aparelho, e um **código de 6 dígitos** para digitar na própria aba. A
aba que iniciou o login pergunta ao servidor a cada 2,5 s; quando o link é aberto
— no celular, por exemplo — o próximo ciclo já devolve a sessão e a aba do
desktop **entra sozinha**.

Não há cadastro: o primeiro login cria a conta.

```
  Desktop                    Servidor                   Celular
     │                          │                          │
     ├── e-mail ───────────────▶│                          │
     │◀── selector ─────────────┤                          │
     │                          │                          │
     ├── polling (2,5 s) ──────▶│  pending                 │
     ├── polling ──────────────▶│  pending                 │
     │                          │◀──── abre o link ────────┤
     ├── polling ──────────────▶│  approved + token        │
     │◀── usuário (sem token) ──┤  grava cookie httpOnly   │
```

### Três identificadores, três papéis

- **`selector`** — público. Viaja em toda chamada de polling. Sozinho não
  autentica ninguém, então pode ser repetido dezenas de vezes sem risco.
- **`magic token`** — segredo. Viaja uma única vez, no link do e-mail.
- **`código OTP`** — segredo curto, alternativa para o mesmo dispositivo.

Se o selector fosse o token de aprovação, bastaria observar o tráfego para roubar
o login. Os dois segredos são guardados apenas como **SHA-256** — um vazamento do
banco não entrega logins ativos.

### Encerramento

O polling termina de três maneiras, e **nenhuma delas é girar para sempre**:

1. **aprovado** — o pedido é consumido e destruído no mesmo passo;
2. **`404`** — expirou ou já foi consumido; o cliente para imediatamente;
3. **prazo** — 15 minutos, igual à validade do link.

Uma falha de rede **não** encerra o polling: o backend pode estar reiniciando, e
desistir abandonaria um login que funcionaria no ciclo seguinte.

### Por que polling e não WebSocket

O evento esperado é único, acontece uma vez por login e tem prazo curto. Uma
conexão persistente só para aguardá-lo custaria mais — em infraestrutura e em
modos de falha (reconexão, proxies que cortam conexões ociosas, aderência de
sessão no balanceador) — do que uma requisição leve a cada 2,5 s que termina em
minutos. E funciona identicamente nos dois backends, sem exigir que cada um
implemente transporte de tempo real.

### O token não chega ao navegador

Quando o login é aprovado, o backend devolve o `access_token`. O route handler do
VINEXT **o intercepta, grava em cookie `httpOnly` e o remove da resposta**. O
cliente recebe apenas `{ status, user }`.

A partir daí, o servidor lê o cookie e injeta `Authorization: Bearer` ao falar com
o backend ativo. **Um XSS no painel não encontra o token para roubar, porque ele
nunca esteve ao alcance do JavaScript.** Guardar em `localStorage` — o caminho
mais comum — deixaria o token a uma linha de distância de qualquer script
injetado.

---

## 10. Troca de backend

### O problema

A aplicação precisa funcionar sobre duas implementações completamente diferentes:
um serviço .NET do outro lado da rede e um backend TypeScript no mesmo processo do
frontend. Sem abstração, cada tela precisaria saber qual está ativo — e a troca
viraria uma condicional espalhada por todo o código.

### A solução

Um único tipo, `BackendAdapter`, com **uma única operação**: dada uma requisição
lógica, devolva uma resposta.

```ts
interface BackendAdapter {
  readonly id: "dotnet" | "vinext";
  handle(request: BackendRequest): Promise<BackendResponse>;
}
```

Repare no que **não** está ali: não há `listPayments`, `login`, `getSummary`. Um
método por operação obrigaria a alterar a interface e as duas implementações a
cada endpoint novo. Com uma operação genérica, quem define a superfície é o
contrato compartilhado — que é onde essa definição deve morar.

- **`DotnetBackendAdapter`** — proxy HTTP, injeta o token, repassa `X-Api-Key` e
  `X-Signature` intactos, traduz “serviço fora do ar” no mesmo `ProblemDetails` de
  sempre.
- **`VinextBackendAdapter`** — chamada **em processo**. Não há `fetch` para o
  próprio servidor: uma volta pela rede falando consigo mesmo acrescentaria
  latência e uma porta a mais para configurar. É a vantagem estrutural de um BFF —
  quando a implementação vive no mesmo runtime do gateway, o salto de rede é uma
  chamada de função.

### O que a interface enxerga

Nada. O cliente de API (`lib/api-client.ts`) chama **sempre** `/api/gateway/*`,
same-origin. Não há uma única menção a “.NET” ou “VINEXT” nele. O gateway lê o
cookie de seleção e despacha.

> Verificado por teste: nenhuma chamada do cliente monta URL absoluta. Introduzir
> um `http://localhost:8080` ali quebra a suíte.

### Por que a troca NÃO encerra a sessão

Numa versão anterior ela encerrava, e havia uma razão: cada backend tinha o
próprio schema e, portanto, os próprios usuários. O `sub` do JWT apontava para um
identificador que o outro backend não conhecia, e manter o cookie produziria uma
sessão que *parece* válida e falha na primeira consulta, com um `401` sem
explicação. A interface avisava antes e pedia confirmação.

Com o schema compartilhado, a causa desapareceu: a tabela `users` é a mesma, o
`sub` resolve nos dois lados, e o `JWT_SECRET` também é o mesmo — é isso que
permite ao gateway aceitar uma sessão emitida por qualquer um deles. A troca
virou o que sempre deveria ter sido: um clique, sem diálogo e sem perder o
contexto.

Vale registrar o que a mudança tirou junto: o diálogo de confirmação era uma
funcionalidade *desculpando* uma limitação. Quando a limitação sai, a
funcionalidade sai com ela.

### Como se prova que a troca é real

O endpoint `/health` de cada backend devolve o campo `backend`, e o gateway
acrescenta o header `x-sabemi-backend` com a implementação que **de fato**
respondeu — não com a que o cliente pediu. O painel exibe esse valor. Se o
gateway ignorasse a seleção, o indicador denunciaria.

---

## 11. Frontend

**VINEXT** — a reimplementação da API do Next.js sobre Vite, da Cloudflare. App
Router, React Server Components, route handlers e middleware.

**Alvo de deploy: Node**, e não Cloudflare Workers. A razão é arquitetural: o
backend alternativo abre conexões TCP diretas com o PostgreSQL e roda um laço de
processamento em background — duas coisas que o modelo de execução de Workers não
acomoda bem. Workers continua viável para uma versão apenas de interface.

### As três tecnologias de estilo

Misturar Tailwind e Bootstrap costuma dar errado por um motivo específico: os dois
trazem um reset global e regras para os mesmos elementos. A divisão adotada dá a
cada um um território próprio:

| Tecnologia       | Papel                                                          |
| ---------------- | -------------------------------------------------------------- |
| **Tailwind CSS** | O motor de estilo. Utilitários, tokens, modo escuro. Reset único |
| **shadcn/ui**    | A camada de componentes, sobre Radix. Código do repositório      |
| **Bootstrap**    | Apenas `bootstrap-grid.css` — só o grid, sem reboot — mais ícones |

`bootstrap-grid.css` contém exclusivamente container/row/col e gutters: **zero
conflito** com o preflight do Tailwind, verificável abrindo o arquivo. Usado no
esqueleto responsivo do dashboard, onde o grid de 12 colunas expressa a intenção
melhor do que uma pilha de utilitários.

> Bootstrap cuida do **esqueleto** e dos **ícones**, Tailwind da **pele**,
> shadcn/ui dos **órgãos**. Cada regra tem um dono único.

### O dashboard

Atualiza sozinho a cada 5 s, com uma decisão de usabilidade que importa: o
esqueleto de carregamento aparece **só na primeira carga**. Nos ciclos seguintes
os dados são trocados por baixo, sem desmontar a tabela — uma tela que pisca a
cada 5 s é inutilizável.

- **Filtros** por situação e por contrato (com *debounce*), compostos em uma única
  consulta SQL.
- **Alerta visual** para eventos com problema: barra vermelha, fundo próprio,
  ícone e o motivo do erro visível **sem precisar abrir o detalhe**.
- **Cartões** que separam “na fila”, “com erro” e “inválidos”. Se “na fila” cresce
  sem parar, o worker parou — é o sinal mais útil do painel.
- **Detalhe** com o payload bruto recebido e o estado consolidado do contrato.
- **Pausar** a atualização: um operador investigando um evento não quer a tabela
  se reordenando debaixo do cursor.

Cor nunca é o único sinal — todo estado tem ícone e rótulo, para quem não
distingue verde de vermelho.

---

## 12. Falha, retentativa e reenfileiramento

### O problema com "tentar três vezes"

A primeira versão tratava toda falha igual: reagendar com backoff até esgotar as
tentativas. Isso é errado nas duas pontas.

Um evento cujo contrato não existe **nunca** vai passar. Insistir três vezes só
atrasa em minutos a única coisa útil — o evento aparecer no painel como `ERRO`,
com a causa legível e um caminho de correção. E, do outro lado, uma
indisponibilidade de dois segundos do banco não deveria consumir tentativa
nenhuma.

### A classificação

`FailureClassifier` lê a exceção e devolve três coisas: a **categoria**
(`TRANSITORIA`, `PERMANENTE`, `DESCONHECIDA`), um **código estável**
(`DEADLOCK`, `REFERENCIA_INEXISTENTE`, `POOL_ESGOTADO`…) e a decisão de retentar.

A ordem de leitura importa: primeiro o `SQLSTATE` do PostgreSQL ou o código do
Prisma, depois o tipo da exceção, e só então o texto da mensagem. O texto muda
entre versões do banco e entre *locales* do servidor; o código não.

**O padrão é retentar.** Uma causa não reconhecida cai em `DESCONHECIDA`, que é
retentável. Errar retentando custa uma espera; errar desistindo custa um
pagamento que nunca consolidou.

### O código é persistido, a explicação não

A tabela guarda `erro_categoria` e `erro_codigo`. A explicação em português e a
ação sugerida são derivadas do código **na hora da consulta**, a partir de um
catálogo em memória.

Isso tem uma consequência prática: melhorar a redação de um tooltip é um deploy,
e não uma migration com `UPDATE` em massa — e eventos antigos passam a mostrar o
texto novo.

### O catálogo é duplicado, e isso é deliberado

Existem dois: `FailureCatalog.cs` e `failure-catalog.ts`. Compartilhá-los exigiria
um pacote comum consumido por .NET e por TypeScript — uma dependência de build
entre dois backends que existem justamente para serem independentes.

A duplicação só é defensável enquanto houver algo verificando que ela não
divergiu. Há: um teste do frontend **lê o arquivo C#** e compara códigos e
categorias. Se alguém acrescentar uma causa de um lado só, o build quebra.

### O botão de reenfileirar

Retry automático cobre o que melhora com o tempo. Mas "permanente" quer dizer
"não passa sozinha", não "não passa nunca": o contrato que faltava pode ser
cadastrado. Sem um caminho manual, a única saída seria reenviar o webhook com
outro `id_transacao` — sujando o log de eventos com uma linha duplicada de um
pagamento que é o mesmo.

`POST /payments/{id}/reenfileirar` devolve o evento à fila. Três decisões:

- **Recusa evento em `SUCESSO`.** A idempotência da ingestão impede um evento
  *duplicado* de entrar; ela **não** impede o *mesmo* evento de ser processado
  duas vezes. Sem essa recusa, dois cliques dobrariam o valor liquidado do
  contrato. É a proteção mais importante do endpoint, e tem teste nos dois
  backends.
- **Zera as tentativas.** Um item que falhou esgotou o orçamento; devolvê-lo sem
  zerar faria o botão parecer não funcionar.
- **Não apaga o erro anterior.** Ele é sobrescrito no próximo desfecho. Apagá-lo
  no clique destruiria o único registro do que aconteceu, justo enquanto alguém
  investiga.

Responde `409` — e não `400` — quando o estado não permite: o pedido está
correto, o que impede é o estado do evento. E a mensagem do `409` é escrita para
ser mostrada ao operador tal como vem.

### O tooltip

A célula de erro mostrava a mensagem crua da exceção, truncada em 16rem — algo
como `23503: insert or update on table "contract_statuses" violates foreign key`
cortado no meio. Para quem opera a conciliação, isso não diz nem o que aconteceu
nem o que fazer.

Hoje ela mostra a leitura da falha — "Falha temporária" ou "Falha definitiva" — e
o tooltip traz a explicação, a ação sugerida e o código. A mensagem técnica
continua a um clique, no detalhe do evento, que é onde ela serve.

O gatilho é um `<button>`, e não um `<span>` com `title`: só um elemento focável
abre o tooltip pelo teclado e pelo toque.

---

## 13. Observabilidade

### Métricas

OpenTelemetry nos três serviços, exportadas no formato Prometheus:

| Serviço      | Endereço                          |
| ------------ | --------------------------------- |
| API .NET     | `http://localhost:8080/metrics`   |
| Worker .NET  | `http://localhost:9464/metrics`   |
| BFF VINEXT   | `http://localhost:9465/metrics`   |

Os instrumentos de domínio vivem na camada de aplicação e usam apenas
`System.Diagnostics` — nada de OpenTelemetry. Quem emite a medição é a camada que
conhece o significado dela; quem decide para onde exportar é o host. Trocar OTLP
por outra coisa não toca em uma linha da aplicação, e os testes rodam sem
exportador algum.

As métricas que importam:

- `sabemi_webhook_duration_seconds` — **prova o requisito central da task**. Se
  essa distribuição sair dos milissegundos, a regra pesada voltou para dentro do
  request.
- `sabemi_webhook_events_total{desfecho}` — separar `duplicado` de `aceito` torna
  a idempotência observável: uma subida de duplicados significa que o parceiro
  está reentregando.
- `sabemi_processing_failures_total{codigo,categoria}` — responde, em plantão, a
  única pergunta que importa nos primeiros segundos: *isso vai se resolver
  sozinho?*
- `sabemi_processing_items_total` — uma fila que parou de drenar não aparece em
  lugar nenhum: o webhook continua respondendo `202`, os eventos continuam
  entrando, e ninguém percebe até um contrato aparecer sem o pagamento.

**Nenhum rótulo carrega `id_transacao`.** Uma série temporal por transação
derrubaria o Prometheus em poucas horas. Esse nível de detalhe pertence ao span,
onde é barato.

### Um erro que a métrica quase escondeu

Os histogramas gravam **segundos**, e os buckets padrão do SDK são pensados para
**milissegundos** (0, 5, 10, 25 … 10000). Toda medição real caía no primeiro
bucket, e o p95 do webhook aparecia como "≤ 5" — cinco segundos. O número existia,
o painel renderizava, e não dizia nada. Corrigido com buckets explícitos nos dois
backends.

O equivalente no BFF foi mais sutil: `metrics.getMeter()` resolve o provedor **na
hora da chamada** e devolve o objeto concreto — diferente de `trace.getTracer()`,
que devolve um proxy. Como o módulo era importado antes do SDK subir, os
instrumentos ficavam presos ao *meter* no-op para sempre. O `/metrics` respondia,
e nunca mostrava uma métrica `sabemi_`.

### Tracing

Spans por OTLP, ligados apenas quando `OTEL_EXPORTER_OTLP_ENDPOINT` está
configurado — a stack sobe normalmente sem coletor. O Jaeger vem sob um profile:

```bash
docker compose --profile observabilidade up -d
# e no .env:  OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

Use `4318` (OTLP/HTTP), e não `4317` (gRPC): o .NET aceita os dois, mas o
exportador do BFF só fala HTTP — e apontar para a porta errada faz os traces do
VINEXT sumirem em silêncio.

---

## 14. E-mail e provedor de identidade

### Brevo, a mesma conta nos dois backends

O e-mail de acesso é o mesmo produto, venha de qual backend vier: mesmo
remetente, mesmo domínio verificado, mesma reputação de envio. Duas contas dariam
duas reputações a cuidar e um remetente que muda conforme quem atendeu — o tipo
de inconsistência que faz um provedor marcar a mensagem como suspeita.

O que **não** é compartilhado é o código do cliente: um é C#, o outro TypeScript.
O que os mantém equivalentes é a API (v3, mesmo endpoint, mesmo corpo) e o
conteúdo — e o conteúdo é **código**, não um template no painel da Brevo. Um
template remoto não entra em revisão nem no histórico do repositório, e trocar de
provedor exigiria recriá-lo. Um teste de paridade compara os dois.

API HTTP e não SMTP: a API dá erro imediato e legível ("remetente não
verificado", "chave inválida"), enquanto por SMTP a mesma falha chega como um
`550` genérico ou, pior, como um aceite seguido de descarte silencioso. Num fluxo
em que o usuário está parado na tela esperando o código, saber na hora que o
envio falhou é o que permite mostrar uma alternativa.

**Uma falha de e-mail nunca vira `500` no login.** Ela vira `email_sent: false`,
o pedido de acesso continua válido no banco, e o link segue no log.

### GoTrue como modo de autenticação

`AUTH_PROVIDER=supabase` delega ao GoTrue a emissão do magic link, a geração do
OTP, o envio do e-mail e a validação do código.

**O que continua local é o pedido de login com `selector`** — e é ele que sustenta
o polling cross-device, que o GoTrue não tem: ele emite um link e espera o clique
redirecionar o *mesmo* navegador. A divisão é o que permite ter os dois: a
identidade verificada por um serviço dedicado, e o cross-device funcionando.

```
  desktop                     GoTrue                    celular
     │                           │                         │
     ├─ pede acesso ────────────▶│                         │
     │   (selector local)        ├─ envia magic link ─────▶│
     │                           │                         │
     ├─ polling: pending         │      abre o link ───────┤
     │                           │◀────────────────────────┤
     │                           ├─ 303 para /auth/supabase/confirm
     │                           │     ?selector=…#access_token=…
     │                           │                         │
     │                    a página lê o FRAGMENTO e faz POST
     │                           │                         │
     ├─ polling: approved ◀──────┴─ pedido aprovado ───────┘
     │   + sessão
```

**A parte que não pode ser simplificada.** O `selector` é público — ele viaja em
cada chamada de polling. Aprovar o pedido só com ele deixaria qualquer pessoa que
observasse uma requisição entrar na conta alheia. Então o que aprova é o **token
que o GoTrue emitiu**, com duas verificações:

1. o token é validado **contra o GoTrue** (`GET /auth/v1/user`), e não pela
   assinatura local — validação local aceitaria um token já revogado;
2. o e-mail que ele devolve é comparado com o do pedido, senão um token válido de
   *outra* conta aprovaria este.

Verificado na stack real: um token legítimo de outra conta recebe `401` e o
pedido continua pendente.

**Por que a página precisa de JavaScript.** O GoTrue devolve o token no
*fragmento* da URL (`#access_token=…`), e fragmento não é enviado ao servidor —
é exatamente por isso que ele é usado para credenciais. Só o navegador o vê. A
página lê o fragmento, o envia por POST, e o apaga da barra de endereços com
`history.replaceState`, para o token não ficar no histórico do aparelho.

O fluxo PKCE entregaria o código na *query* e dispensaria JavaScript, mas exigiria
guardar um `code_verifier` por pedido — mais uma coluna e mais um estado a
expirar, para um alvo de redirect que sempre roda em um navegador.

### Como verificar o ciclo completo sem SMTP

O magic link do GoTrue vai por e-mail, e sem SMTP configurado ele não sai. Para
exercitar o fluxo inteiro mesmo assim, a API administrativa do GoTrue gera o link
em claro — é o caminho que os testes manuais usaram.

```bash
SERVICE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2-)

# 1. Peça o acesso e guarde o selector
SEL=$(curl -s -X POST http://localhost:8080/auth/magic-link \
  -H 'Content-Type: application/json' -d '{"email":"teste@sabemi.com.br"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['selector'])")

# 2. Gere o link, apontando o redirect para o nosso endpoint com o selector
LINK=$(curl -s -X POST http://localhost:54321/auth/v1/admin/generate_link \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\\"type\\":\\"magiclink\\",\\"email\\":\\"teste@sabemi.com.br\\",\\"redirect_to\\":\\"http://localhost:8080/auth/supabase/confirm?selector=$SEL\\"}" \
  | python -c "import sys,json;print(json.load(sys.stdin)['action_link'])")

# 3. "Clique": o GoTrue valida e redireciona com o token no FRAGMENTO
TOKEN=$(curl -s -i "$LINK" | grep -i '^location' \
  | sed 's/.*access_token=\\([^&]*\\).*/\\1/' | tr -d '\\r')

# 4. O que a página de confirmação faz com o token
curl -s -o /dev/null -w '%{http_code}\\n' -X POST \
  http://localhost:8080/auth/supabase/aprovar \
  -H 'Content-Type: application/json' \
  -d "{\\"selector\\":\\"$SEL\\",\\"access_token\\":\\"$TOKEN\\"}"   # 204

# 5. O polling do desktop recebe a sessão
curl -s -X POST "http://localhost:8080/auth/login-status?selector=$SEL"
```

O passo 5 devolve `"status":"approved"` com o `access_token` da sessão — a mesma
resposta que a aba original receberia sozinha, no ciclo seguinte de polling.

Trocando o e-mail do passo 2 por outro, o passo 4 devolve `401` e o pedido
continua pendente: é a verificação de que um token válido de **outra conta** não
aprova este pedido.

### O provedor fica gravado na linha

`login_requests.provedor` guarda `LOCAL` ou `SUPABASE`. Se a decisão fosse lida da
configuração no momento da validação, um reinício com o provedor trocado
transformaria todo pedido em voo em algo invalidável: o código local não seria
comparado com o hash que existe, e o código do GoTrue não existiria.

Gravando o provedor, **um pedido termina do mesmo jeito que começou**.

### Indisponibilidade não é código errado

Um GoTrue fora do ar devolve `Indisponivel`, e não `Invalido`. A distinção
protege o usuário: contar como tentativa faria uma queda de dois segundos
consumir o orçamento dele e obrigá-lo a pedir um acesso novo. Vira `503` — o
cliente não errou nada — e a tela diz "tente de novo em instantes" em vez de
"código incorreto".

---

## 15. Containerização

Quatro serviços. A pergunta não foi “quantos containers cabem”, e sim **onde a
separação paga o próprio custo**:

**API × Worker** — a fronteira mais importante. Separar em processos torna
estrutural o requisito de não bloquear o webhook: a API nunca gasta CPU com a
regra, os dois lados escalam de forma independente (`--scale worker=3`), e
derrubar o worker para um deploy não derruba a ingestão — os eventos se acumulam
na fila.

**Backend × Frontend/BFF** — implementações concorrentes do mesmo contrato, em
plataformas diferentes. Precisam subir, cair e escalar separadamente para que a
troca signifique alguma coisa.

**Banco** — stateful, volume próprio, ciclo de vida distinto do código.

### O que deliberadamente não foi separado

- **Gateway dedicado** — o route handler do VINEXT já é o gateway same-origin.
- **Broker de mensagens** — a fila é uma tabela, o que permite gravar evento e job
  na mesma transação.
- **Container de migrations** — cada backend aplica as suas na subida, o que
  mantém `docker compose up` como comando único.

> Microsserviços onde agregam valor demonstrável; monolito onde a separação só
> traria latência e configuração.

### Diferença de topologia entre os dois backends

Do lado .NET o worker é um container próprio. No backend VINEXT o laço roda no
mesmo processo. **As garantias são idênticas** — fila durável, *at-least-once*,
recuperação de órfãos; o que muda é a capacidade de escalar os dois lados
separadamente. É a escolha certa para o backend alternativo, que existe para
provar a portabilidade do contrato e não para ser o caminho de produção.

As imagens usam build multi-estágio, contêm apenas o runtime e os binários
publicados, e rodam com **usuário sem privilégios**.

---

## 16. Testes

**683 testes.** Cobertura de **84,0 %** no backend .NET e **89,1 %** de linhas no
frontend — ambos acima do mínimo de 80 % exigido, verificado no pipeline.

| Suíte                  | Testes  | Ambiente                                    |
| ---------------------- | ------- | ------------------------------------------- |
| .NET — unidade         | 189     | Sem I/O: domínio, validação, HMAC, clientes HTTP com handler falso |
| .NET — integração      | 86      | PostgreSQL real (Testcontainers)            |
| Frontend — node        | 302     | PostgreSQL real                             |
| Frontend — componentes | 54      | jsdom + Testing Library                     |
| **Ponta a ponta**      | **52**  | **Stack em containers, pela rede**          |

> A cobertura do .NET era de 98 % antes da observabilidade, do cliente Brevo e do
> provedor GoTrue entrarem. O código novo tem testes, mas os caminhos de
> configuração e de exportador não são exercitados — e inflar o número cobrindo
> `AddOpenTelemetry(...)` mediria a biblioteca, não a aplicação.

Os E2E (`tests/e2e/`) são os únicos que atravessam a **fiação real** — quatro
containers, rede do Docker, migrations no entrypoint, worker em outro processo.
Rodam o mesmo corpo de teste contra os **dois backends** e provam coisas que
nenhum outro nível alcança:

- o desktop entra sozinho depois que **outro cliente HTTP** abre o link
  (dois cookie jars separados — é a única forma honesta de provar cross-device);
- o trabalho enfileirado por um processo é concluído por **outro container**;
- a troca de backend **preserva os dados e a sessão**: um evento entregue a um
  aparece no painel do outro, e uma reentrega no .NET reconhece como duplicata
  algo que entrou pelo VINEXT;
- o reenfileiramento **recusa** um evento já processado com sucesso, nos dois
  backends, com a mesma mensagem — a proteção que impede dois cliques de dobrar
  o valor liquidado de um contrato.

### O teste que causou dano, e as duas respostas erradas antes da certa

A suíte ponta a ponta autentica dezenas de vezes por execução, com endereços
inventados. Eles eram inventados em `@sabemi.com.br` — domínio real. Uma execução
com SMTP ativo enviou 26 mensagens para caixas que não existem. Todas viraram
**hard bounce**, os endereços foram para a blocklist da Brevo, e o efeito na
reputação de envio é acumulativo e não se desfaz.

**Primeira resposta: abortar.** A suíte passou a falhar quando detectava provedor
configurado, com a instrução de subir a stack sem ele. Impedia o dano, mas
ensinava a coisa errada — um vermelho que não é defeito treina a ignorar vermelho.

**Segunda resposta: pular.** Os 47 testes que autenticam passaram a se pular,
com aviso ruidoso, e no CI a regra se invertia para falhar. Melhor, e ainda
errado: pular é cobertura que ninguém confere, e a suíte inteira ficava
dependendo de detectar corretamente uma condição externa.

**A resposta certa era mais simples, e estava no enunciado do problema.** Os
endereços não precisam ser de um domínio real. A RFC 2606 reserva `.invalid`,
`.test`, `.example` e `.localhost` para nunca existirem: não há MX, nada é
entregue. A suíte passou a usar `@e2e.invalid`, e os dois backends passaram a
recusar entrega em domínio reservado antes de chamar o provedor.

Agora os 52 rodam sempre — com Brevo ligada ou não — e o dano é impossível, não
evitado. Verificado: 52 passam com a conta real ativa, 16 supressões no log,
zero tentativas de envio.

O detalhe que faz isso ser arquitetura e não gambiarra de teste: **a regra é
correta em produção também.** Enviar para um domínio reservado é garantir um
bounce, e bounce cobra da entregabilidade de todo o resto que a conta manda. Um
sistema que envia e-mail deveria recusar isso independentemente de ter uma suíte
de testes. Que a suíte fique incapaz de causar dano é consequência.

Fica coberto por três lados: unidade nos dois backends (incluindo a garantia de
que a requisição HTTP não chega a sair), um teste de paridade que lê o arquivo C#
e compara as listas, e dois testes ponta a ponta que pedem acesso e exigem
`email_sent: false` — lendo `email_provider` do `/health`, para a mensagem de
falha dizer se havia provedor ativo.

### Por que banco de verdade, e não provider em memória

Boa parte do que este projeto precisa provar **não existe** em memória: índices
únicos (sem eles a idempotência não é exercitável), `FOR UPDATE SKIP LOCKED`,
transações reais, `jsonb`, concorrência por `xmin`.

Um teste de idempotência em memória passaria **sempre**, inclusive com a
implementação quebrada. Seria pior do que não ter teste: daria confiança falsa
exatamente no requisito mais importante da task.

### Casos que os testes cobrem

Recebimento e validação do webhook, `ApiKey` e assinatura HMAC (incluindo
assinatura de outro corpo), idempotência sob 20 requisições simultâneas,
persistência de eventos inválidos, processamento assíncrono, retentativa com
backoff, falha definitiva, recuperação de órfãos, dois workers concorrentes,
filtros do dashboard, paginação, autenticação por polling cross-device, expiração,
força bruta no OTP, troca de backend, equivalência de contrato entre os dois
backends e o cookie `httpOnly`.

Somam-se a esses, das partes mais recentes:

- **classificação de falha** — causa transitória versus permanente, prioridade do
  `SQLSTATE` sobre o texto da mensagem, cadeia de causas cíclica sem travar, e o
  padrão de retentar o que não foi reconhecido;
- **paridade entre os dois catálogos de falha** — um teste lê o arquivo C# e
  compara códigos e categorias com os do TypeScript, porque a duplicação só é
  defensável enquanto algo verifica que ela não divergiu;
- **reenfileiramento** — recusa de evento já processado, dois cliques seguidos
  gerando um só job, tentativas zeradas, e o registro do erro anterior preservado;
- **tradução da `DATABASE_URL`** — senha percent-encoded decodificada, e um host
  remoto sem `sslmode` exigindo TLS assim mesmo;
- **cliente Brevo e cliente GoTrue** — forma do corpo, header de autenticação, e a
  garantia de que nenhuma falha deles vira `500` no login;
- **provedor de identidade** — indisponibilidade separada de código inválido, e um
  token válido de *outra* conta sendo recusado.

Além disso, `scripts/smoke-test.sh` faz uma varredura rápida (27 verificações)
sobre a stack no ar — se algo óbvio estiver quebrado, o CI falha em segundos em
vez de esperar a suíte completa.

### Defeitos reais encontrados pelos testes

1. **`.When()` do FluentValidation aplicado à cadeia inteira** — um payload sem
   `data_pagamento` passava na validação e só estourava depois, ao acessar
   `.Value` durante a ingestão.
2. **`ChangeTracker.Clear()` desanexando o restante do lote** — ao concluir um
   item, as alterações dos demais nunca chegavam ao banco. Silenciosamente:
   `SaveChanges` não reclama de entidade solta.
3. **`EnableRetryOnFailure` incompatível com transações manuais** — corrigido com
   o padrão de estratégia de execução do EF Core, e com releitura do estado a cada
   tentativa, para que uma reexecução não somasse o mesmo pagamento duas vezes.
4. **Healthcheck usando `localhost` dentro do container** — resolvia para IPv6
   enquanto os servidores escutam em IPv4, e o compose marcava containers
   saudáveis como `unhealthy`. Só apareceu ao subir a stack de verdade.
5. **`pnpm test` falhando em clone limpo** — o Vitest não carrega `.env`, e
   depois de carregá-lo os valores locais passaram a sobrescrever as fixtures da
   suíte. Encontrado clonando o repositório e seguindo apenas o README.

---

## 17. CI/CD e deploy

**CI** — quatro jobs em paralelo, mais um portão que agrega o resultado:

- **backend .NET** — build com avisos tratados como erro, testes, limiar de 80 %;
- **frontend** — typecheck, testes, limiar de 80 %, build de produção;
- **contrato** — valida `openapi.yaml` e a presença dos caminhos obrigatórios;
- **docker** — constrói as três imagens e roda o teste de fumaça contra a stack.

O portão final existe para a proteção de branch precisar de **um** status
obrigatório, em vez de uma lista que precisa ser atualizada a cada job novo — e
cuja desatualização passa despercebida.

**Deploy** — por **imagem**, não por código-fonte. O CI publica `api`, `worker` e
`frontend` no GHCR (multi-arquitetura, com SBOM e proveniência). O artefato que
passou nos testes é exatamente o que vai para produção — não um novo build feito
no servidor.

A sobreposição `docker-compose.prod.yml` consome imagens em vez de construir,
fecha a porta do PostgreSQL, exige assinatura HMAC, sobe duas réplicas do worker,
aplica limites de recursos e **recusa subir sem os segredos reais** — a sintaxe
`${VAR:?mensagem}` impede que um segredo de desenvolvimento chegue a produção.

O job de deploy por SSH está declarado e condicionado à existência dos segredos.
Um teste técnico não tem ambiente de produção para receber o deploy; deixar o
passo pronto e inerte é mais honesto do que fingir uma publicação.

---

## 18. Resumo das decisões

| Decisão                              | Alternativa descartada        | Por quê                                                       |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------- |
| Índice único para idempotência       | Verificação em memória        | Sob concorrência, a verificação prévia não garante nada        |
| Fila em tabela                       | RabbitMQ / Redis              | Evento e job na mesma transação; sem isso o trabalho pode sumir |
| Worker em container próprio          | Background service na API     | A regra de 2 s não disputa CPU com a ingestão; escalam à parte |
| EF Core no .NET, Prisma no VINEXT    | Prisma nos dois               | Prisma não gera cliente .NET; cada ORM na sua plataforma        |
| Schema compartilhado                 | Um schema por backend         | Dado único: o evento aparece nos dois, e a troca não pede login |
| EF Core dono das migrations          | Cada ORM migrando o seu        | Duas ferramentas na mesma tabela divergem em silêncio; o CI compara |
| Enums em MAIÚSCULAS no banco         | Nome do membro do C#          | EF Core gravava `Sucesso` e Prisma `SUCESSO` — filtros perdiam linhas |
| ApiKey **e** HMAC                    | Só um dos dois                | Um diz *quem chama*; o outro, que o *corpo está intacto*        |
| Polling                              | WebSocket / SSE               | Evento único e de prazo curto; funciona igual nos dois backends |
| Cookie `httpOnly`                    | Token em `localStorage`       | Um XSS não encontra o que roubar                                |
| Adapter com operação única           | Um método por endpoint        | O contrato define a superfície, não a interface do adapter      |
| PostgreSQL real nos testes           | Provider em memória           | Índice único e `SKIP LOCKED` não existem em memória             |
| VINEXT no alvo Node                  | Cloudflare Workers            | Conexão TCP com o banco e laço em background                    |
| `bootstrap-grid.css` apenas          | Bootstrap completo            | O reboot do Bootstrap brigaria com o preflight do Tailwind      |
| Retry decidido pelo TIPO do erro     | Sempre 3 tentativas           | Causa permanente não melhora com repetição; só atrasa o aviso   |
| Catálogo de falhas duplicado         | Pacote compartilhado          | Dependência de build entre backends que existem para ser independentes; teste de paridade guarda |
| Explicação derivada do código        | Texto gravado na linha        | Melhorar um tooltip vira deploy, não `UPDATE` em massa          |
| Reenfileirar devolve à fila          | Reprocessar no request        | 2 s segurando a conexão HTTP e um segundo caminho de processamento |
| Uma `DATABASE_URL` para os dois      | Uma variável por backend      | Trocar para remoto virava transcrição em duas sintaxes          |
| API HTTP da Brevo                    | SMTP                          | Erro imediato e legível; por SMTP a falha chega como `550` ou silêncio |
| Conteúdo do e-mail em código         | Template no painel da Brevo   | Template remoto não entra em revisão nem no histórico           |
| Pedido de login sempre local         | Delegar tudo ao GoTrue        | O GoTrue não tem polling; sem o selector local não há cross-device |
| Token validado contra o GoTrue       | Validar a assinatura local    | Validação local aceita token já revogado                        |

---

## 19. Limitações conhecidas

**Entrega de e-mail sem credenciais.** O envio real pela Brevo está implementado
nos dois backends e é ativado por `BREVO_API_KEY`. Sem a chave, o link de acesso
vai para o log do servidor e, em desenvolvimento, para a tela. A escolha é
deliberada: exigir credenciais para rodar `docker compose up` seria um obstáculo
sem propósito na avaliação.

**As duas integrações foram verificadas contra a Brevo real**, com entrega
confirmada: a de SMTP (`xsmtpsib-`), que o GoTrue usa, e a da API v3
(`xkeysib-`), que os dois backends usam. São chaves diferentes e não se
substituem — a de SMTP devolve `Key not found` na API.

O que essa verificação ensinou, e que nenhum teste com servidor falso teria
mostrado: a conta pode ter **allowlist de IP**, e o IP que importa é o de saída
do *container*, que difere do que o navegador mostra. E o remetente precisa estar
verificado na conta, senão a recusa é `400` com uma mensagem que não diz isso.

O caminho de erro também foi exercitado com a Brevo recusando de verdade: o login
devolveu `200` com `email_sent: false` e o link na resposta, e o log trouxe a
mensagem inteira dela — incluindo o endereço a autorizar. É o motivo de registrar
o *corpo* da resposta e não só o status; um log de "HTTP 401" mandaria alguém
procurar a chave errada.

`scripts/verificar-email.mjs` empacota esse diagnóstico: separa as quatro causas
(chave, IP, remetente, blocklist) e diz o que fazer em cada uma. Ele **não** está
na suíte — envia de verdade, depende de terceiro, e a suíte E2E aborta justamente
quando há provedor ativo.

**Modo Supabase sem SMTP.** Com `AUTH_PROVIDER=supabase` e sem SMTP configurado,
o link de acesso fica no log do *container do GoTrue*, e não na resposta — ele é
montado dentro do GoTrue e nunca passa pela nossa aplicação. É o preço de
delegar a identidade, e está documentado no `.env` porque é o tipo de coisa que
faz alguém concluir que "o login parou de funcionar".

**Rotação de chaves do webhook.** A `ApiKey` é única. Em um cenário com rotação, o
próximo passo natural é aceitar um conjunto de chaves em vez de uma só.

**Cobertura do código de configuração.** A observabilidade, o cliente Brevo e o
provedor GoTrue têm testes de comportamento, mas os caminhos de *montagem*
(`AddOpenTelemetry(...)`, seleção de exportador) não são exercitados. Cobri-los
mediria a biblioteca, não a aplicação — e o número global caiu de 98 % para 84 %
por causa disso. O limiar de 80 % continua sendo respeitado.

**Tracing entre os backends não é correlacionado.** Cada serviço emite os próprios
spans, mas o `traceparent` não é propagado do webhook para o job — o trabalho é
assíncrono e a propagação exigiria carregar o contexto na linha da fila. É o
próximo passo natural da observabilidade, e não foi feito.

**Rate limit do login e a suíte E2E.** O endpoint de autenticação aceita 10
pedidos por minuto por IP — apropriado para produção, apertado para uma suíte que
faz dezenas de logins do mesmo IP em segundos. O limite é configurável
(`RateLimit:AuthPermitLimit`) e a suíte sobe a stack com um teto maior. A
alternativa seria enfraquecer o limite para todo mundo.
