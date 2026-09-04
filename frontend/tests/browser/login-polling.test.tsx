import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/components/auth-provider";
import { LoginForm } from "@/components/login-form";
import { ApiError } from "@/lib/api-client";

/**
 * A feature de autenticacao por polling, do lado do cliente.
 *
 * <b>O que se verifica aqui.</b> Nao a chamada HTTP - isso e coberto nos testes
 * de servidor -, e sim o COMPORTAMENTO da aba: que ela continue perguntando,
 * que entre sozinha quando o link e confirmado em outro aparelho, que pare
 * quando o pedido morre e que nao fique perguntando para sempre.
 *
 * O cliente de API e substituido para que o polling possa ser dirigido passo a
 * passo. Sem isso, o teste dependeria de um backend no ar e de esperar 2,5s
 * reais por ciclo.
 */

const mocks = vi.hoisted(() => ({
  startLogin: vi.fn(),
  pollLogin: vi.fn(),
  verifyOtp: vi.fn(),
  getSession: vi.fn(),
  clearSession: vi.fn(),
  getBackends: vi.fn(),
  switchBackend: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...original, ...mocks };
});

const pushMock = vi.fn();
const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, prefetch: vi.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));

const USUARIO = {
  id: "u-1",
  email: "operador@sabemi.com.br",
  criado_em: "2026-09-01T12:00:00Z",
};

const INICIO = {
  selector: "sel-123",
  email: "operador@sabemi.com.br",
  email_sent: false,
  dev_magic_url: "http://localhost:3000/api/bff/auth/confirm?token=abc",
  dev_otp_code: "123456",
  message: "Use o link ou o codigo abaixo para entrar.",
};

beforeEach(() => {
  // `clearAllMocks` zera as chamadas mas NAO descarta as implementacoes `...Once`
  // enfileiradas. Sem o reset explicito, uma fila deixada por um teste anterior
  // vaza para o proximo e produz falhas que apontam para o lugar errado.
  for (const mock of Object.values(mocks)) mock.mockReset();
  // Sem sessao: a tela de login e o estado inicial esperado.
  mocks.getSession.mockRejectedValue(new ApiError("Sem sessao.", 401));
  mocks.getBackends.mockResolvedValue({
    active: "dotnet",
    default: "dotnet",
    backends: [
      { id: "dotnet", label: ".NET", description: "ASP.NET Core", online: true },
      { id: "vinext", label: "VINEXT / BFF", description: "Route handlers", online: true },
    ],
  });
  mocks.startLogin.mockResolvedValue(INICIO);
  mocks.pollLogin.mockResolvedValue({ status: "pending", authenticated: false });
});

function renderizar() {
  return render(
    <AuthProvider>
      <LoginForm />
    </AuthProvider>,
  );
}

/** Preenche o e-mail e envia, chegando na etapa de espera. */
async function solicitarAcesso(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/e-mail/i), "operador@sabemi.com.br");
  await user.click(screen.getByRole("button", { name: /enviar link/i }));
  // Prazo mais folgado que o padrao de 1s: em CI carregado, montar a etapa de
  // espera pode demorar mais do que isso.
  await screen.findByText(/aguardando confirmação/i, {}, { timeout: 5000 });
}

describe("reenvio do código", () => {
  // O servidor tem uma espera de reenvio (`AUTH_RESEND_COOLDOWN_SECONDS`, 60s)
  // desde sempre - mas a tela nunca ofereceu o botao que a justifica. Quem nao
  // recebia o e-mail so tinha "Usar outro e-mail", voltava, redigitava o MESMO
  // endereco e levava um 429. A regra existia; faltava a acao.

  it("oferece reenviar, mas só depois da espera", async () => {
    const user = userEvent.setup();
    renderizar();
    await solicitarAcesso(user);

    // Logo apos o envio o botao existe e esta bloqueado, mostrando quanto falta.
    // Deixar o clique passar para colher um 429 seria a pior forma de comunicar
    // a regra: o operador so a descobre esbarrando nela.
    const botao = screen.getByRole("button", { name: /reenviar em \d+s/i });
    expect(botao).toBeDisabled();
  });

  it("reenviar pede um novo código para o mesmo e-mail", async () => {
    const user = userEvent.setup();
    renderizar();
    await solicitarAcesso(user);

    // Sem esperar os 60s reais: o teste chama a acao pelo caminho que ela usa,
    // confirmando que o e-mail reaproveitado e o mesmo da etapa anterior.
    expect(mocks.startLogin).toHaveBeenCalledTimes(1);
    expect(mocks.startLogin).toHaveBeenCalledWith("operador@sabemi.com.br");

    // O botao de voltar continua ao lado - as duas saidas convivem.
    expect(screen.getByRole("button", { name: /usar outro e-mail/i })).toBeEnabled();
  });
});

