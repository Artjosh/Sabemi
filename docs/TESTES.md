# Testes

[← README](../README.md) · [1. Instalação](INSTALACAO.md) · [2. Configuração](CONFIGURACAO.md) · **3. Testes** · [4. Deploy](DEPLOY.md)

---

**630 testes** no total, **~2,5 min** para rodar tudo com a stack no ar.

| Suíte | Tempo | Precisa de |
| --- | --- | --- |
| .NET (unidade + integração) | 41 s | Docker, para o Testcontainers |
| Frontend + BFF | 44 s | PostgreSQL no ar |
| Ponta a ponta | 57 s | A stack inteira |
| Teste de fumaça | 7 s | A stack inteira |

Com cobertura: 31 s no .NET e 44 s no frontend. Os 24 s do .NET são o
Testcontainers subindo o PostgreSQL — os 141 testes de unidade levam 0,2 s.

```bash
# Backend .NET — 236 testes (148 unidade + 88 integração com PostgreSQL real)
cd backend-dotnet
dotnet test Sabemi.slnx --settings coverlet.runsettings --results-directory TestResults
python scripts/check-coverage.py TestResults --min 80

# Frontend + BFF — 342 testes. Precisa do PostgreSQL no ar
cd frontend
pnpm test              # sem cobertura
pnpm test:coverage     # com o limiar aplicado
```

Os testes de integração do .NET sobem PostgreSQL sozinhos via **Testcontainers**;
basta ter Docker. Os do frontend usam um banco isolado (`sabemi_test`), criado e
migrado automaticamente antes de rodar — isso mantém a suíte independente da
stack de desenvolvimento, cujo worker consumiria a mesma fila.

O limiar de 80 % é verificado nos dois lados e **o CI falha abaixo dele**.
Cobertura atual: **81,6 %** no .NET, **88,9 %** de linhas no frontend — as duas
acima do portão do CI (80 % de linhas; 70 % de *branches* no frontend).

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

---

**Próximo:** [Deploy](DEPLOY.md) — produção, secrets e escala.
