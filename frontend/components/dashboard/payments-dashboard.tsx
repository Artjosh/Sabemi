"use client";

import * as React from "react";

import { useAuth } from "@/components/auth-provider";
import {
  ActiveBackendBadge,
  BackendSwitcher,
} from "@/components/backend-switcher";
import { FailureTooltip } from "@/components/dashboard/failure-tooltip";
import { PaymentDetailDialog } from "@/components/dashboard/payment-detail-dialog";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import { Button } from "@/components/ui/button";
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ApiError,
  getHealth,
  getPaymentSummary,
  listPayments,
} from "@/lib/api-client";
import type {
  BackendId,
  PagedResult,
  PaymentEventDto,
  PaymentSummaryDto,
  ProcessingStatus,
} from "@/lib/contracts";
import { PROCESSING_STATUSES, STATUS_LABELS } from "@/lib/contracts";
import {
  cn,
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils";

/**
 * Dashboard administrativo.
 *
 * <b>Atualizacao por polling.</b> A tabela se atualiza sozinha a cada 5s. A
 * alternativa seria WebSocket/SSE, e ela foi descartada por analise e nao por
 * conveniencia: o dado aqui muda em segundos (o tempo do processamento), a
 * quantidade de operadores simultaneos e pequena, e o custo de uma conexao
 * persistente - reconexao, proxies que cortam conexoes ociosas, aderencia de
 * sessao no balanceador - nao se paga. O polling ainda tem uma vantagem que
 * importa neste projeto: funciona identicamente nos dois backends, sem exigir
 * que cada um implemente transporte de tempo real.
 *
 * <b>Atualizacao sem piscar.</b> O esqueleto de carregamento so aparece na
 * primeira carga. Nos ciclos seguintes os dados sao trocados por baixo, sem
 * desmontar a tabela: uma tela que pisca a cada 5s e inutilizavel.
 */

const REFRESH_INTERVAL_MS = 5000;
const PAGE_SIZE = 20;

/** Valor sentinela do filtro "todas" - Radix Select nao aceita item com valor "". */
const TODOS = "__todos__";

export function PaymentsDashboard() {
  const { user, logout } = useAuth();

  const [pagina, setPagina] =
    React.useState<PagedResult<PaymentEventDto> | null>(null);
  const [resumo, setResumo] = React.useState<PaymentSummaryDto | null>(null);
  const [backendReal, setBackendReal] = React.useState<BackendId | null>(null);

  const [statusFiltro, setStatusFiltro] = React.useState<string>(TODOS);
  const [contratoInput, setContratoInput] = React.useState("");
  const [contratoFiltro, setContratoFiltro] = React.useState("");
  const [page, setPage] = React.useState(1);

  const [carregandoInicial, setCarregandoInicial] = React.useState(true);
  const [erro, setErro] = React.useState<string | null>(null);
  const [atualizandoAgora, setAtualizandoAgora] = React.useState(false);
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [ultimaAtualizacao, setUltimaAtualizacao] = React.useState<Date | null>(
    null,
  );
  const [detalhe, setDetalhe] = React.useState<string | null>(null);

  // Debounce do filtro por contrato: sem ele, cada tecla dispararia uma consulta.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setContratoFiltro(contratoInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [contratoInput]);

  const buscar = React.useCallback(
    async (silencioso: boolean) => {
      if (!silencioso) setAtualizandoAgora(true);

      try {
        const [dados, totais] = await Promise.all([
          listPayments({
            status:
              statusFiltro === TODOS
                ? null
                : (statusFiltro as ProcessingStatus),
            contractId: contratoFiltro || null,
            page,
            pageSize: PAGE_SIZE,
          }),
          getPaymentSummary(),
        ]);

        setPagina(dados);
        setResumo(totais);
        setUltimaAtualizacao(new Date());
        setErro(null);
      } catch (error) {
        // Sessao expirada durante o polling: manda para o login em vez de
        // repetir o erro a cada 5s.
        if (error instanceof ApiError && error.status === 401) {
          window.location.assign("/login");
          return;
        }
        setErro(
          error instanceof ApiError
            ? error.message
            : "Falha ao carregar os pagamentos.",
        );
      } finally {
        setCarregandoInicial(false);
        setAtualizandoAgora(false);
      }
    },
    [statusFiltro, contratoFiltro, page],
  );

  // Confirma qual backend respondeu de fato - nao apenas qual foi pedido.
  React.useEffect(() => {
    getHealth()
      .then((h) => setBackendReal(h.backend))
      .catch(() => setBackendReal(null));
  }, []);

  // Recarrega quando um filtro muda.
  React.useEffect(() => {
    void buscar(false);
  }, [buscar]);

  // O laco de atualizacao automatica.
  React.useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void buscar(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, buscar]);

  const limparFiltros = () => {
    setStatusFiltro(TODOS);
    setContratoInput("");
    setPage(1);
  };

  const temFiltro = statusFiltro !== TODOS || contratoFiltro !== "";
  const totalPaginas = pagina
    ? Math.max(1, Math.ceil(pagina.total / pagina.page_size))
    : 1;

  return (
    // Um unico Provider para a tela inteira. O Radix exige um ancestral; um por
    // linha da tabela criaria vinte contextos identicos e cada um com o proprio
    // temporizador de atraso.
    <TooltipProvider>
      <div className="min-h-screen">
        {/*
          CABECALHO
          ---------
          Uma faixa so, fixa no topo, com tres zonas: identidade a esquerda,
          origem dos dados no centro, acoes a direita. A versao anterior
          espalhava seis controles soltos na mesma linha, nenhum parecendo mais
          importante que o outro. Agora as acoes que so mexem NESTA tela
          (pausar, atualizar, tema) moram num unico grupo segmentado, e "Sair"
          fica de fora dele - e a unica que tira o operador de onde ele esta.

          O grid do Bootstrap organiza o esqueleto responsivo; o estilo e todo
          Tailwind. Ver a divisao de responsabilidades em app/globals.css.
        */}
        <header className="sticky top-0 z-30 border-b border-border-subtle bg-surface/80 backdrop-blur-xl">
          <div className="container-fluid px-3 px-lg-4">
            <div className="row align-items-center gy-3 py-3">
              <div className="col-12 col-lg-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-contrast shadow-card">
                    <i className="bi bi-receipt-cutoff text-lg" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <h1 className="truncate text-[0.95rem] font-semibold leading-tight tracking-[-0.01em]">
                      Painel de Pagamentos
                    </h1>
                    <p className="truncate text-xs text-fg-muted">{user?.email ?? "—"}</p>
                  </div>
                </div>
              </div>

              <div className="col-12 col-lg-4">
                <div className="flex flex-wrap items-center gap-2 lg:justify-center">
                  <BackendSwitcher />
                  <ActiveBackendBadge backend={backendReal} />
                </div>
              </div>

              <div className="col-12 col-lg-4">
                <div className="flex items-center justify-start gap-2 lg:justify-end">
                  <div className="flex items-center gap-0.5 rounded-full border border-border-subtle bg-surface p-1 shadow-card">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-full"
                      onClick={() => setAutoRefresh((v) => !v)}
                      aria-label={autoRefresh ? "Pausar" : "Retomar"}
                      title={
                        autoRefresh
                          ? "Pausar atualização automática"
                          : "Retomar atualização automática"
                      }
                    >
                      <i
                        className={cn("bi", autoRefresh ? "bi-pause-fill" : "bi-play-fill")}
                        aria-hidden="true"
                      />
                    </Button>

                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-full"
                      onClick={() => void buscar(false)}
                      aria-label="Atualizar"
                      title="Atualizar agora"
                    >
                      <i
                        className={cn(
                          "bi bi-arrow-clockwise",
                          atualizandoAgora && "animate-spin",
                        )}
                        aria-hidden="true"
                      />
                    </Button>

                    <ThemeToggle />
                  </div>

                  <Button variant="ghost" size="sm" onClick={() => void logout()}>
                    <i className="bi bi-box-arrow-right" aria-hidden="true" />
                    Sair
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* A largura maxima existe porque a tabela tem oito colunas: sem ela,
            num monitor ultrawide, o olho percorre a tela inteira entre o status
            e o botao de detalhe da MESMA linha. */}
        <main className="container-fluid mx-auto max-w-[1600px] px-3 px-lg-4 py-6">
          <SummaryCards resumo={resumo} carregando={carregandoInicial} />

          {erro ? (
            <Alert tone="error" icon="bi-wifi-off" className="mb-5">
              <p className="font-semibold">Não foi possível atualizar</p>
              <p className="mt-0.5 text-xs opacity-90">{erro}</p>
            </Alert>
          ) : null}

          <Card className="overflow-hidden">
            {/*
              BARRA DE FILTROS
              ----------------
              Os controles ficam numa linha so, alinhados pela base, em vez de
              tres colunas do grid com um rotulo em cima de cada uma - que
              empurrava a tabela para baixo e fazia o cartao comecar com um
              bloco de formulario. A faixa tem fundo proprio para se ler como
              barra de ferramentas da tabela, e nao como conteudo dela.
            */}
            <CardHeader className="gap-4 border-b border-border-subtle bg-surface-muted/40">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-baseline gap-2.5">
                  <CardTitle>Eventos recebidos</CardTitle>
                  {pagina ? (
                    <span className="tabular text-xs text-fg-muted">
                      {pagina.total} no total
                    </span>
                  ) : null}
                </div>

                {/* O ponto verde pulsando e o unico sinal de que a tela esta
                    viva entre dois ciclos de polling. */}
                <span
                  className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-xs text-fg-muted"
                  aria-live="polite"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      autoRefresh ? "animate-pulse bg-state-success" : "bg-state-neutral",
                    )}
                  />
                  {ultimaAtualizacao
                    ? `Atualizado ${formatRelative(ultimaAtualizacao.toISOString())}`
                    : "—"}
                  {autoRefresh ? " · atualização automática ativa" : " · pausado"}
                </span>
              </div>

              {/* Os dois filtros exigidos pela task: situacao e contrato. */}
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex min-w-[11rem] flex-col gap-1.5">
                  <Label htmlFor="filtro-status">Status</Label>
                  <Select
                    value={statusFiltro}
                    onValueChange={(v) => {
                      setStatusFiltro(v);
                      setPage(1);
                    }}
                  >
                    <SelectTrigger id="filtro-status" aria-label="Filtrar por status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={TODOS}>Todos os status</SelectItem>
                      {PROCESSING_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {STATUS_LABELS[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex min-w-[13rem] flex-1 flex-col gap-1.5">
                  <Label htmlFor="filtro-contrato">ID do contrato</Label>
                  <div className="relative">
                    <i
                      className="bi bi-search pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted"
                      aria-hidden="true"
                    />
                    <Input
                      id="filtro-contrato"
                      className="pl-8"
                      placeholder="CTR-00000"
                      value={contratoInput}
                      onChange={(e) => setContratoInput(e.target.value)}
                    />
                  </div>
                </div>

                <Button variant="subtle" onClick={limparFiltros} disabled={!temFiltro}>
                  <i className="bi bi-x-circle" aria-hidden="true" />
                  Limpar filtros
                </Button>
              </div>
            </CardHeader>

            <CardContent className="p-0">
              {carregandoInicial ? (
                <div className="flex flex-col gap-px">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-none" />
                  ))}
                </div>
              ) : pagina && pagina.items.length > 0 ? (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="pl-5">Status</TableHead>
                        <TableHead>ID transação</TableHead>
                        <TableHead>Contrato</TableHead>
                        <TableHead className="text-right">Valor</TableHead>
                        <TableHead>Pagamento</TableHead>
                        <TableHead>Recebido</TableHead>
                        <TableHead className="text-center">Tent.</TableHead>
                        <TableHead className="pr-5 text-right">Ações</TableHead>
                      </TableRow>
                    </TableHeader>

                    <TableBody>
                      {pagina.items.map((evento) => (
                        <PaymentRow
                          key={evento.id}
                          evento={evento}
                          onDetalhe={() => setDetalhe(evento.id_transacao)}
                        />
                      ))}
                    </TableBody>
                  </Table>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle bg-surface-muted/40 px-5 py-3 text-sm">
                    <span className="text-fg-muted">
                      {pagina.total} evento{pagina.total === 1 ? "" : "s"} · página{" "}
                      {pagina.page} de {totalPaginas}
                    </span>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pagina.page <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                      >
                        <i className="bi bi-chevron-left" aria-hidden="true" />
                        Anterior
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pagina.page >= totalPaginas}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Próxima
                        <i className="bi bi-chevron-right" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState temFiltro={temFiltro} onLimpar={limparFiltros} />
              )}
            </CardContent>
          </Card>
        </main>

        <PaymentDetailDialog
          idTransacao={detalhe}
          onOpenChange={(aberto) => {
            if (!aberto) setDetalhe(null);
          }}
        />
      </div>
    </TooltipProvider>
  );
}

