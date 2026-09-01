import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/components/auth-provider";
import { BackendSwitcher } from "@/components/backend-switcher";
import { PaymentsDashboard } from "@/components/dashboard/payments-dashboard";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import { ApiError } from "@/lib/api-client";
import type { PagedResult, PaymentEventDto } from "@/lib/contracts";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils";

/**
 * Dashboard administrativo e seletor de backend.
 *
 * Cobre os requisitos visiveis da task: filtros por situacao e por contrato,
 * distincao clara entre sucesso e erro, e a interface explicita de troca de
 * backend.
 */

const mocks = vi.hoisted(() => ({
  listPayments: vi.fn(),
  getPaymentSummary: vi.fn(),
  getPaymentDetail: vi.fn(),
  getContract: vi.fn(),
  getHealth: vi.fn(),
  getSession: vi.fn(),
  clearSession: vi.fn(),
  getBackends: vi.fn(),
  switchBackend: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...original, ...mocks };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

const USUARIO = {
  id: "u-1",
  email: "operador@sabemi.com.br",
  criado_em: "2026-09-01T12:00:00Z",
};

function evento(over: Partial<PaymentEventDto> = {}): PaymentEventDto {
  return {
    id: crypto.randomUUID(),
    id_transacao: "TRX-001",
    id_contrato: "CTR-A",
    valor: 1500.5,
    data_pagamento: "2026-08-01T10:00:00Z",
    status_origem: "PAGO",
    status_processamento: "SUCESSO",
    erro: null,
    recebido_em: "2026-09-01T12:00:00Z",
    processado_em: "2026-09-01T12:00:02Z",
    tentativas: 1,
    ...over,
  };
}

function pagina(items: PaymentEventDto[]): PagedResult<PaymentEventDto> {
  return { items, page: 1, page_size: 20, total: items.length };
}

const EVENTOS = [
  evento({ id_transacao: "S-1", status_processamento: "SUCESSO", id_contrato: "CTR-A" }),
  evento({
    id_transacao: "E-1",
    status_processamento: "ERRO",
    erro: "gateway indisponivel",
    id_contrato: "CTR-A",
  }),
  evento({
    id_transacao: "I-1",
    status_processamento: "INVALIDO",
    erro: "O campo 'valor' deve ser maior que zero.",
    id_contrato: "CTR-B",
    valor: null,
  }),
  evento({ id_transacao: "P-1", status_processamento: "PENDENTE", id_contrato: "CTR-B" }),
];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();

  mocks.getSession.mockResolvedValue({ user: USUARIO, backend: "dotnet" });
  mocks.listPayments.mockResolvedValue(pagina(EVENTOS));
  mocks.getPaymentSummary.mockResolvedValue({
    total: 4,
    por_status: {
      PENDENTE: 1,
      PROCESSANDO: 0,
      SUCESSO: 1,
      ERRO: 1,
      INVALIDO: 1,
      DUPLICADO: 0,
    },
  });
  mocks.getHealth.mockResolvedValue({ status: "healthy", backend: "dotnet" });
  mocks.getBackends.mockResolvedValue({
    active: "dotnet",
    default: "dotnet",
    backends: [
      { id: "dotnet", label: ".NET", description: "ASP.NET Core + EF Core", online: true },
      { id: "vinext", label: "VINEXT / BFF", description: "Prisma, em processo", online: true },
    ],
  });
});

function renderizarDashboard() {
  return render(
    <AuthProvider>
      <PaymentsDashboard />
    </AuthProvider>,
  );
}

describe("listagem de pagamentos", () => {
  it("mostra os eventos recebidos", async () => {
    renderizarDashboard();

    expect(await screen.findByText("S-1")).toBeInTheDocument();
    expect(screen.getByText("E-1")).toBeInTheDocument();
    expect(screen.getByText("I-1")).toBeInTheDocument();
    expect(screen.getByText("P-1")).toBeInTheDocument();
  });

  it("mostra o e-mail do operador logado", async () => {
    renderizarDashboard();

    expect(await screen.findByText("operador@sabemi.com.br")).toBeInTheDocument();
  });

  it("exibe o estado vazio quando não há eventos", async () => {
    mocks.listPayments.mockResolvedValue(pagina([]));
    renderizarDashboard();

    expect(await screen.findByText(/nenhum evento recebido ainda/i)).toBeInTheDocument();
  });

  it("informa quando o backend não responde, em vez de mostrar tela quebrada", async () => {
    mocks.listPayments.mockRejectedValue(
      new ApiError("Nao foi possivel conectar ao backend .NET.", 502),
    );
    renderizarDashboard();

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent(/não foi possível atualizar/i);
    expect(alerta).toHaveTextContent(/backend \.NET/i);
  });
});

