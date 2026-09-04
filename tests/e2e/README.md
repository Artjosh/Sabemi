# Testes ponta a ponta

Exercitam a **stack em execução** — quatro containers, PostgreSQL de verdade,
worker em outro processo — pela rede, como um navegador e o banco parceiro
fariam. Nada é substituído por duble.

## Rodar

```bash
# Na raiz do repositório
docker compose up -d --wait

cd tests/e2e
pnpm install
pnpm test
```

> **Sobre o rate limit do login.** O endpoint aceita 500 pedidos por minuto por
> IP em desenvolvimento e 10 em produção — esta suíte faz dezenas de
> autenticações do mesmo IP em segundos, e o teto de produção a derrubaria com
> `429` por um limite que está funcionando corretamente. O `docker-compose.yml`
> já traz o valor de desenvolvimento; não é preciso prefixar nada.
>
### Nenhum login desta suíte gera e-mail

A suíte autentica dezenas de vezes por execução, com endereços inventados. Ela
pode rodar contra uma stack com provedor de e-mail ligado sem disparar uma única
mensagem, e isso não depende de ninguém lembrar de um comando.

Os endereços saem de `emailDeTeste` ([support.ts](support.ts)), em
**`@e2e.invalid`**. A RFC 2606 reserva `.invalid` — junto de `.test`, `.example` e
`.localhost` — para nunca existir: não há MX, nada é entregue. Os dois backends
recusam entrega nesses domínios **antes** de chamar o provedor
([`EnderecoDeEmail.cs`](../../backend-dotnet/src/Sabemi.Domain/Auth/EnderecoDeEmail.cs)
e [`email-address.ts`](../../frontend/server/bff/email-address.ts)).

Isso não é uma afordância de teste. Recusar entrega em domínio reservado é a
decisão certa em produção também: a mensagem não chegaria de qualquer forma, e a
tentativa cobra um preço — cada uma é um **hard bounce**, e bounce não é mensagem
perdida, é reputação de envio perdida, de forma acumulativa e irreversível. Que a
suíte fique incapaz de causar dano é consequência, não motivação.

**Como se chegou aqui.** Os endereços eram inventados em `@sabemi.com.br`, um
domínio real. Uma execução com SMTP ativo gerou 26 hard bounces. O primeiro
remédio foi a suíte abortar quando havia provedor; o segundo foi pular os testes
de login. Os dois contornavam o problema — o segundo deixava 47 testes sem rodar,
e teste pulado é cobertura que ninguém confere. Trocar o domínio resolve na raiz:
não há envio a evitar, então não há nada a pular nem abortar.

**Duas defesas contra regressão silenciosa**, porque o sintoma de errar aqui não
aparece na saída do teste — aparece na reputação da conta, semanas depois:

- Dois testes ponta a ponta (um por backend) pedem acesso e exigem
  `email_sent: false`. Eles leem `email_provider` do `/health` para a mensagem de
  falha dizer se havia provedor ativo — com provedor, provam a supressão; sem, a
  ausência.
- `sessaoAutenticada` aborta se algum login retornar `email_sent: true`. É uma
  condição que nunca dispara, e é barata: um bounce não se desfaz.

Para exercitar o envio de verdade, que esta suíte deliberadamente **não** faz:

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
