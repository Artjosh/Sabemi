# Testes ponta a ponta

Exercitam a **stack em execução** — quatro containers, PostgreSQL de verdade,
worker em outro processo — pela rede, como um navegador e o banco parceiro
fariam. Nada é substituído por duble.

## Rodar

```bash
# Na raiz do repositório
AUTH_RATE_LIMIT=500 BREVO_API_KEY= SMTP_HOST= docker compose up -d --wait

cd tests/e2e
pnpm install
pnpm test
```

> **Por que `AUTH_RATE_LIMIT=500`.** O endpoint de login aceita 10 pedidos por
> minuto por IP — apropriado para produção, apertado para uma suíte que faz
> dezenas de autenticações do mesmo IP em segundos. Sem isso os testes recebem
> `429` e falham por um limite que está funcionando corretamente.
>
> **Por que `BREVO_API_KEY=` e `SMTP_HOST=`.** A suíte autentica com endereços
> inventados (`e2e-dotnet-1788405946722@sabemi.com.br`). Com um provedor de
> e-mail configurado, a stack **envia de verdade** para eles — e cada um vira um
> hard bounce na conta, que é exatamente o que corrói reputação de envio.
>
> Aconteceu neste projeto: uma execução no modo `supabase` com SMTP ativo gerou
> 26 bounces antes de alguém perceber. Os endereços foram para a blocklist da
> Brevo, que é o comportamento certo dela — mas o estrago é acumulativo e não se
> desfaz.

Para apontar para outro ambiente:

```bash
E2E_API_URL=https://api.exemplo \
E2E_WEB_URL=https://painel.exemplo \
E2E_API_KEY=<chave> \
pnpm test
```

## O que estes testes cobrem — e por que existem

As suítes de `backend-dotnet/tests` e `frontend/tests` exercitam cada peça a
fundo, mas todas montam a aplicação dentro do próprio processo de teste. Estes
aqui são os únicos que atravessam a **fiação real**.

| Arquivo | O que prova |
| --- | --- |
| `auth-cross-device.e2e.test.ts` | O desktop entra sozinho depois que **outro cliente HTTP** abre o link. Dois cookie jars separados — é a única forma honesta de provar "cross-device". |
| `webhook-pipeline.e2e.test.ts` | Da entrega do parceiro ao contrato consolidado, com o trabalho **enfileirado por um processo e concluído por outro**. Roda contra os dois backends. |
| `backend-switch.e2e.test.ts` | A troca **preserva** dados e sessão: um evento entregue a um backend aparece no painel do outro, e uma reentrega no .NET reconhece como duplicata algo que entrou pelo VINEXT. Os dois cumprem o mesmo contrato, campo a campo — incluindo o reenfileiramento e o diagnóstico de falha. |

São **50 testes**. Três exemplos do que só este nível pega:

- **Fiação entre containers.** Um serviço apontando para `localhost` em vez do
  nome do container passaria em todos os outros testes. Aconteceu de verdade duas
  vezes neste projeto: no healthcheck (que resolvia para IPv6) e na URL do
  GoTrue (onde `localhost:54321` dentro do container não é o Kong).
- **Migrations no entrypoint.** Se o schema não fosse criado na subida, tudo
  compilaria e nada funcionaria.
- **O worker de outro processo.** Os testes de integração chamam o ciclo de
  processamento diretamente; aqui ninguém chama nada — o worker acorda sozinho.

## Por que sem navegador automatizado

A lógica de interface já é coberta pelos testes de componente (jsdom +
Testing Library, em `frontend/tests/browser`). O que falta provar aqui é a
**integração**, e um navegador automatizado acrescentaria minutos de execução e
uma fonte grande de instabilidade sem cobrir nada disso melhor.