describe("visualização de erros", () => {
  it("distingue visualmente sucesso, erro, inválido e pendente", async () => {
    // O requisito de alerta visual claro: os quatro estados precisam ser
    // distinguiveis de relance.
    renderizarDashboard();

    await screen.findByText("S-1");

    expect(screen.getByText("Sucesso")).toBeInTheDocument();
    expect(screen.getByText("Erro")).toBeInTheDocument();
    expect(screen.getByText("Inválido")).toBeInTheDocument();
    expect(screen.getByText("Pendente")).toBeInTheDocument();
  });

  it("destaca a linha de um evento com problema", async () => {
    renderizarDashboard();

    const linhaErro = (await screen.findByText("E-1")).closest("tr")!;
    const linhaSucesso = screen.getByText("S-1").closest("tr")!;

    // A linha com erro recebe fundo proprio; a de sucesso, nao.
    expect(linhaErro.className).toContain("bg-state-error-soft");
    expect(linhaSucesso.className).not.toContain("bg-state-error-soft");
  });

  it("mostra o motivo do erro sem precisar abrir o detalhe", async () => {
    // E a informacao que o operador procura ao ver uma linha vermelha.
    renderizarDashboard();

    expect(await screen.findByText("gateway indisponivel")).toBeInTheDocument();
    expect(
      screen.getByText("O campo 'valor' deve ser maior que zero."),
    ).toBeInTheDocument();
  });

  it("os cartões separam erro de processamento de payload inválido", async () => {
    // Causas diferentes exigem acoes diferentes: uma e nossa, a outra e do
    // parceiro.
    renderizarDashboard();

    expect(await screen.findByText("Com erro")).toBeInTheDocument();
    expect(screen.getByText("Inválidos")).toBeInTheDocument();
    expect(screen.getByText("Na fila")).toBeInTheDocument();
  });
});

describe("filtros", () => {
  it("filtra por status", async () => {
    const user = userEvent.setup();
    renderizarDashboard();
    await screen.findByText("S-1");

    await user.click(screen.getByLabelText(/filtrar por status/i));
    await user.click(await screen.findByRole("option", { name: "Erro" }));

    await waitFor(() =>
      expect(mocks.listPayments).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ERRO" }),
      ),
    );
  });

  it("filtra por ID do contrato", async () => {
    const user = userEvent.setup();
    renderizarDashboard();
    await screen.findByText("S-1");

    await user.type(screen.getByLabelText(/id do contrato/i), "CTR-A");

    await waitFor(
      () =>
        expect(mocks.listPayments).toHaveBeenCalledWith(
          expect.objectContaining({ contractId: "CTR-A" }),
        ),
      { timeout: 3000 },
    );
  });

  it("agrupa as teclas do filtro de contrato numa única consulta", async () => {
    // Sem debounce, cada tecla dispararia uma requisicao.
    const user = userEvent.setup();
    renderizarDashboard();
    await screen.findByText("S-1");

    mocks.listPayments.mockClear();
    await user.type(screen.getByLabelText(/id do contrato/i), "CTR-12345");

    await waitFor(
      () =>
        expect(mocks.listPayments).toHaveBeenCalledWith(
          expect.objectContaining({ contractId: "CTR-12345" }),
        ),
      { timeout: 3000 },
    );

    // Bem menos que os 9 caracteres digitados.
    expect(mocks.listPayments.mock.calls.length).toBeLessThan(5);
  });

  it("o botão de limpar só habilita quando há filtro", async () => {
    const user = userEvent.setup();
    renderizarDashboard();
    await screen.findByText("S-1");

    const limpar = screen.getByRole("button", { name: /limpar filtros/i });
    expect(limpar).toBeDisabled();

    await user.type(screen.getByLabelText(/id do contrato/i), "CTR-A");

    await waitFor(() => expect(limpar).toBeEnabled());
  });

  it("limpar restaura a consulta sem filtros", async () => {
    const user = userEvent.setup();
    renderizarDashboard();
    await screen.findByText("S-1");

    await user.type(screen.getByLabelText(/id do contrato/i), "CTR-A");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /limpar filtros/i })).toBeEnabled(),
    );

    await user.click(screen.getByRole("button", { name: /limpar filtros/i }));

    await waitFor(() =>
      expect(mocks.listPayments).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: null, contractId: null, page: 1 }),
      ),
    );
  });

  it("mostra o estado vazio específico quando o filtro não encontra nada", async () => {
    const user = userEvent.setup();
    renderizarDashboard();
    await screen.findByText("S-1");

    mocks.listPayments.mockResolvedValue(pagina([]));
    await user.type(screen.getByLabelText(/id do contrato/i), "CTR-FANTASMA");

    expect(
      await screen.findByText(/nenhum evento com esses filtros/i, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });
});

