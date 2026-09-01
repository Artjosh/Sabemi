# Testes ponta a ponta

Exercitam a **stack em execução** — quatro containers, PostgreSQL de verdade,
worker em outro processo — pela rede, como um navegador e o banco parceiro
fariam. Nada é substituído por duble.

## Rodar

```bash
# Na raiz do repositório
AUTH_RATE_LIMIT=500 docker compose up -d --wait

cd tests/e2e
pnpm install
pnpm test
```

> **Por que `AUTH_RATE_LIMIT=500`.** O endpoint de login aceita 10 pedidos por
> minuto por IP — apropriado para produção, apertado para uma suíte que faz
> dezenas de autenticações do mesmo IP em segundos. Sem isso os testes recebem
> `429` e falham por um limite que está funcionando corretamente.

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
| `backend-switch.e2e.test.ts` | A troca muda os **dados**, não só a rota: um evento gravado em um backend devolve `404` no outro. E os dois cumprem o mesmo contrato, campo a campo. |

Três exemplos do que só este nível pega:

- **Fiação entre containers.** Um serviço apontando para `localhost` em vez do
  nome do container passaria em todos os outros testes.
- **Migrations no entrypoint.** Se o schema não fosse criado na subida, tudo
  compilaria e nada funcionaria.
- **O worker de outro processo.** Os testes de integração chamam o ciclo de
  processamento diretamente; aqui ninguém chama nada — o worker acorda sozinho.

## Por que sem navegador automatizado

A lógica de interface já é coberta pelos testes de componente (jsdom +
Testing Library, em `frontend/tests/browser`). O que falta provar aqui é a
**integração**, e um navegador automatizado acrescentaria minutos de execução e
uma fonte grande de instabilidade sem cobrir nada disso melhor.
