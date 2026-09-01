"use client";

import { Card, CardContent, Skeleton } from "@/components/ui/primitives";
import type { PaymentSummaryDto } from "@/lib/contracts";
import { cn } from "@/lib/utils";

/**
 * Cartoes de totais no topo do dashboard.
 *
 * <b>Quais estados aparecem, e por que estes.</b> A task pede filtros por
 * "Sucesso" e "Erro". Os cartoes vao alem porque o processamento e assincrono e
 * um operador precisa distinguir tres situacoes que um par sucesso/erro
 * esconderia:
 *
 *   * <b>Na fila</b> (pendente + processando) - ainda vai acontecer. Se este
 *     numero cresce sem parar, o worker parou; e o sinal mais util do painel.
 *   * <b>Erro</b> - falhou apos as tentativas. Exige investigacao.
 *   * <b>Inválido</b> - reprovado na validacao. O problema esta no payload do
 *     parceiro, nao no nosso processamento. Causa diferente, acao diferente.
 *
 * "Na fila" agrega dois estados de proposito: para quem opera, "esperando" e
 * "rodando agora" levam a mesma conclusao - ha trabalho em andamento.
 */
export function SummaryCards({
  resumo,
  carregando,
}: {
  resumo: PaymentSummaryDto | null;
  carregando: boolean;
}) {
  const contagem = resumo?.por_status ?? {};

  const naFila = (contagem.PENDENTE ?? 0) + (contagem.PROCESSANDO ?? 0);

  const cartoes = [
    {
      titulo: "Total recebido",
      valor: resumo?.total ?? 0,
      icone: "bi-inbox-fill",
      cor: "text-state-neutral",
      fundo: "bg-state-neutral-soft",
      descricao: "eventos no log bruto",
    },
    {
      titulo: "Processados",
      valor: contagem.SUCESSO ?? 0,
      icone: "bi-check-circle-fill",
      cor: "text-state-success",
      fundo: "bg-state-success-soft",
      descricao: "contrato atualizado",
    },
    {
      titulo: "Na fila",
      valor: naFila,
      icone: "bi-hourglass-split",
      cor: "text-state-info",
      fundo: "bg-state-info-soft",
      descricao: "aguardando o worker",
    },
    {
      titulo: "Com erro",
      valor: contagem.ERRO ?? 0,
      icone: "bi-x-octagon-fill",
      cor: "text-state-error",
      fundo: "bg-state-error-soft",
      descricao: "falhou após as tentativas",
    },
    {
      titulo: "Inválidos",
      valor: contagem.INVALIDO ?? 0,
      icone: "bi-exclamation-triangle-fill",
      cor: "text-state-warning",
      fundo: "bg-state-warning-soft",
      descricao: "reprovados na validação",
    },
  ];

  return (
    <div className="row gy-3 gx-3 mb-4">
      {cartoes.map((cartao) => (
        <div key={cartao.titulo} className="col-6 col-lg-4 col-xl">
          <Card className="h-full">
            <CardContent className="flex items-center gap-3 p-4">
              <div
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                  cartao.fundo,
                )}
              >
                <i className={cn("bi", cartao.icone, cartao.cor)} aria-hidden="true" />
              </div>

              <div className="min-w-0">
                {carregando ? (
                  <Skeleton className="h-7 w-12" />
                ) : (
                  <p className="tabular text-2xl font-semibold leading-none">{cartao.valor}</p>
                )}
                <p className="mt-1 truncate text-xs font-medium">{cartao.titulo}</p>
                <p className="truncate text-[0.7rem] text-[color:var(--muted-foreground)]">
                  {cartao.descricao}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}
