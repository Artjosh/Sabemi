# Configuração

[← README](../README.md) · [1. Instalação](INSTALACAO.md) · **2. Configuração** · [3. Testes](TESTES.md) · [4. Deploy](DEPLOY.md)

---

Tudo o que o `.env` controla, e os modos que a stack aceita. Para apenas subir o
projeto, [`INSTALACAO.md`](INSTALACAO.md) basta.

---

Copie `.env.example` para `.env`. **Tudo tem padrão de desenvolvimento** — o
compose sobe sem você configurar nada. Há dois arquivos:

| Arquivo             | Quem lê                                                     |
| ------------------- | ----------------------------------------------------------- |
| `.env` (raiz)       | O Docker Compose, que repassa aos três containers            |
| `frontend/.env`     | Só quem roda `pnpm dev` **fora** do Docker                   |

Nenhuma variável do frontend pode receber o prefixo `NEXT_PUBLIC_`: são segredos
e configuração de servidor, e o prefixo as empacotaria no bundle do browser.

## Banco

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

## Autenticação

| Variável | Para que serve |
| --- | --- |
| `AUTH_PROVIDER` | `local` (magic link próprio) ou `supabase` (GoTrue) |
| `JWT_SECRET` | Assina a sessão. Mín. 32 caracteres, **o mesmo nos dois backends** |
| `API_PUBLIC_URL` / `FRONTEND_PUBLIC_URL` | Base do link de acesso |

## O atalho de desenvolvimento

Fora de produção, a resposta do login traz `dev_magic_url` e `dev_otp_code`, e a
tela os exibe. É o que permite demonstrar o fluxo cross-device sem provedor de
e-mail configurado.

**A decisão é do servidor, não da interface.** Com o atalho desligado, os dois
campos vêm `null` no corpo da resposta — não há nada escondido no JSON para
alguém revelar pelo DevTools. `AUTH_EXPOSE_LOGIN_CODES` controla os dois
backends: o VINEXT lê a variável direto, e o compose a entrega ao .NET sob o nome
que ele espera (`Auth__ExposeLoginCodesInDevelopment`).

Vazio segue o ambiente: ligado fora de produção, desligado em produção. Um valor
explícito vence nos dois sentidos — e ligá-lo em produção registra um aviso na
inicialização, porque nesse modo **qualquer um que peça acesso com um e-mail
entra como aquele e-mail**. Em `docker-compose.prod.yml` os dois serviços fixam
`false` sem consultar o ambiente, para que nenhum `.env` consiga ligá-lo lá.

Para conferir num ambiente qualquer, sem adivinhar:

```bash
curl -s -X POST http://localhost:8080/auth/magic-link   -H "Content-Type: application/json" -d '{"email":"x@e2e.invalid"}'
```

