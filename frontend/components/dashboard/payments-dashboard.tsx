"use client";

import * as React from "react";

import { useAuth } from "@/components/auth-provider";
import { ActiveBackendBadge, BackendSwitcher } from "@/components/backend-switcher";
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
import { ApiError, getHealth, getPaymentSummary, listPayments } from "@/lib/api-client";
import type {
  BackendId,
  PagedResult,
  PaymentEventDto,
  PaymentSummaryDto,
  ProcessingStatus,
} from "@/lib/contracts";
import { PROCESSING_STATUSES, STATUS_LABELS } from "@/lib/contracts";
import { cn, formatCurrency, formatDateTime, formatRelative } from "@/lib/utils";

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

  const [pagina, setPagina] = React.useState<PagedResult<PaymentEventDto> | null>(null);
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
  const [ultimaAtualizacao, setUltimaAtualizacao] = React.useState<Date | null>(null);
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
            status: statusFiltro === TODOS ? null : (statusFiltro as ProcessingStatus),
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
        setErro(error instanceof ApiError ? error.message : "Falha ao carregar os pagamentos.");
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
  const totalPaginas = pagina ? Math.max(1, Math.ceil(pagina.total / pagina.page_size)) : 1;

  return (
    <div className="min-h-screen">
      {/* O grid do Bootstrap organiza o esqueleto responsivo; o estilo e todo
          Tailwind. Ver a divisao de responsabilidades em app/globals.css. */}
      <header className="border-b border-border-subtle bg-surface">
        <div className="container-fluid px-3 px-lg-4">
          <div className="row align-items-center gy-2 py-3">
            <div className="col-12 col-lg-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white">
                  <i className="bi bi-receipt-cutoff" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-semibold leading-tight">
                    Painel de Pagamentos
                  </h1>
                  <p className="truncate text-xs text-[color:var(--muted-foreground)]">
                    {user?.email ?? "—"}
                  </p>
                </div>
              </div>
            </div>

            <div className="col-12 col-lg-5">
              <div className="flex flex-wrap items-center gap-2 lg:justify-center">
                <BackendSwitcher hasSession={Boolean(user)} />
                <ActiveBackendBadge backend={backendReal} />
              </div>
            </div>

            <div className="col-12 col-lg-3">
              <div className="flex items-center justify-start gap-2 lg:justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAutoRefresh((v) => !v)}
                  title={autoRefresh ? "Pausar atualização automática" : "Retomar atualização automática"}
                >
                  <i
                    className={cn("bi", autoRefresh ? "bi-pause-fill" : "bi-play-fill")}
                    aria-hidden="true"
                  />
                  {autoRefresh ? "Pausar" : "Retomar"}
                </Button>

                <Button variant="outline" size="sm" onClick={() => void buscar(false)}>
                  <i
                    className={cn("bi bi-arrow-clockwise", atualizandoAgora && "animate-spin")}
                    aria-hidden="true"
                  />
                  Atualizar
                </Button>

                <Button variant="ghost" size="sm" onClick={() => void logout()}>
                  <i className="bi bi-box-arrow-right" aria-hidden="true" />
                  Sair
                </Button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container-fluid px-3 px-lg-4 py-4">
        <SummaryCards resumo={resumo} carregando={carregandoInicial} />

        {erro ? (
          <Alert tone="error" icon="bi-wifi-off" className="mb-4">
            <p className="font-semibold">Não foi possível atualizar</p>
            <p className="text-xs">{erro}</p>
          </Alert>
        ) : null}

        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Eventos recebidos</CardTitle>
              <span className="text-xs text-[color:var(--muted-foreground)]" aria-live="polite">
                {ultimaAtualizacao
                  ? `Atualizado ${formatRelative(ultimaAtualizacao.toISOString())}`
                  : "—"}
                {autoRefresh ? " · atualização automática ativa" : " · pausado"}
              </span>
            </div>

            {/* Os dois filtros exigidos pela task: situacao e contrato. */}
            <div className="row gy-2 gx-2">
              <div className="col-12 col-md-4 col-xl-3">
                <div className="flex flex-col gap-1.5">
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
              </div>

              <div className="col-12 col-md-5 col-xl-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="filtro-contrato">ID do contrato</Label>
                  <Input
                    id="filtro-contrato"
                    placeholder="CTR-00000"
                    value={contratoInput}
                    onChange={(e) => setContratoInput(e.target.value)}
                  />
                </div>
              </div>

              <div className="col-12 col-md-3 col-xl-2">
                <div className="flex h-full flex-col justify-end">
                  <Button
                    variant="subtle"
                    onClick={limparFiltros}
                    disabled={!temFiltro}
                    className="w-full"
                  >
                    <i className="bi bi-x-circle" aria-hidden="true" />
                    Limpar filtros
                  </Button>
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="px-0 pb-0">
            {carregandoInicial ? (
              <div className="flex flex-col gap-2 px-5 pb-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : pagina && pagina.items.length > 0 ? (
              <>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Status</TableHead>
                      <TableHead>ID transação</TableHead>
                      <TableHead>Contrato</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead>Pagamento</TableHead>
                      <TableHead>Recebido</TableHead>
                      <TableHead className="text-center">Tent.</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
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

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-5 py-3 text-sm">
                  <span className="text-[color:var(--muted-foreground)]">
                    {pagina.total} evento{pagina.total === 1 ? "" : "s"} · página {pagina.page} de{" "}
                    {totalPaginas}
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
  );
}

/**
 * Uma linha da tabela.
 *
 * Eventos com problema recebem uma barra vermelha a esquerda e um fundo suave -
 * o requisito de "alerta visual claro". A distincao entre ERRO (falhou no
 * processamento) e INVALIDO (reprovado na validacao) e mantida: sao causas
 * diferentes e exigem acoes diferentes, embora as duas exijam atencao.
 */
function PaymentRow({ evento, onDetalhe }: { evento: PaymentEventDto; onDetalhe: () => void }) {
  const comProblema = evento.status_processamento === "ERRO" || evento.status_processamento === "INVALIDO";

  return (
    <TableRow className={cn(comProblema && "bg-state-error-soft/40")}>
      <TableCell>
        <div className="flex items-center gap-2">
          {comProblema ? (
            <span className="h-8 w-1 shrink-0 rounded-full bg-state-error" aria-hidden="true" />
          ) : null}
          <StatusBadge status={evento.status_processamento} />
        </div>
      </TableCell>

      <TableCell className="font-mono text-xs">{evento.id_transacao}</TableCell>

      <TableCell className="font-mono text-xs">{evento.id_contrato ?? "—"}</TableCell>

      <TableCell className="tabular text-right font-medium">
        {formatCurrency(evento.valor)}
      </TableCell>

      <TableCell className="tabular whitespace-nowrap text-xs">
        {formatDateTime(evento.data_pagamento)}
      </TableCell>

      <TableCell className="whitespace-nowrap text-xs" title={formatDateTime(evento.recebido_em)}>
        {formatRelative(evento.recebido_em)}
      </TableCell>

      <TableCell className="tabular text-center text-xs">{evento.tentativas}</TableCell>

      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {/* O motivo do erro fica visivel sem precisar abrir o detalhe: e a
              informacao que o operador procura ao ver uma linha vermelha. */}
          {evento.erro ? (
            <span
              className="max-w-[16rem] truncate text-xs text-state-error"
              title={evento.erro}
            >
              {evento.erro}
            </span>
          ) : null}

          <Button variant="ghost" size="icon" onClick={onDetalhe} aria-label="Ver detalhes">
            <i className="bi bi-eye" aria-hidden="true" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function EmptyState({ temFiltro, onLimpar }: { temFiltro: boolean; onLimpar: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted">
        <i className="bi bi-inbox text-xl text-[color:var(--muted-foreground)]" aria-hidden="true" />
      </div>

      <div>
        <p className="font-medium">
          {temFiltro ? "Nenhum evento com esses filtros" : "Nenhum evento recebido ainda"}
        </p>
        <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
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
