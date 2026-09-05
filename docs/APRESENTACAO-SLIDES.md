# Sabemi · Webhooks de Pagamento

Recebimento idempotente de notificações bancárias, com processamento assíncrono e painel administrativo.

Dois backends independentes · um contrato · um banco

---

## O problema

Um banco parceiro notifica pagamentos que liquidam seguros e parcelas de empréstimo.

A notificação **chega repetida** — por erro de rede, por reentrega, por retry do parceiro.

Processar duas vezes significa **somar o mesmo valor duas vezes** ao contrato.

---

## O que foi construído

- Endpoint `POST /webhooks/pagamento` com ApiKey e assinatura HMAC
- Idempotência garantida no **banco**, não no código
- Fila durável, com a regra pesada (~2 s) fora do caminho da resposta
- Painel com filtros, diagnóstico de falha em português e reenfileiramento
- **Dois backends** implementando o mesmo contrato, alternáveis em runtime

---

## Arquitetura

```
Navegador ──▶ Frontend + BFF (VINEXT/TypeScript)
                     │
                     ├──▶ API .NET ──▶ Worker .NET
                     │
                     ▼
              PostgreSQL · schema único
```

O gateway escolhe o backend por cookie. Os dois compartilham as **mesmas tabelas**, os **mesmos usuários** e a **mesma fila**.

---

## Idempotência é do banco

Uma verificação prévia em memória **não garante nada** sob concorrência: duas requisições simultâneas passam pelo `if` juntas.

A garantia é um **índice único** em `id_transacao` mais insert otimista, capturando a violação (`23505` no Postgres, `P2002` no Prisma).

> Verificado com **20 requisições simultâneas** do mesmo evento: um registro, uma consolidação.

---

## A fila é uma tabela

Evento e job gravados **na mesma transação**: ou os dois existem, ou nenhum.

- Reivindicação com `FOR UPDATE SKIP LOCKED` — várias réplicas consomem sem conflito
- *Visibility timeout* devolve à fila o item de um worker que morreu
- Derrubar o worker para um deploy **não derruba a ingestão**: os eventos se acumulam

Sem broker. Sem componente novo para operar.

---

## Responder rápido, processar depois

O endpoint responde em **~0,5 s** uma regra que leva **2 s**.

O trabalho não é "disparado e esquecido": ele está **numa linha da tabela**, com tentativas, backoff e prazo. Um processo que morre no meio não perde o evento.

Em serverless, o mesmo desenho usa `waitUntil` — a primitiva da plataforma para trabalho após a resposta.

---

## Retry por natureza do erro

Tratar toda falha igual erra nas duas pontas.

| Falha | Ação |
| --- | --- |
| **Transitória** (rede, deadlock) | retenta com backoff |
| **Permanente** (contrato inexistente) | vai direto para `ERRO` |

Insistir três vezes num evento que nunca vai passar só **atrasa** a única coisa útil: aparecer no painel com a causa legível.

---

## Dois backends, um contrato

`contracts/openapi.yaml` é implementado pelos dois e validado no CI.

A troca é **real**, não simulada: o header `x-sabemi-backend` diz quem respondeu, e `/health` confirma pela implementação que atendeu — não pelo cookie que o cliente enviou.

Os dois assinam a sessão com o mesmo segredo: **trocar de backend não desloga ninguém**.

---

## Acesso sem senha, entre aparelhos

Pede-se o acesso no desktop; o link pode ser aberto no celular. **A aba original entra sozinha.**

O que trafega no polling é um `selector` que **não autentica ninguém** — quem aprova é o magic token, que nunca aparece no cliente.

O token de sessão vive em cookie `httpOnly`: um XSS no painel não encontra o que roubar.

---

## Segurança

- ApiKey obrigatória no webhook, mais assinatura **HMAC do corpo**
- Rate limit por IP nas rotas de acesso
- CORS restrito à origem do painel
- Nenhum endereço de teste sai para domínio real — a suíte usa `.invalid`, reservado por RFC

> Antes dessa última regra, uma execução gerou **26 hard bounces** e sujou a reputação de envio. O efeito é acumulativo e não se desfaz.

---

## Testes

**630 testes**, atravessando fiação real — não mocks do próprio código.

- 236 no .NET (unidade + integração com PostgreSQL de verdade)
- 342 no frontend e no BFF
- 52 ponta a ponta, contra a stack em containers

Portão de cobertura no CI. Testes de **paridade** leem o arquivo do outro backend e falham se as duas implementações divergirem.

---

## As armadilhas que custaram tempo

Cada uma está documentada com o **porquê**, não só com a correção:

- `?schema=` na URL vira o **nome do usuário** no driver `pg`
- Bootstrap traz utilitários com `!important` que **vencem o Tailwind**
- `sslmode=require` significa coisas diferentes no `pg` e no Npgsql
- Uma variável de ambiente pode valer em **só metade do sistema**

O que essas têm em comum: **nenhuma dá erro**. Só resultado errado.

---

## No ar

| | |
| --- | --- |
| **Painel** | frontend-production-5213.up.railway.app |
| **API .NET** | api-production-8d41.up.railway.app |

Três serviços construídos a partir dos Dockerfiles do repositório, com Supabase como banco compartilhado.

Um `git push` na `main` publica os três.

---

## O que falta para produção de verdade

Dito com todas as letras, porque saber o limite vale mais que fingir que não existe:

- `/metrics` está público — fechar por rede
- A chave do webhook é única — não há rotação sem janela
- Os traces não são correlacionados entre os serviços
- As métricas existem, mas **nada as observa**

---

## Obrigado

**github.com/Artjosh/Sabemi**

Arquitetura, decisões e armadilhas em `docs/APRESENTACAO.md`.
