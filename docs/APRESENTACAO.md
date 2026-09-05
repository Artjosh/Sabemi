# Sabemi · Webhooks de Pagamento

[← README](../README.md) · [1. Instalação](INSTALACAO.md) · [2. Configuração](CONFIGURACAO.md) · [3. Testes](TESTES.md) · [4. Deploy](DEPLOY.md)

---

## O problema

Um banco parceiro notifica pagamentos que liquidam seguros e parcelas de empréstimo. A notificação chega repetida — por erro de rede, por reentrega, por retry do parceiro — e processar duas vezes significa somar o mesmo valor duas vezes ao contrato. O sistema recebe essas notificações, garante que cada `id_transacao` seja processado uma única vez, executa a regra de negócio fora do caminho da resposta e mostra tudo num painel administrativo. Sobre isso, duas exigências que moldaram a arquitetura: dois backends independentes implementando o mesmo contrato, alternáveis em tempo de execução, e acesso sem senha que funciona entre aparelhos.

---

## Idempotência é do banco, não do código

Verificar antes de inserir não garante nada sob concorrência: duas requisições simultâneas passam pelo mesmo `if` juntas e ambas gravam. A garantia real é um índice único em `id_transacao` mais insert otimista, capturando a violação — `23505` no PostgreSQL, `P2002` no Prisma. Está verificado com vinte requisições disparadas ao mesmo tempo: um registro, uma consolidação. A mesma disciplina vale para a fila, que é uma **tabela** e não um broker: evento e job são gravados na mesma transação, então ou os dois existem ou nenhum. A reivindicação usa `FOR UPDATE SKIP LOCKED`, várias réplicas consomem sem conflito, e um worker que morre no meio tem o item devolvido pelo *visibility timeout*. É isso que permite o webhook responder em meio segundo uma regra que leva dois: o trabalho não foi disparado e esquecido, está numa linha com tentativas, backoff e prazo. A falha também é classificada por natureza — a transitória retenta, a permanente vai direto para `ERRO`, porque insistir num evento cujo contrato não existe só atrasa a única coisa útil, que é ele aparecer no painel com a causa legível.

---

## Dois backends sobre um contrato

`contracts/openapi.yaml` é implementado pelo backend .NET e pelo BFF em TypeScript, e validado no CI — é ele que torna a troca uma troca real, e não uma simulação. Os dois compartilham o mesmo schema: as mesmas tabelas, os mesmos usuários, a mesma fila. Um evento entregue a um aparece no painel do outro, e uma reentrega no .NET reconhece como duplicata o que o VINEXT recebeu. O EF Core é o dono do schema e o Prisma o descreve; o CI compara os dois e falha se divergirem. A troca acontece por um cookie lido no servidor, e quem confirma não é o cliente: o campo `backend` de `/health` vem da implementação que atendeu a chamada. Como os dois assinam a sessão com o mesmo segredo, trocar de backend no painel não desloga ninguém. Testes de paridade leem o arquivo de um backend e comparam com o do outro, de modo que acrescentar uma causa de falha em um só lado quebra o build.

---

## Acesso e segurança

O webhook exige `ApiKey` no header e valida assinatura HMAC do corpo — uma chave correta com corpo adulterado é recusada. O acesso ao painel é sem senha: pede-se o link no desktop e ele pode ser aberto no celular, com a aba original entrando sozinha. O que trafega no polling é um `selector` que não autentica ninguém; quem aprova é o magic token, que nunca chega ao cliente. Quando o polling é aprovado, é o servidor que grava a sessão em cookie `httpOnly` — um XSS no painel não encontra token para roubar. Há rate limit por IP nas rotas de acesso, espera de reenvio contada na tabela que os dois backends compartilham, e CORS restrito à origem do painel. Um detalhe que só a operação ensina: nenhum endereço de teste sai para domínio real, porque a suíte usa `.invalid`, reservado por RFC. Antes dessa regra, uma execução com SMTP ativo gerou vinte e seis *hard bounces*, os endereços foram para a blocklist do provedor, e o efeito na reputação de envio é acumulativo e não se desfaz.

---

## A prova

São 630 testes que atravessam a fiação real, não dublês do próprio código: 236 no .NET com PostgreSQL de verdade, 342 no frontend e no BFF, 52 ponta a ponta contra a stack em containers. O CI roda quatro jobs em paralelo com portão de cobertura, compila o .NET tratando aviso como erro, valida o contrato OpenAPI e sobe a stack inteira para um teste de fumaça. O sistema está publicado: três serviços construídos a partir dos Dockerfiles deste repositório, com um Supabase como banco compartilhado, e um `git push` na `main` publica os três. O que mais ensinou, porém, não foram os acertos e sim as armadilhas — todas registradas com o porquê, porque têm uma característica em comum: **nenhuma delas dá erro**. `?schema=` na URL vira o nome do usuário no driver `pg`; o Bootstrap traz utilitários com `!important` que vencem o Tailwind e mudam todo o espaçamento; `sslmode=require` significa coisas diferentes no `pg` e no Npgsql; e uma variável de ambiente pode valer em só metade do sistema, deixando um backend assinar sessão com o segredo de exemplo. Todas produzem sistema no ar, respondendo `200`, com o resultado errado.

---

## Limites conhecidos

Dito com todas as letras, porque saber onde está o limite vale mais do que fingir que ele não existe. O endpoint `/metrics` está público — expõe apenas contadores e latências, mas em produção seria fechado por rede. A chave do webhook é única: rotacioná-la exige janela de indisponibilidade, e o passo natural seria aceitar um conjunto de chaves. Os traces não são correlacionados entre os serviços, porque o `traceparent` não atravessa a fila; propagá-lo exigiria carregar o contexto numa coluna e restaurá-lo no worker. E as métricas existem, mas nada as observa: se a fila crescer sem parar, o painel mostra — desde que alguém esteja olhando. Nenhum desses é obstáculo para o que o sistema faz hoje; são o que separa uma entrega sólida de uma operação em produção.

---

**No ar:** [painel](https://frontend-production-5213.up.railway.app) · [API .NET](https://api-production-8d41.up.railway.app)