describe("atualização automática", () => {
  it("permite pausar e retomar", async () => {
    // Um operador investigando um evento nao quer a tabela se reordenando
    // debaixo do cursor.
    const user = userEvent.setup();
    renderizarDashboard();
    await screen.findByText("S-1");

    await user.click(screen.getByRole("button", { name: /pausar/i }));
    expect(screen.getByRole("button", { name: /retomar/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retomar/i }));
    expect(screen.getByRole("button", { name: /pausar/i })).toBeInTheDocument();
  });

  it("o botão Atualizar força uma nova consulta", async () => {
    const user = userEvent.setup();
    renderizarDashboard();
    await screen.findByText("S-1");

    mocks.listPayments.mockClear();
    await user.click(screen.getByRole("button", { name: /^atualizar$/i }));

    await waitFor(() => expect(mocks.listPayments).toHaveBeenCalled());
  });
});

describe("detalhe do evento", () => {
  it("abre o payload bruto recebido", async () => {
    const user = userEvent.setup();
    mocks.getPaymentDetail.mockResolvedValue({
      ...EVENTOS[0],
      payload_bruto: '{"id_transacao":"S-1","valor":1500.5}',
    });
    mocks.getContract.mockRejectedValue(new ApiError("nao encontrado", 404));

    renderizarDashboard();
    await screen.findByText("S-1");

    const linha = screen.getByText("S-1").closest("tr")!;
    await user.click(within(linha).getByRole("button", { name: /ver detalhes/i }));

    expect(await screen.findByText(/payload bruto recebido/i)).toBeInTheDocument();
    expect(mocks.getPaymentDetail).toHaveBeenCalledWith("S-1");
  });

  it("mostra o motivo completo de um evento inválido", async () => {
    const user = userEvent.setup();
    mocks.getPaymentDetail.mockResolvedValue({
      ...EVENTOS[2],
      payload_bruto: '{"valor":-1}',
    });
    mocks.getContract.mockRejectedValue(new ApiError("nao encontrado", 404));

    renderizarDashboard();
    await screen.findByText("I-1");

    const linha = screen.getByText("I-1").closest("tr")!;
    await user.click(within(linha).getByRole("button", { name: /ver detalhes/i }));

    expect(await screen.findByText(/reprovado na validação/i)).toBeInTheDocument();
  });
});

