"use client";

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, Separator, Skeleton, StatusBadge } from "@/components/ui/primitives";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError, getContract, getPaymentDetail, requeuePayment } from "@/lib/api-client";
import type { ContractStatusDto, PaymentEventDetailDto } from "@/lib/contracts";

import { FailureTooltip } from "./failure-tooltip";
import { formatCurrency, formatDateTime } from "@/lib/utils";

/**
 * Detalhe de um evento.
 *
 * Mostra tres coisas que a linha da tabela nao comporta:
 *
 *   1. o <b>payload bruto</b> exatamente como chegou - o que torna a tabela de
 *      eventos uma trilha de auditoria de verdade, e nao so um resumo;
 *   2. o <b>motivo completo</b> da falha, sem o truncamento da tabela;
 *   3. o <b>estado consolidado do contrato</b>, que responde a pergunta seguinte
 *      a "este pagamento entrou?" - "e como ficou o contrato?".
 *
 * Os dados sao buscados na abertura, e nao junto com a lista: trazer o payload
 * bruto de 20 eventos a cada ciclo de 5s multiplicaria o trafego para exibir
 * algo que quase nunca e aberto.
 */
export function PaymentDetailDialog({
  idTransacao,
  onOpenChange,
}: {
  idTransacao: string | null;
  onOpenChange: (aberto: boolean) => void;
}) {
  const [evento, setEvento] = React.useState<PaymentEventDetailDto | null>(null);
  const [contrato, setContrato] = React.useState<ContractStatusDto | null>(null);
  const [carregando, setCarregando] = React.useState(false);
  const [erro, setErro] = React.useState<string | null>(null);

  /**
   * Estado do reenfileiramento. Separado do `erro` da carga: uma recusa do
   * reenfileiramento nao pode substituir a tela do evento por uma mensagem de
   * erro - o operador precisa continuar vendo o que estava lendo.
   */
  const [reenfileirando, setReenfileirando] = React.useState(false);
  const [avisoRequeue, setAvisoRequeue] = React.useState<
    { tom: "success" | "error"; texto: string } | null
  >(null);

  React.useEffect(() => {
    // O aviso e sempre limpo, inclusive ao reabrir o MESMO evento: um "devolvido
    // a fila" de minutos atras, ainda na tela, faria o operador crer que acabou
    // de acontecer.
    setAvisoRequeue(null);

    if (!idTransacao) {
      setEvento(null);
      setContrato(null);
      setErro(null);
      return;
    }

    let activo = true;
    setCarregando(true);
    setErro(null);

    (async () => {
      try {
        const detalhe = await getPaymentDetail(idTransacao);
        if (!activo) return;
        setEvento(detalhe);

        // O contrato pode nao existir ainda (evento invalido, ou pendente de
        // processamento). Ausencia aqui e normal e nao vira erro na tela.
        if (detalhe.id_contrato) {
          try {
            const c = await getContract(detalhe.id_contrato);
            if (activo) setContrato(c);
          } catch {
            if (activo) setContrato(null);
          }
        }
      } catch (error) {
        if (activo) {
          setErro(error instanceof ApiError ? error.message : "Falha ao carregar o evento.");
        }
      } finally {
        if (activo) setCarregando(false);
      }
    })();

    return () => {
      activo = false;
    };
  }, [idTransacao]);

  /**
   * Devolve o evento a fila e ATUALIZA a tela com o estado novo.
   *
   * Recarregar o detalhe em vez de so mostrar "ok" e o que impede o operador de
   * clicar duas vezes: depois da primeira, o evento ja esta em PENDENTE e o
   * botao desaparece sozinho.
   */
  async function aoReenfileirar() {
    if (!idTransacao || reenfileirando) return;

    setReenfileirando(true);
    setAvisoRequeue(null);

    try {
      const resultado = await requeuePayment(idTransacao);
      setAvisoRequeue({ tom: "success", texto: resultado.message });

      // Releitura em vez de mutacao local: o estado autoritativo e o do
      // servidor, e o worker pode ate ja ter comecado a processar.
      setEvento(await getPaymentDetail(idTransacao));
    } catch (error) {
      // A mensagem do 409 e escrita para o operador ("ja foi processado com
      // sucesso e o valor ja esta somado ao contrato"), entao vai para a tela
      // como veio.
      setAvisoRequeue({
        tom: "error",
        texto:
          error instanceof ApiError
            ? error.message
            : "Não foi possível reenfileirar o evento.",
      });
    } finally {
      setReenfileirando(false);
    }
  }

  return (
    <Dialog open={idTransacao !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{idTransacao}</DialogTitle>
          <DialogDescription>Evento recebido pelo webhook de pagamentos</DialogDescription>
        </DialogHeader>

        {carregando ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : erro ? (
          <Alert tone="error" icon="bi-exclamation-octagon-fill">
            {erro}
          </Alert>
        ) : evento ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={evento.status_processamento} />
              {evento.status_origem ? (
                <span className="text-xs text-[color:var(--muted-foreground)]">
                  status do parceiro: <strong>{evento.status_origem}</strong>
                </span>
              ) : null}
            </div>

            {evento.erro ? (
              <Alert
                tone={evento.status_processamento === "INVALIDO" ? "warning" : "error"}
                icon="bi-exclamation-triangle-fill"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-semibold">
                    {evento.status_processamento === "INVALIDO"
                      ? "Reprovado na validação"
                      : "Falha no processamento"}
                  </p>

                  {/* A leitura da falha ao lado do titulo. A mensagem tecnica
                      continua logo abaixo, inteira: aqui e onde alguem investiga,
                      e truncar o que ele veio ler seria contraproducente. */}
                  {evento.diagnostico ? (
                    <TooltipProvider>
                      <FailureTooltip diagnostico={evento.diagnostico} />
                    </TooltipProvider>
                  ) : null}
                </div>

                {evento.diagnostico ? (
                  <p className="mt-2 text-xs">{evento.diagnostico.explicacao}</p>
                ) : null}

                <p className="mt-2 font-mono text-[11px] opacity-80">{evento.erro}</p>

                {evento.diagnostico ? (
                  <p className="mt-2 text-xs">
                    <strong>O que fazer:</strong> {evento.diagnostico.acao_sugerida}
                  </p>
                ) : null}

                {/* O botao so aparece em ERRO. Nos demais estados o servidor
                    recusaria com 409, e oferecer uma acao que sempre falha e
                    pior do que nao oferecer nenhuma. */}
                {evento.status_processamento === "ERRO" ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={aoReenfileirar}
                      disabled={reenfileirando}
                    >
                      <i
                        className={
                          reenfileirando
                            ? "bi bi-arrow-repeat animate-spin"
                            : "bi bi-arrow-counterclockwise"
                        }
                        aria-hidden="true"
                      />
                      {reenfileirando ? "Reenfileirando…" : "Reenfileirar"}
                    </Button>

                    <span className="text-xs opacity-80">
                      Devolve o evento à fila. O processamento acontece em segundo plano.
                    </span>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            {avisoRequeue ? (
              <Alert
                tone={avisoRequeue.tom}
                icon={
                  avisoRequeue.tom === "success"
                    ? "bi-check-circle-fill"
                    : "bi-exclamation-octagon-fill"
                }
              >
                {avisoRequeue.texto}
              </Alert>
            ) : null}

            <dl className="row gy-3 gx-3 text-sm">
              <Field label="Contrato" value={evento.id_contrato ?? "—"} mono />
              <Field label="Valor" value={formatCurrency(evento.valor)} />
              <Field label="Data do pagamento" value={formatDateTime(evento.data_pagamento)} />
              <Field label="Recebido em" value={formatDateTime(evento.recebido_em)} />
              <Field label="Processado em" value={formatDateTime(evento.processado_em)} />
              <Field label="Tentativas" value={String(evento.tentativas)} />
            </dl>

            {contrato ? (
              <>
                <Separator />
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
                    Estado do contrato
                  </h4>
                  <dl className="row gy-3 gx-3 text-sm">
                    <Field
                      label="Total liquidado"
                      value={formatCurrency(contrato.valor_total_liquidado)}
                    />
                    <Field
                      label="Pagamentos confirmados"
                      value={String(contrato.pagamentos_confirmados)}
                    />
                    <Field label="Situação" value={contrato.situacao} />
                    <Field
                      label="Última transação"
                      value={contrato.ultima_transacao ?? "—"}
                      mono
                    />
                  </dl>
                </section>
              </>
            ) : null}

            <>
              <Separator />
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--muted-foreground)]">
                  Payload bruto recebido
                </h4>
                <pre className="max-h-64 overflow-auto rounded-lg bg-surface-muted p-3 text-xs leading-relaxed">
                  <code>{prettyJson(evento.payload_bruto)}</code>
                </pre>
              </section>
            </>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="col-6">
      <dt className="text-xs text-[color:var(--muted-foreground)]">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : "tabular font-medium"}>{value}</dd>
    </div>
  );
}

/**
 * Formata o payload para leitura.
 *
 * Se nao for JSON valido, mostra o texto como veio - um corpo malformado e
 * exatamente o tipo de coisa que se quer poder ver aqui.
 */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
