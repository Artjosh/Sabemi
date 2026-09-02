import { Prisma } from "@/generated/prisma/client";

import type { RequeueResultDto } from "@/lib/contracts";

import { bffConfig } from "./config";
import { prisma } from "./db";
import { uuidV7 } from "./ids";
import { registrarReenfileiramento } from "./telemetry";

/**
 * Devolve a fila um evento que falhou, por decisao de uma pessoa no painel.
 *
 * <b>Espelho de `Sabemi.Application/Payments/PaymentRequeueService.cs`.</b> As
 * regras de elegibilidade e as mensagens de recusa sao as mesmas: o painel e um
 * so, e o operador nao deveria receber respostas diferentes conforme o backend
 * selecionado.
 *
 * <b>Por que existe.</b> O retry automatico so cobre falhas transitorias, e por
 * desenho: uma causa permanente nao melhora com repeticao, entao o item vai
 * direto para ERRO e para de gastar tentativas. Mas "permanente" quer dizer "nao
 * passa sozinha", nao "nao passa nunca" - o contrato que faltava pode ser
 * cadastrado. Sem este caminho, a unica saida seria reenviar o webhook com outro
 * `id_transacao`, sujando o log com uma linha duplicada do mesmo pagamento.
 *
 * <b>Por que nao reprocessa aqui mesmo.</b> Reenfileirar apenas devolve o item a
 * fila; quem processa continua sendo o worker. Rodar a regra de 2s dentro do
 * request seguraria a conexao HTTP por todo esse tempo e criaria um segundo
 * caminho de processamento, com as proprias condicoes de corrida, ao lado do que
 * ja existe.
 */

/** Por que um reenfileiramento nao pode ser feito. */
export type RequeueFailure = "not_found" | "not_eligible";

export type RequeueOutcome =
  | { ok: true; value: RequeueResultDto }
  | { ok: false; failure: RequeueFailure; message: string };

/**
 * Diz por que ESTE evento nao pode ser reenfileirado. Uma recusa generica
 * ("nao elegivel") obrigaria quem opera a adivinhar; cada estado tem um motivo
 * diferente e uma acao diferente.
 */
function motivoDaRecusa(status: string): string {
  switch (status) {
    case "SUCESSO":
      return (
        "Este evento ja foi processado com sucesso e o valor ja esta somado ao contrato. " +
        "Reprocessa-lo somaria o pagamento uma segunda vez."
      );

    case "PENDENTE":
    case "PROCESSANDO":
      return "Este evento ja esta na fila. Aguarde o desfecho - a pagina se atualiza sozinha.";

    case "INVALIDO":
      return (
        "Este evento foi reprovado na validacao e nunca chegou a ser enfileirado. " +
        "O payload nao muda por ser reprocessado: corrija na origem e reenvie o webhook."
      );

    default:
      return `Um evento em ${status} nao pode ser reenfileirado.`;
  }
}

/**
 * Devolve o evento a fila.
 *
 * Idempotente por natureza: chamar duas vezes seguidas recusa a segunda, porque
 * a primeira ja tirou o evento do estado ERRO. Dois cliques apressados nao geram
 * dois processamentos.
 */
export async function reenfileirar(idTransacao: string): Promise<RequeueOutcome> {
  const evento = await prisma.paymentEvent.findUnique({
    where: { idTransacao },
    include: { job: true },
  });

  if (!evento) {
    registrarReenfileiramento("nao_encontrado");

    return {
      ok: false,
      failure: "not_found",
      message: `Nenhum evento com id_transacao '${idTransacao}'.`,
    };
  }

  // So ERRO. SUCESSO somaria o pagamento uma segunda vez ao contrato - e a
  // idempotencia nao protege aqui: ela impede um evento DUPLICADO de entrar, nao
  // impede o MESMO evento de ser processado duas vezes.
  if (evento.statusProcessamento !== "ERRO") {
    // Vale contar as recusas: uma subida delas costuma significar que o painel
    // esta oferecendo o botao onde nao deveria, ou que quem opera nao entendeu
    // por que ele nao funciona.
    registrarReenfileiramento("recusado");

    return {
      ok: false,
      failure: "not_eligible",
      message: motivoDaRecusa(evento.statusProcessamento),
    };
  }

  const agora = new Date();

  // Zerar as tentativas e deliberado: um item que falhou esgotou o orcamento, e
  // devolve-lo sem zerar falharia na primeira tentativa e morreria de novo - o
  // botao pareceria nao funcionar. Quem clica esta afirmando que a causa foi
  // tratada, e isso e um novo orcamento.
  //
  // `disponivelEm` agora, sem backoff: o backoff protege uma dependencia
  // instavel de um laco automatico. Aqui houve um clique, e alguem esta
  // esperando o resultado.
  //
  // `ultimoErro` e o diagnostico do evento NAO sao limpos: se a nova tentativa
  // falhar, eles sao sobrescritos; se passar, o sucesso os limpa. Apaga-los aqui
  // destruiria o unico registro do que aconteceu, justo enquanto alguem
  // investiga.

  // Tipado explicitamente: sem a anotacao, o TypeScript infere o tipo do
  // PRIMEIRO elemento (uma promise de PaymentEvent) e recusa a operacao de
  // ProcessingJob que vem depois.
  const operacoes: Prisma.PrismaPromise<unknown>[] = [
    prisma.paymentEvent.update({
      where: { id: evento.id },
      data: { statusProcessamento: "PENDENTE", processadoEm: null, tentativas: 0 },
    }),
  ];

  if (evento.job) {
    operacoes.push(
      prisma.processingJob.update({
        where: { id: evento.job.id },
        data: {
          estado: "PENDENTE",
          tentativas: 0,
          disponivelEm: agora,
          reivindicadoEm: null,
          reivindicadoPor: null,
          atualizadoEm: agora,
        },
      }),
    );
  } else {
    // Um evento em ERRO sempre teve job - eles nascem na mesma transacao do
    // webhook. Chegar aqui significa que a linha da fila foi apagada a mao.
    // Recriar e melhor do que recusar: o dado que importa (o evento bruto) esta
    // intacto, e e dele que o job deriva.
    console.warn(
      `[bff-requeue] evento ${idTransacao} estava em ERRO sem job na fila; um novo foi criado.`,
    );

    operacoes.push(
      prisma.processingJob.create({
        data: {
          id: uuidV7(),
          paymentEventId: evento.id,
          estado: "PENDENTE",
          tentativas: 0,
          maxTentativas: bffConfig.processing.maxTentativas,
          disponivelEm: agora,
          criadoEm: agora,
          atualizadoEm: agora,
        },
      }),
    );
  }

  // Os dois na MESMA transacao: um evento em PENDENTE sem job na fila ficaria
  // parado para sempre, e um job pendente cujo evento continua em ERRO mostraria
  // no painel um estado que nao corresponde ao que vai acontecer.
  await prisma.$transaction(operacoes);

  registrarReenfileiramento("reenfileirado");

  return {
    ok: true,
    value: {
      id_transacao: evento.idTransacao,
      status_processamento: "PENDENTE",
      reenfileirado_em: agora.toISOString(),
      message: "Evento devolvido a fila. O processamento acontece em segundo plano.",
    },
  };
}
