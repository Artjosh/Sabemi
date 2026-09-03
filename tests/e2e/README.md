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

### Com provedor ativo, os testes de login se pulam

Rodar a suíte contra uma stack que tem provedor não falha nem envia nada: os 47
testes que autenticam são **pulados**, e os 3 que não dependem de login rodam.

Quem decide é o [`global-setup.ts`](global-setup.ts), antes da coleta. Ele
consulta o `/health` dos dois backends e lê o campo `email_provider` — um rótulo
(`brevo` / `none`), sem chave nem remetente. A detecção é **real**: pergunta à
stack em execução, não à variável de ambiente do shell que a invocou, que pode
divergir do que o container recebeu. E não descobre enviando, o que seria
autodestrutivo.

O resultado vira `E2E_EMAIL_PROVIDER_ATIVO` (`0` / `1`), lido em
[`support.ts`](support.ts) como `EMAIL_PROVIDER_ATIVO`. Os arquivos de teste não
o consultam direto: usam `descreveComLogin`, um `describe` que se pula quando há
provedor. Assim a dependência de sessão fica declarada no lugar onde ela existe —
o bloco — e não repetida como condição em onze pontos, que é onde se esquece um.

O skip é **ruidoso de propósito** — um bloco de aviso na saída, dizendo em qual
backend o provedor está ativo e qual comando roda a suíte completa. Teste pulado
em silêncio é pior do que teste falhando: a suíte termina verde e ninguém sabe
que 47 verificações não rodaram.

Três coisas que este desenho preserva:

- **A stack fora do ar continua sendo erro**, não motivo para pular. Sem ela
  nada aqui faz sentido, e a mensagem traz o comando que resolve.
- **A guarda dentro de `sessaoAutenticada` permanece.** Se a suíte for
  invocada sem o `globalSetup` — um arquivo isolado, outro runner —, o primeiro
  login que veja `email_sent: true` aborta. O skip é o caminho normal; a guarda
  é a rede.
- **Nada de autenticação deixa de ser coberto.** Pular é a resposta certa para
  a máquina do desenvolvedor, onde o provedor está ligado de propósito. No CI é
  a resposta errada: lá a suíte responde pela cobertura de autenticação, e um job
  verde com 47 testes pulados afirmaria algo falso. Então, com `CI` no ambiente,
  provedor ativo **falha** em vez de pular — a regra é imposta, não esperada.

Para exercitar o envio de e-mail, que estes testes deliberadamente **não** fazem:

```bash
node scripts/verificar-email.mjs voce@exemplo.com
```

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

## Sobre a configuração do TypeScript

Este diretório é um **pacote isolado**: tem `package.json` próprio e não há
`pnpm-workspace.yaml` no repositório, então ele não herda `node_modules` da raiz
nem do frontend. Toda dependência de tipo precisa estar nas devDependencies
dele — foi o caso do `@types/node`, que faltava.

**O `tsconfig.json` não declara `types`, e isso é deliberado.** Ele já declarou
(`["vitest/globals", "node"]`), e a lista era um ponto de falha: quando um nome
dela não resolve — e sob pnpm, com os pacotes atrás de symlinks, ferramentas
diferentes resolvem de formas diferentes — o TypeScript falha no carregamento da
biblioteca e **para de verificar todo o resto**. Três erros de tipo reais
sobreviveram assim, escondidos atrás de um erro de configuração.

Sem a chave, vale o comportamento padrão: todo pacote em `node_modules/@types`
entra automaticamente. E `vitest/globals` nunca foi necessário — os arquivos de
teste importam `describe`, `it` e `expect` de `"vitest"` explicitamente.

O ganho não é só um erro a menos: se `@types/node` faltar de novo, a falha aponta
para o **uso** (`process` não existe) em vez de para a configuração, e não cega o
verificador.

```bash
pnpm typecheck    # a fonte de verdade
```

> Se o editor acusar `Cannot find type definition file for 'node'` mesmo com o
> `pnpm typecheck` limpo, é estado do servidor de tipos, não do projeto: ele
> guarda o diagnóstico do `tsconfig` que leu ao abrir. "TypeScript: Restart TS
> Server" resolve; recarregar a janela, sempre.

## Por que sem navegador automatizado

A lógica de interface já é coberta pelos testes de componente (jsdom +
Testing Library, em `frontend/tests/browser`). O que falta provar aqui é a
**integração**, e um navegador automatizado acrescentaria minutos de execução e
uma fonte grande de instabilidade sem cobrir nada disso melhor.
