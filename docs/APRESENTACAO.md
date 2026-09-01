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
            │            PostgreSQL                 │
            │   schema dotnet  │   schema vinext    │
            │   (EF Core)      │   (Prisma)         │
            └───────────────────────────────────────┘

   Banco parceiro ──▶ POST /webhooks/pagamento          (.NET)
                  ──▶ POST /api/bff/webhooks/pagamento  (VINEXT)
```

Quatro containers: `postgres`, `api`, `worker`, `frontend`.

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

| Backend | ORM         | Schema   | Migrations                |
| ------- | ----------- | -------- | ------------------------- |
| .NET    | EF Core 10  | `dotnet` | `dotnet ef migrations`    |
| VINEXT  | Prisma 7    | `vinext` | `prisma migrate`          |

**Schemas separados na mesma instância.** É o que permite dois ORMs coexistirem
sem que o `migrate` de um enxergue o schema do outro como deriva a corrigir. E
reproduz a regra de que cada serviço é dono dos seus dados.

Consequência visível: **trocar de backend troca também o conjunto de dados**.
Isso é intencional e o painel avisa qual backend está ativo. É o que mantém a
troca honesta — são dois sistemas, não duas fachadas sobre o mesmo banco.

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

### Por que a troca encerra a sessão

Cada backend tem o próprio banco e, portanto, os próprios usuários. O `sub` do
JWT aponta para um identificador que o outro backend não conhece. Manter o cookie
produziria uma sessão que *parece* válida e falha na primeira consulta, com um
`401` sem explicação.

A interface **avisa antes** de trocar e pede confirmação. A consequência fica
legível em vez de ser descoberta por acidente.

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

## 12. Containerização

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

## 13. Testes

**407 testes.** Cobertura de **98,1 %** no backend .NET e **93,8 %** no frontend —
ambos acima do mínimo de 80 % exigido, verificado no pipeline.

| Suíte                  | Testes | Ambiente                          |
| ---------------------- | ------ | --------------------------------- |
| .NET — unidade         | 84     | Sem I/O: domínio, validação, HMAC |
| .NET — integração      | 74     | PostgreSQL real (Testcontainers)  |
| Frontend — node        | 194    | PostgreSQL real                   |
| Frontend — componentes | 55     | jsdom + Testing Library           |

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

Além disso, `scripts/smoke-test.sh` exercita a **fiação real** — containers
separados, rede do Docker, migrations no entrypoint, worker em outro processo. É
o que pega a classe de defeito que nenhum teste de integração alcança: variável de
ambiente com o nome errado, serviço apontando para `localhost` em vez do nome do
container. Tudo verde e a aplicação no ar sem funcionar.

### Três defeitos reais encontrados pelos testes

1. **`.When()` do FluentValidation aplicado à cadeia inteira** — um payload sem
   `data_pagamento` passava na validação e só estourava depois, ao acessar
   `.Value` durante a ingestão.
2. **`ChangeTracker.Clear()` desanexando o restante do lote** — ao concluir um
   item, as alterações dos demais nunca chegavam ao banco. Silenciosamente:
   `SaveChanges` não reclama de entidade solta.
3. **`EnableRetryOnFailure` incompatível com transações manuais** — corrigido com
   o padrão de estratégia de execução do EF Core, e com releitura do estado a cada
   tentativa, para que uma reexecução não somasse o mesmo pagamento duas vezes.

---

## 14. CI/CD e deploy

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

## 15. Resumo das decisões

| Decisão                              | Alternativa descartada        | Por quê                                                       |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------- |
| Índice único para idempotência       | Verificação em memória        | Sob concorrência, a verificação prévia não garante nada        |
| Fila em tabela                       | RabbitMQ / Redis              | Evento e job na mesma transação; sem isso o trabalho pode sumir |
| Worker em container próprio          | Background service na API     | A regra de 2 s não disputa CPU com a ingestão; escalam à parte |
| EF Core no .NET, Prisma no VINEXT    | Prisma nos dois               | Prisma não gera cliente .NET; cada ORM na sua plataforma        |
| Schemas separados                    | Schema compartilhado          | Dois ORMs disputariam as mesmas migrations                     |
| ApiKey **e** HMAC                    | Só um dos dois                | Um diz *quem chama*; o outro, que o *corpo está intacto*        |
| Polling                              | WebSocket / SSE               | Evento único e de prazo curto; funciona igual nos dois backends |
| Cookie `httpOnly`                    | Token em `localStorage`       | Um XSS não encontra o que roubar                                |
| Adapter com operação única           | Um método por endpoint        | O contrato define a superfície, não a interface do adapter      |
| PostgreSQL real nos testes           | Provider em memória           | Índice único e `SKIP LOCKED` não existem em memória             |
| VINEXT no alvo Node                  | Cloudflare Workers            | Conexão TCP com o banco e laço em background                    |
| `bootstrap-grid.css` apenas          | Bootstrap completo            | O reboot do Bootstrap brigaria com o preflight do Tailwind      |

---

## 16. Limitações conhecidas

**Entrega de e-mail.** O link de acesso vai para o log do servidor e, em
desenvolvimento, para a tela. Trocar por SMTP é implementar
`ILoginNotificationSender` e registrar a nova implementação — nada mais no fluxo
muda. A escolha é deliberada: exigir credenciais de SMTP para rodar
`docker compose up` seria um obstáculo sem propósito.

**Rotação de chaves do webhook.** A `ApiKey` é única. Em um cenário com rotação, o
próximo passo natural é aceitar um conjunto de chaves em vez de uma só.

**Reprocessamento manual.** Eventos em `ERRO` ficam registrados com o motivo, mas
não há botão para reenfileirar. O payload bruto está preservado, então o
reprocessamento é possível — só não tem interface ainda.

**Imagens .NET não construídas neste ambiente.** O registro da Microsoft (MCR)
está inacessível a partir da máquina onde o projeto foi montado, então
`docker compose build api worker` não pôde ser executado localmente. Os comandos
de publicação do Dockerfile foram verificados fora do container e produzem
exatamente os artefatos que o `ENTRYPOINT` espera; a imagem do frontend foi
construída e validada em execução. O job `docker` do CI constrói as três.