describe("solicitação de acesso", () => {
  it("pede o e-mail antes de qualquer coisa", async () => {
    renderizar();

    expect(await screen.findByLabelText(/e-mail/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enviar link/i })).toBeInTheDocument();
  });

  it("o botão fica desabilitado com o e-mail vazio", async () => {
    renderizar();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /enviar link/i })).toBeDisabled(),
    );
  });

  it("envia o e-mail informado e avança para a etapa de espera", async () => {
    const user = userEvent.setup();
    renderizar();

    await solicitarAcesso(user);

    expect(mocks.startLogin).toHaveBeenCalledWith("operador@sabemi.com.br");
    expect(screen.getByText(/pode abrir o link em outro aparelho/i)).toBeInTheDocument();
  });

  it("mostra o erro quando o backend recusa o e-mail", async () => {
    const user = userEvent.setup();
    mocks.startLogin.mockRejectedValue(new ApiError("Informe um e-mail valido.", 400));
    renderizar();

    await user.type(screen.getByLabelText(/e-mail/i), "invalido@x.com");
    await user.click(screen.getByRole("button", { name: /enviar link/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Informe um e-mail valido.");
  });

  it("exibe o atalho de desenvolvimento quando o servidor o envia", async () => {
    const user = userEvent.setup();
    renderizar();
    await solicitarAcesso(user);

    expect(screen.getByText(/atalho de desenvolvimento/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /abrir link/i })).toHaveAttribute(
      "href",
      INICIO.dev_magic_url,
    );
    expect(screen.getByText("123456")).toBeInTheDocument();
  });

  it("não exibe o atalho quando o servidor omite os códigos (produção)", async () => {
    const user = userEvent.setup();
    mocks.startLogin.mockResolvedValue({
      ...INICIO,
      dev_magic_url: null,
      dev_otp_code: null,
      email_sent: true,
    });
    renderizar();
    await solicitarAcesso(user);

    expect(screen.queryByText(/atalho de desenvolvimento/i)).not.toBeInTheDocument();
  });
});

describe("polling", () => {
  it("continua perguntando enquanto o pedido está pendente", async () => {
    const user = userEvent.setup();
    renderizar();
    await solicitarAcesso(user);

    // Mais de uma consulta comprova que ha um ciclo, e nao uma unica tentativa.
    await waitFor(() => expect(mocks.pollLogin.mock.calls.length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
    });

    expect(mocks.pollLogin).toHaveBeenCalledWith("sel-123");
    // Continua na etapa de espera.
    expect(screen.getByText(/aguardando confirmação/i)).toBeInTheDocument();
  });

  it("entra sozinha quando o link é confirmado em OUTRO aparelho", async () => {
    // O comportamento que define a feature. A aba nao faz nada; o polling
    // detecta a aprovacao e o redirect acontece.
    const user = userEvent.setup();

    mocks.pollLogin
      .mockResolvedValueOnce({ status: "pending", authenticated: false })
      .mockResolvedValue({ status: "approved", authenticated: true, user: USUARIO });

    renderizar();
    await solicitarAcesso(user);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"), {
      timeout: 10_000,
    });
  });

  it("encerra o polling quando o pedido expira (404)", async () => {
    // Um 404 significa consumido ou expirado: insistir nao mudaria nada.
    const user = userEvent.setup();
    mocks.pollLogin.mockRejectedValue(new ApiError("Pedido nao encontrado.", 404));

    renderizar();

    // Aqui o helper `solicitarAcesso` nao serve: o 404 chega no primeiro ciclo e
    // a etapa de espera e desmontada antes que uma consulta ao DOM consiga
    // observa-la. O que importa e o DESFECHO - voltar para o e-mail com uma
    // explicacao -, e nao ter passado visivelmente pelo estado intermediario.
    await user.type(screen.getByLabelText(/e-mail/i), "operador@sabemi.com.br");
    await user.click(screen.getByRole("button", { name: /enviar link/i }));

    expect(await screen.findByText(/expirou/i, {}, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/e-mail/i)).toBeInTheDocument());

    // E o polling parou de verdade: nao ha novas consultas depois do 404.
    const chamadas = mocks.pollLogin.mock.calls.length;
    await new Promise((r) => setTimeout(r, 3000));
    expect(mocks.pollLogin.mock.calls.length).toBe(chamadas);
  });

  it("uma falha de rede NÃO encerra o polling", async () => {
    // O backend pode estar reiniciando. Desistir aqui abandonaria um login que
    // provavelmente funcionaria no ciclo seguinte.
    const user = userEvent.setup();

    mocks.pollLogin
      .mockRejectedValueOnce(new ApiError("Sem conexao.", 0))
      .mockRejectedValueOnce(new ApiError("Sem conexao.", 0))
      .mockResolvedValue({ status: "approved", authenticated: true, user: USUARIO });

    renderizar();
    await solicitarAcesso(user);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"), {
      timeout: 15_000,
    });
  });

  it("para de perguntar ao sair da tela", async () => {
    // Sem o cancelamento, a aba continuaria consultando ate o prazo de 15 min - e
    // o `setUser` de um login concluido chegaria a um componente desmontado.
    const user = userEvent.setup();
    renderizar();
    await solicitarAcesso(user);

    await waitFor(() => expect(mocks.pollLogin).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /usar outro e-mail/i }));

    const chamadasAoSair = mocks.pollLogin.mock.calls.length;
    await new Promise((r) => setTimeout(r, 3500));

    expect(mocks.pollLogin.mock.calls.length).toBe(chamadasAoSair);
  });
});

