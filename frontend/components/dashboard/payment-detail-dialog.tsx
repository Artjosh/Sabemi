"use client";

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, Separator, Skeleton, StatusBadge } from "@/components/ui/primitives";
import { ApiError, getContract, getPaymentDetail } from "@/lib/api-client";
import type { ContractStatusDto, PaymentEventDetailDto } from "@/lib/contracts";
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

  React.useEffect(() => {
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
                <p className="font-semibold">
                  {evento.status_processamento === "INVALIDO"
                    ? "Reprovado na validação"
                    : "Falha no processamento"}
                </p>
                <p className="mt-1 text-xs">{evento.erro}</p>
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