describe("seletor de backend", () => {
  it("mostra os dois backends com indicador de disponibilidade", async () => {
    render(<BackendSwitcher hasSession={false} />);

    expect(await screen.findByRole("radio", { name: /\.NET/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /VINEXT/i })).toBeInTheDocument();
  });

  it("marca o backend ativo", async () => {
    render(<BackendSwitcher hasSession={false} />);

    const dotnet = await screen.findByRole("radio", { name: /\.NET/i });
    const vinext = screen.getByRole("radio", { name: /VINEXT/i });

    expect(dotnet).toHaveAttribute("aria-checked", "true");
    expect(vinext).toHaveAttribute("aria-checked", "false");
  });

  it("troca direto quando não há sessão aberta", async () => {
    const user = userEvent.setup();
    mocks.switchBackend.mockResolvedValue({
      active: "vinext",
      previous: "dotnet",
      session_cleared: false,
    });

    // `window.location.assign` nao existe em jsdom; substituido para observar a
    // recarga que a troca provoca.
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });

    render(<BackendSwitcher hasSession={false} />);
    await user.click(await screen.findByRole("radio", { name: /VINEXT/i }));

    await waitFor(() => expect(mocks.switchBackend).toHaveBeenCalledWith("vinext"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("avisa antes de trocar com sessão aberta - a troca encerra a sessão", async () => {
    // Cada backend tem o proprio banco e os proprios usuarios; a sessao atual nao
    // vale no outro. Descobrir isso com um 401 sem explicacao seria pior.
    const user = userEvent.setup();
    render(<BackendSwitcher hasSession={true} />);

    await user.click(await screen.findByRole("radio", { name: /VINEXT/i }));

    expect(await screen.findByText(/encerra sua sessão atual/i)).toBeInTheDocument();
    // Ainda nao trocou: espera a confirmacao.
    expect(mocks.switchBackend).not.toHaveBeenCalled();
  });

  it("confirmar prossegue com a troca", async () => {
    const user = userEvent.setup();
    mocks.switchBackend.mockResolvedValue({
      active: "vinext",
      previous: "dotnet",
      session_cleared: true,
    });

    render(<BackendSwitcher hasSession={true} />);
    await user.click(await screen.findByRole("radio", { name: /VINEXT/i }));
    await user.click(await screen.findByRole("button", { name: /trocar mesmo assim/i }));

    await waitFor(() => expect(mocks.switchBackend).toHaveBeenCalledWith("vinext"));
  });

  it("cancelar desiste da troca", async () => {
    const user = userEvent.setup();
    render(<BackendSwitcher hasSession={true} />);

    await user.click(await screen.findByRole("radio", { name: /VINEXT/i }));
    await user.click(await screen.findByRole("button", { name: /cancelar/i }));

    await waitFor(() =>
      expect(screen.queryByText(/encerra sua sessão atual/i)).not.toBeInTheDocument(),
    );
    expect(mocks.switchBackend).not.toHaveBeenCalled();
  });

  it("clicar no backend já ativo não faz nada", async () => {
    const user = userEvent.setup();
    render(<BackendSwitcher hasSession={false} />);

    await user.click(await screen.findByRole("radio", { name: /\.NET/i }));

    expect(mocks.switchBackend).not.toHaveBeenCalled();
  });

  it("o dashboard exibe qual backend REALMENTE respondeu", async () => {
    // Le o campo `backend` de /health, que vem de quem atendeu a chamada - nao do
    // cookie que o cliente enviou. E a diferenca entre "pedi para trocar" e
    // "trocou".
    mocks.getHealth.mockResolvedValue({ status: "healthy", backend: "vinext" });

    renderizarDashboard();

    await waitFor(() => expect(screen.getAllByText(/VINEXT \/ BFF/i).length).toBeGreaterThan(0));
  });
});

describe("cartões de resumo", () => {
  it("mostra o esqueleto enquanto carrega", () => {
    render(<SummaryCards resumo={null} carregando={true} />);

    expect(screen.getByText("Total recebido")).toBeInTheDocument();
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });

  it("agrupa pendente e processando em Na fila", () => {
    // Para quem opera, "esperando" e "rodando agora" levam a mesma conclusao: ha
    // trabalho em andamento.
    render(
      <SummaryCards
        carregando={false}
        resumo={{
          total: 10,
          por_status: {
            PENDENTE: 3,
            PROCESSANDO: 2,
            SUCESSO: 4,
            ERRO: 1,
            INVALIDO: 0,
            DUPLICADO: 0,
          },
        }}
      />,
    );

    const naFila = screen.getByText("Na fila").closest("div")!.parentElement!;
    expect(within(naFila).getByText("5")).toBeInTheDocument();
  });

  it("tolera um resumo ainda não carregado sem quebrar", () => {
    render(<SummaryCards resumo={null} carregando={false} />);

    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });
});

describe("formatação", () => {
  it("formata valores em reais", () => {
    expect(formatCurrency(1500.5)).toContain("1.500,50");
    // Ausencia de valor vira travessao, e nao "R$ 0,00" - que seria uma
    // afirmacao falsa sobre o dado.
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
  });

  it("formata data e hora no padrão brasileiro", () => {
    expect(formatDateTime("2026-08-01T10:00:00Z")).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("nao-e-data")).toBe("—");
  });

  it("formata tempo relativo", () => {
    const agora = new Date();

    expect(formatRelative(agora.toISOString())).toBe("agora");
    expect(formatRelative(new Date(agora.getTime() - 30_000).toISOString())).toContain("s");
    expect(formatRelative(new Date(agora.getTime() - 300_000).toISOString())).toContain("min");
    expect(formatRelative(new Date(agora.getTime() - 7_200_000).toISOString())).toContain("h");
    expect(formatRelative(new Date(agora.getTime() - 172_800_000).toISOString())).toContain("d");
    expect(formatRelative(null)).toBe("—");
  });
});