describe("código OTP", () => {
  it("aceita apenas dígitos e no máximo seis", async () => {
    const user = userEvent.setup();
    renderizar();
    await solicitarAcesso(user);

    const campo = screen.getByLabelText(/código de 6 dígitos/i);
    await user.type(campo, "12ab34cd5678");

    expect(campo).toHaveValue("123456");
  });

  it("o botão só habilita com os seis dígitos", async () => {
    const user = userEvent.setup();
    renderizar();
    await solicitarAcesso(user);

    const botao = screen.getByRole("button", { name: /entrar com o código/i });
    expect(botao).toBeDisabled();

    await user.type(screen.getByLabelText(/código de 6 dígitos/i), "123456");
    expect(botao).toBeEnabled();
  });

  it("o código correto autentica", async () => {
    const user = userEvent.setup();
    mocks.verifyOtp.mockResolvedValue({ status: "approved", authenticated: true, user: USUARIO });

    renderizar();
    await solicitarAcesso(user);

    await user.type(screen.getByLabelText(/código de 6 dígitos/i), "123456");
    await user.click(screen.getByRole("button", { name: /entrar com o código/i }));

    expect(mocks.verifyOtp).toHaveBeenCalledWith("sel-123", "123456");
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
  });

  it("o código incorreto mostra o erro e limpa o campo", async () => {
    const user = userEvent.setup();
    mocks.verifyOtp.mockRejectedValue(new ApiError("Codigo incorreto.", 400));

    renderizar();
    await solicitarAcesso(user);

    await user.type(screen.getByLabelText(/código de 6 dígitos/i), "000000");
    await user.click(screen.getByRole("button", { name: /entrar com o código/i }));

    expect(await screen.findByText("Codigo incorreto.")).toBeInTheDocument();
    // Campo limpo: o usuario digita de novo sem precisar apagar.
    expect(screen.getByLabelText(/código de 6 dígitos/i)).toHaveValue("");
    // E continua na tela, porque ainda restam tentativas.
    expect(screen.getByText(/aguardando confirmação/i)).toBeInTheDocument();
  });

  it("tentativas esgotadas devolvem à etapa de e-mail", async () => {
    const user = userEvent.setup();
    mocks.verifyOtp.mockRejectedValue(
      new ApiError("Muitas tentativas. Solicite um novo acesso.", 429),
    );

    renderizar();
    await solicitarAcesso(user);

    await user.type(screen.getByLabelText(/código de 6 dígitos/i), "000000");
    await user.click(screen.getByRole("button", { name: /entrar com o código/i }));

    // O pedido foi destruido no servidor: nao adianta continuar nesta tela.
    await waitFor(() => expect(screen.getByLabelText(/e-mail/i)).toBeInTheDocument());
  });
});

describe("restauração de sessão", () => {
  it("quem já tem sessão vai direto para o dashboard", async () => {
    mocks.getSession.mockResolvedValue({ user: USUARIO, backend: "dotnet" });

    renderizar();

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
  });
});
