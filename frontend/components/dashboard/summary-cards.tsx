"use client";

import { Card, Skeleton } from "@/components/ui/primitives";
import type { PaymentSummaryDto } from "@/lib/contracts";
import { cn } from "@/lib/utils";

/**
 * Faixa de totais no topo do dashboard.
 *
 * <b>Quais estados aparecem, e por que estes.</b> A task pede filtros por
 * "Sucesso" e "Erro". Os totais vao alem porque o processamento e assincrono e
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
 *
 * <b>Um cartao, cinco segmentos - e nao cinco cartoes.</b> Cinco caixas soltas
 * com borda e sombra proprias davam a cinco numeros relacionados a aparencia de
 * cinco widgets independentes, e o olho tinha de atravessar cinco molduras para
 * comparar dois valores. Aqui a moldura e uma so e os segmentos se separam por
 * uma linha de 1px: comparar vira ler uma linha.
 *
 * <b>A barra de cor no topo</b> substitui o quadrado do icone a esquerda. Ela
 * ocupa menos espaco, nao concorre com o numero, e - por ser a mesma cor do
 * badge daquele estado na tabela - liga o total a linha correspondente. O icone
 * continua presente ao lado do rotulo, porque cor sozinha nao e sinal
 * acessivel.
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
      barra: "bg-state-neutral",
      descricao: "eventos no log bruto",
    },
    {
      titulo: "Processados",
      valor: contagem.SUCESSO ?? 0,
      icone: "bi-check-circle-fill",
      cor: "text-state-success",
      barra: "bg-state-success",
      descricao: "contrato atualizado",
    },
    {
      titulo: "Na fila",
      valor: naFila,
      icone: "bi-hourglass-split",
      cor: "text-state-info",
      barra: "bg-state-info",
      descricao: "aguardando o worker",
    },
    {
      titulo: "Com erro",
      valor: contagem.ERRO ?? 0,
      icone: "bi-x-octagon-fill",
      cor: "text-state-error",
      barra: "bg-state-error",
      descricao: "falhou após as tentativas",
    },
    {
      titulo: "Inválidos",
      valor: contagem.INVALIDO ?? 0,
      icone: "bi-exclamation-triangle-fill",
      cor: "text-state-error",
      barra: "bg-state-error",
      descricao: "reprovados na validação",
    },
  ];

  return (
    <Card className="mb-5 overflow-hidden">
      {/* O grid do Bootstrap divide a faixa; as divisorias sao Tailwind. */}
      <div className="row g-0">
        {cartoes.map((cartao, indice) => (
          <div
            key={cartao.titulo}
            className={cn(
              "col-6 col-lg-4 col-xl border-border-subtle",
              // A divisoria acompanha quantos segmentos cabem por linha em cada
              // breakpoint (2, depois 3, depois 5). Sem isso sobraria um traco
              // solto encostado na borda do cartao toda vez que a faixa quebra.
              indice % 2 !== 0 ? "border-l" : "border-l-0",
              indice % 3 !== 0 ? "lg:border-l" : "lg:border-l-0",
              indice !== 0 ? "xl:border-l" : "xl:border-l-0",
              indice >= 2 ? "border-t" : "border-t-0",
              indice >= 3 ? "lg:border-t" : "lg:border-t-0",
              "xl:border-t-0",
            )}
          >
            <div className="relative h-full p-4 pt-5">
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-4 top-0 h-1 w-8 rounded-b-full",
                  cartao.barra,
                )}
              />

              {carregando ? (
                <Skeleton className="h-9 w-16" />
              ) : (
                <p className="metric text-[2.15rem] font-semibold">{cartao.valor}</p>
              )}

              <p className="mt-2 flex items-center gap-1.5 truncate text-[0.8rem] font-semibold">
                <i className={cn("bi", cartao.icone, cartao.cor)} aria-hidden="true" />
                {cartao.titulo}
              </p>
              <p className="truncate text-[0.7rem] leading-snug text-fg-muted">
                {cartao.descricao}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