As URLs públicas precisam ser alcançáveis pelo **navegador**, possivelmente de
outro aparelho — `node scripts/subir.mjs` cuida disso detectando o IP da rede,
como descrito em [`INSTALACAO.md`](INSTALACAO.md#acesso-pela-rede).

## Duas proteções distintas no login

Elas resolvem problemas diferentes e valem nos **dois backends**.

**`AUTH_RESEND_COOLDOWN_SECONDS` — espera entre pedidos do mesmo e-mail.** Padrão
de 60 segundos, o mesmo do GoTrue (`GOTRUE_SMTP_MAX_FREQUENCY`), para que os dois
modos de autenticação se comportem igual. Sem ela, quem não recebe o e-mail clica
"enviar" repetidamente e cada clique vira uma mensagem de verdade — para um
endereço inexistente, uma sequência de hard bounces.

Pedir de novo cedo demais devolve `429` com o código `resend_too_soon` e a
mensagem já traz os segundos que faltam. **O pedido anterior sobrevive**: o e-mail
dele pode estar a caminho, e o link continua servindo. A recusa acontece *antes*
de invalidar o pedido antigo — a ordem inversa deixaria a pessoa sem nenhum
caminho de entrada.

A conta é feita na tabela de pedidos, que os dois backends compartilham: pedir
pelo .NET e repetir pelo VINEXT esbarra no mesmo prazo, porque a espera é do
e-mail e não do processo que atendeu. Zero desliga.

**`AUTH_RATE_LIMIT` — pedidos por minuto, por IP.** `500` em desenvolvimento e
`10` em produção. O valor de produção numa stack de desenvolvimento não protege
ninguém e atrapalha todo mundo: a suíte ponta a ponta faz dezenas de logins do
mesmo IP em segundos, e quem demonstra o painel clicando também estoura.
`docker-compose.prod.yml` fixa os `10` sem consultar o ambiente.

> **O que esse limite alcança em cada backend não é igual.** O .NET particiona
> pelo endereço do socket, que o cliente não escolhe. O VINEXT roda num runtime
> sem acesso ao socket: o IP só chega por cabeçalho (`x-real-ip`,
> `x-forwarded-for`), que existe atrás de um proxy e que um cliente direto pode
> inventar. Sem IP, o VINEXT não limita — um balde único compartilhado trancaria
> todo mundo por causa de uma pessoa. Quem cobre o caso que importa nos dois,
> sem depender de IP, é a espera de reenvio acima.

## E-mail

| Variável | Para que serve |
| --- | --- |
| `BREVO_API_KEY` | Ativa o envio real. Vazio = link vai só para o log |
| `BREVO_SENDER_EMAIL` | Remetente. Precisa estar **verificado** na Brevo |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` | Usadas **pelo GoTrue**, não pelos backends |

> **A Brevo tem duas chaves diferentes, e elas não se substituem.**
>
> | Chave | Prefixo | Onde pegar | Quem usa |
> | --- | --- | --- | --- |
> | API v3 | `xkeysib-` | Settings → API keys | Os dois backends (`BREVO_API_KEY`) |
> | SMTP | `xsmtpsib-` | Settings → SMTP | O GoTrue (`SMTP_PASSWORD`) |
>
> Pôr a chave SMTP em `BREVO_API_KEY` devolve `401` com `"Key not found"`.

**A conta pode ter restrição de IP.** Se o log trouxer

```
A Brevo recusou o e-mail: HTTP 401. Resposta: {"message":"We have detected you
are using an unrecognised IP address 177.4.239.187 ..."}
```

a chave está certa — falta autorizar o IP em
[app.brevo.com/security/authorised_ips](https://app.brevo.com/security/authorised_ips).

Autorize o IP que aparece **na mensagem de erro** — não o que o navegador mostra.
Eles costumam ser diferentes: o navegador pode sair por IPv6 enquanto o container
sai pelo IPv4 público da rede, e a Brevo trata os dois como endereços distintos.
Autorizar o errado deixa tudo igual, com a mesma mensagem.

A restrição vale só para a **API** — o relay SMTP (usado pelo GoTrue) não é
afetado, e é por isso que o modo `AUTH_PROVIDER=supabase` pode estar enviando
enquanto o modo local não.

Em nenhum desses casos o login quebra: o backend registra o motivo, devolve
`email_sent: false` e a tela mostra o link direto.

Os dois backends usam a **mesma conta e o mesmo remetente**: o e-mail de acesso é
o mesmo produto, venha de qual backend vier.

Se o remetente não estiver verificado, a Brevo recusa com `400` — e a mensagem
dela não deixa isso óbvio. O log do backend mostra o corpo da resposta.

Para ver quais remetentes a sua conta aceita:

```bash
curl -s https://api.brevo.com/v3/senders -H "api-key: $BREVO_API_KEY"
```

> **Nas `SMTP_*`, preencha os três ou nenhum.** O GoTrue só registra o link no
> log quando **não há** host de SMTP. Com host definido e sem usuário/senha, ele
> tenta enviar, falha, e o pedido de acesso volta sem link em lugar nenhum — o
> login fica sem saída.

## Supabase

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

## Webhook

| Variável | Para que serve |
| --- | --- |
| `WEBHOOK_API_KEY` | Valor esperado no header `X-Api-Key` |
| `WEBHOOK_SIGNATURE_SECRET` | Segredo do HMAC-SHA256 (`X-Signature`). Vazio desliga |
| `WEBHOOK_REQUIRE_SIGNATURE` | `true` exige assinatura em toda chamada |

A `ApiKey` diz **quem** está chamando; a assinatura diz que o **corpo está
intacto**. Em produção deixe `WEBHOOK_REQUIRE_SIGNATURE=true` — a ApiKey sozinha
não protege o conteúdo.

## Ajuste fino (não estão no `.env`)

Estas têm default no código e no compose. Só defina se precisar mudar:

| Variável | Default | Para que serve |
| --- | --- | --- |
| `PROCESSING_SIMULATED_WORK_MS` | `2000` | A regra pesada simulada |
| `PROCESSING_BATCH_SIZE` | `10` (.NET) / `5` (BFF) | Itens reivindicados por ciclo |
| `PROCESSING_MAX_ATTEMPTS` | `3` | Tentativas antes da falha definitiva |
| `AUTH_RATE_LIMIT` | `500` dev / `10` prod | Pedidos de login por minuto, por IP |
| `AUTH_EXPOSE_LOGIN_CODES` | segue o ambiente | Entrega link e código na resposta, **nos dois backends** |
| `AUTH_RESEND_COOLDOWN_SECONDS` | `60` | Espera entre dois pedidos para o mesmo e-mail |
| `WEBHOOK_REQUIRE_SIGNATURE` | `false` | Exige `X-Signature` em toda chamada |
| `API_PORT` / `FRONTEND_PORT` / `POSTGRES_PORT` | `8080` / `3000` / `5432` | Portas no host |
| `SUPABASE_PORT` / `SUPABASE_STUDIO_PORT` | `54321` / `54323` | Portas da plataforma |
| `POSTGRES_USER` / `POSTGRES_DB` | `postgres` | Superusuário e banco |
| `APP_DB_USER` | `sabemi_app` | Papel da aplicação |
| `OTEL_SERVICE_NAMESPACE` | `sabemi` | Agrupa os serviços no coletor |
| `BREVO_SENDER_NAME` | `Sabemi` | Nome exibido no remetente |
| `SMTP_PORT` / `SMTP_FROM` | `587` / `nao-responda@…` | Do GoTrue |

Use-as na linha de comando quando for pontual:

```bash
AUTH_RATE_LIMIT=10 docker compose up -d   # o teto de produção, em desenvolvimento
```

**Sobre `PROCESSING_SIMULATED_WORK_MS`:** é este o tempo que o webhook **não
paga** — ele responde antes, e o processamento acontece em outro processo.

Até pouco tempo eram *duas* variáveis para o mesmo número
(`PROCESSING_SIMULATED_WORK=00:00:02` para o .NET e `_MS=2000` para o Node),
porque os formatos diferiam. Mudar uma sem a outra fazia os dois backends
simularem durações diferentes — a pior divergência possível num projeto que
existe para provar que eles são equivalentes. Hoje o .NET converte de
milissegundos.

## Observabilidade

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

**Próximo:** [Testes](TESTES.md) — as suítes e o que cada uma cobre.
