import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/components/auth-provider";
import { DashboardGuard } from "@/components/dashboard-guard";
import { HomeRedirect } from "@/components/home-redirect";
import { ApiError } from "@/lib/api-client";

/**
 * Encaminhamento por estado de sessao.
 *
 * <b>O que se afirma - e o que NAO se afirma.</b> Estes componentes cuidam da
 * EXPERIENCIA, nao da seguranca. Quem nao tem sessao vai para o login em vez de
 * encarar uma tela cheia de erros. A protecao real esta no servidor: o gateway
 * so anexa o token do cookie httpOnly e o backend recusa consulta sem sessao
 * valida - o que os testes de rota e de backend ja cobrem.
 *
 * O estado de carregamento tem peso proprio: sem ele, o F5 mostraria o login por
 * um instante antes de a sessao ser restaurada, o que parece um logout aleatorio.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getBackends: vi.fn(),
  getHealth: vi.fn(),
  listPayments: vi.fn(),
  getPaymentSummary: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...original, ...mocks };
});

const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const USUARIO = {
  id: "u-1",
  email: "operador@sabemi.com.br",
  criado_em: "2026-09-01T12:00:00Z",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  replaceMock.mockReset();

  mocks.getBackends.mockResolvedValue({
    active: "dotnet",
    default: "dotnet",
    backends: [
      { id: "dotnet", label: ".NET", description: "ASP.NET Core", online: true },
      { id: "vinext", label: "VINEXT / BFF", description: "Prisma", online: true },
    ],
  });
  mocks.getHealth.mockResolvedValue({ status: "healthy", backend: "dotnet" });
  mocks.listPayments.mockResolvedValue({ items: [], page: 1, page_size: 20, total: 0 });
  mocks.getPaymentSummary.mockResolvedValue({ total: 0, por_status: {} });
});

describe("raiz da aplicação", () => {
  it("encaminha quem tem sessão para o dashboard", async () => {
    mocks.getSession.mockResolvedValue({ user: USUARIO, backend: "dotnet" });

    render(
      <AuthProvider>
        <HomeRedirect />
      </AuthProvider>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
  });

  it("encaminha quem não tem sessão para o login", async () => {
    mocks.getSession.mockRejectedValue(new ApiError("Sem sessao.", 401));

    render(
      <AuthProvider>
        <HomeRedirect />
      </AuthProvider>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });

  it("não decide nada enquanto a sessão está sendo restaurada", async () => {
    // Decidir cedo demais mandaria para o login alguém que está logado.
    mocks.getSession.mockImplementation(() => new Promise(() => {}));

    render(
      <AuthProvider>
        <HomeRedirect />
      </AuthProvider>,
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

describe("proteção do dashboard", () => {
  it("manda para o login quem não tem sessão", async () => {
    mocks.getSession.mockRejectedValue(new ApiError("Sem sessao.", 401));

    render(
      <AuthProvider>
        <DashboardGuard />
      </AuthProvider>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });

  it("mostra o dashboard para quem tem sessão", async () => {
    mocks.getSession.mockResolvedValue({ user: USUARIO, backend: "dotnet" });

    render(
      <AuthProvider>
        <DashboardGuard />
      </AuthProvider>,
    );

    expect(await screen.findByText(/painel de pagamentos/i)).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("mostra o esqueleto durante a restauração, e não a tela de login", async () => {
    mocks.getSession.mockImplementation(() => new Promise(() => {}));

    const { container } = render(
      <AuthProvider>
        <DashboardGuard />
      </AuthProvider>,
    );

    await new Promise((r) => setTimeout(r, 100));

    // Procura pelo `data-slot` do Skeleton, e nao pela classe da animacao: o
    // que este teste afirma e que HA esqueleto, nao qual animacao ele usa.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
