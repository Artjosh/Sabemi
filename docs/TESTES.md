# Testes

**683 testes** no total.

```bash
# Backend .NET — 275 testes (unidade + integração com PostgreSQL real)
cd backend-dotnet
dotnet test Sabemi.slnx --settings coverlet.runsettings --results-directory TestResults
python scripts/check-coverage.py TestResults --min 80

# Frontend + BFF — 356 testes. Precisa do PostgreSQL no ar
cd frontend
pnpm test              # sem cobertura
pnpm test:coverage     # com o limiar aplicado
```

Os testes de integração do .NET sobem PostgreSQL sozinhos via **Testcontainers**;
basta ter Docker. Os do frontend usam um banco isolado (`sabemi_test`), criado e
migrado automaticamente antes de rodar — isso mantém a suíte independente da
stack de desenvolvimento, cujo worker consumiria a mesma fila.

O limiar de 80 % é verificado nos dois lados e **o CI falha abaixo dele**.
Cobertura atual: **84,0 %** no .NET, **89,1 %** de linhas no frontend.

### Ponta a ponta — 52 testes contra a stack real

Atravessam a fiação de verdade: containers separados, rede do Docker, worker em
outro processo. Rodam contra os **dois backends**.

```bash
node scripts/subir.mjs

cd tests/e2e && pnpm install && pnpm test
```

O teto de login é elevado porque a suíte faz dezenas de autenticações do mesmo IP
em segundos — em produção o limite é 10/min.

A suíte pode rodar com provedor de e-mail ligado sem disparar nada: os endereços
saem em `@e2e.invalid`, e os dois backends recusam entrega em domínio reservado
por RFC antes de chamar o provedor. Não é concessão aos testes — a mensagem não
chegaria de qualquer forma, e cada tentativa seria um hard bounce. Detalhes em
[`tests/e2e/README.md`](../tests/e2e/README.md).

Varredura rápida da stack:

```bash
bash scripts/smoke-test.sh
```

### Verificar o envio de e-mail

Isto **não** está na suíte: envia um e-mail de verdade, depende de rede e de
cota, e a suíte E2E usa endereços em domínio reservado justamente para nunca
enviar. É um verificador sob demanda:

```bash
node scripts/verificar-email.mjs voce@exemplo.com
```

Ele separa as quatro causas de falha que a Brevo não deixa óbvias — chave errada,
IP não autorizado, remetente não verificado, destinatário na blocklist — e diz o
que fazer em cada uma.