/**
 * Uma linha da tabela.
 *
 * Eventos com problema recebem uma barra vermelha a esquerda e um fundo suave -
 * o requisito de "alerta visual claro". A distincao entre ERRO (falhou no
 * processamento) e INVALIDO (reprovado na validacao) e mantida: sao causas
 * diferentes e exigem acoes diferentes, embora as duas exijam atencao.
 *
 * <b>Hierarquia dentro da linha.</b> Oito colunas com o mesmo peso viram uma
 * parede de texto. Aqui so tres coisas tem peso cheio - o status, o
 * `id_transacao` e o valor -, que sao por onde o olho entra ao procurar um
 * pagamento. Contrato, datas e tentativas ficam em tom secundario: servem para
 * confirmar, nao para buscar.
 */
function PaymentRow({
  evento,
  onDetalhe,
}: {
  evento: PaymentEventDto;
  onDetalhe: () => void;
}) {
  const comProblema =
    evento.status_processamento === "ERRO" ||
    evento.status_processamento === "INVALIDO";

  return (
    <TableRow
      className={cn(
        "group",
        // Fundo bem diluido: o realce marca a linha de relance sem competir em
        // contraste com o texto que ela carrega.
        comProblema && "bg-state-error-soft/35 hover:bg-state-error-soft/55",
      )}
    >
      <TableCell className="relative pl-5">
        {comProblema ? (
          <span
            className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-state-error"
            aria-hidden="true"
          />
        ) : null}
        <StatusBadge status={evento.status_processamento} />
      </TableCell>

      <TableCell className="font-mono text-xs font-semibold">
        {evento.id_transacao}
      </TableCell>

      <TableCell className="font-mono text-xs text-fg-muted">
        {evento.id_contrato ?? "—"}
      </TableCell>

      <TableCell className="tabular whitespace-nowrap text-right text-[0.9rem] font-semibold">
        {formatCurrency(evento.valor)}
      </TableCell>

      <TableCell className="tabular whitespace-nowrap text-xs text-fg-muted">
        {formatDateTime(evento.data_pagamento)}
      </TableCell>

      <TableCell
        className="whitespace-nowrap text-xs text-fg-muted"
        title={formatDateTime(evento.recebido_em)}
      >
        {formatRelative(evento.recebido_em)}
      </TableCell>

      <TableCell className="text-center">
        <span
          className={cn(
            "tabular inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs",
            // Mais de uma tentativa e informacao: alguem ja teve trabalho com
            // este evento. Uma so e o caso normal e nao merece destaque.
            evento.tentativas > 1
              ? "bg-state-warning-soft font-semibold text-state-warning"
              : "text-fg-muted",
          )}
        >
          {evento.tentativas}
        </span>
      </TableCell>

      <TableCell className="pr-5 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {/* A CAUSA fica visivel sem precisar abrir o detalhe: e a informacao
              que o operador procura ao ver uma linha vermelha.

              Antes, esta celula mostrava a mensagem crua da excecao truncada em
              16rem - algo como "23503: insert or update on table..." cortado no
              meio. Agora mostra a leitura, e o tooltip traz a explicacao inteira
              mais o que fazer. A mensagem tecnica continua a um clique, no
              detalhe do evento, que e onde ela serve. */}
          {evento.diagnostico ? (
            <FailureTooltip
              diagnostico={evento.diagnostico}
              mensagemTecnica={evento.erro}
            />
          ) : null}

          {/* O botao so fica opaco quando o ponteiro esta na linha: com vinte
              linhas na tela, vinte icones em contraste cheio competem entre si
              e com o dado. Ele continua sempre focavel pelo teclado - e a
              opacidade que muda, nao a existencia do alvo. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onDetalhe}
            aria-label="Ver detalhes"
            className="opacity-55 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <i className="bi bi-eye" aria-hidden="true" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function EmptyState({
  temFiltro,
  onLimpar,
}: {
  temFiltro: boolean;
  onLimpar: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-5 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-muted ring-1 ring-inset ring-border-subtle">
        <i className="bi bi-inbox text-2xl text-fg-muted" aria-hidden="true" />
      </div>

      <div>
        <p className="text-base font-semibold">
          {temFiltro
            ? "Nenhum evento com esses filtros"
            : "Nenhum evento recebido ainda"}
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">
          {temFiltro
            ? "Ajuste os filtros para ver outros resultados."
            : "Assim que o banco parceiro enviar uma notificação, ela aparece aqui."}
        </p>
      </div>

      {temFiltro ? (
        <Button variant="outline" size="sm" onClick={onLimpar}>
          Limpar filtros
        </Button>
      ) : null}
    </div>
  );
}
