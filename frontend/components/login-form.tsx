"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { useAuth } from "@/components/auth-provider";
import { BackendSwitcher } from "@/components/backend-switcher";
import { Button } from "@/components/ui/button";
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
} from "@/components/ui/primitives";
import { ApiError } from "@/lib/api-client";
import type { MagicLinkStartDto } from "@/lib/contracts";

/**
 * Tela de login passwordless.
 *
 * Duas etapas: pedir o e-mail e, depois, aguardar. Na etapa de espera acontecem
 * duas coisas ao mesmo tempo - o polling roda em segundo plano esperando o link
 * ser aberto (em qualquer aparelho), e o campo de OTP fica disponivel para quem
 * prefere nao sair da aba. O que ocorrer primeiro autentica.
 *
 * <b>Encerramento do polling.</b> O `signal` compartilhado com o efeito garante
 * que o laco pare quando o componente desmontar ou o usuario voltar atras.
 * Sem isso, sair da tela deixaria uma requisicao a cada 2,5s ate o prazo de 15
 * minutos - e, pior, o `setUser` de um login concluido chegaria a um componente
 * que ja nao esta na tela.
 */

type Step = "email" | "waiting";

export function LoginForm() {
  const router = useRouter();
  const { user, beginLogin, pollUntilAuthenticated, submitOtp } = useAuth();

  const [step, setStep] = React.useState<Step>("email");
  const [email, setEmail] = React.useState("");
  const [pedido, setPedido] = React.useState<MagicLinkStartDto | null>(null);
  const [otp, setOtp] = React.useState("");
  const [erro, setErro] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);
  const [enviando, setEnviando] = React.useState(false);
  const [verificando, setVerificando] = React.useState(false);
  const [aguardando, setAguardando] = React.useState(false);

  // Redirect reativo ao usuario: qualquer caminho que autentique - polling, OTP
  // ou restauracao de sessao - cai aqui. Centralizar evita a corrida em que a
  // aba fica "presa" no login apos confirmar o link.
  React.useEffect(() => {
    if (user) router.replace("/dashboard");
  }, [user, router]);

  // O polling propriamente dito, atrelado ao ciclo de vida da etapa de espera.
  React.useEffect(() => {
    if (step !== "waiting" || !pedido?.selector) return;

    const signal = { cancelled: false };
    setAguardando(true);

    (async () => {
      const desfecho = await pollUntilAuthenticated(pedido.selector, signal);
      if (signal.cancelled) return;

      setAguardando(false);

      if (desfecho === "expired") {
        setErro("Este pedido de acesso expirou. Solicite um novo link.");
        setStep("email");
        setPedido(null);
      }
    })();

    return () => {
      signal.cancelled = true;
    };
  }, [step, pedido?.selector, pollUntilAuthenticated]);

  const solicitarAcesso = async (evento: React.FormEvent) => {
    evento.preventDefault();
    setErro(null);
    setAviso(null);
    setEnviando(true);

    try {
      const resultado = await beginLogin(email);
      setPedido(resultado);
      setStep("waiting");

      if (!resultado.email_sent && !resultado.dev_magic_url) {
        setAviso("Não foi possível enviar o e-mail agora. Tente novamente em instantes.");
      }
    } catch (error) {
      setErro(error instanceof ApiError ? error.message : "Não foi possível iniciar o acesso.");
    } finally {
      setEnviando(false);
    }
  };

  const confirmarOtp = async (evento: React.FormEvent) => {
    evento.preventDefault();
    if (!pedido) return;

    setErro(null);
    setVerificando(true);

    try {
      await submitOtp(pedido.selector, otp.trim());
      // O redirect acontece pelo efeito que observa `user`.
    } catch (error) {
      if (error instanceof ApiError) {
        setErro(error.message);

        // Pedido destruido (esgotou tentativas ou expirou): nao adianta
        // continuar nesta tela.
        if (error.isGone || error.status === 429) {
          setStep("email");
          setPedido(null);
        }
      } else {
        setErro("Não foi possível validar o código.");
      }
      setOtp("");
    } finally {
      setVerificando(false);
    }
  };

  const voltar = () => {
    setStep("email");
    setPedido(null);
    setOtp("");
    setErro(null);
    setAviso(null);
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <header className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-white">
          <i className="bi bi-shield-lock-fill text-xl" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Sabemi · Painel de Pagamentos</h1>
          <p className="text-sm text-[color:var(--muted-foreground)]">
            Acesso sem senha por link ou código
          </p>
        </div>
      </header>

      {/* O seletor fica na tela de login de proposito: escolher o backend antes
          de entrar evita ter de deslogar depois so para troca-lo. */}
      <div className="flex justify-center">
        <BackendSwitcher />
      </div>

      <Card>
        {step === "email" ? (
          <>
            <CardHeader>
              <CardTitle>Entrar</CardTitle>
              <CardDescription>
                Enviaremos um link de acesso e um código de 6 dígitos. O primeiro acesso já cria a
                conta.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <form onSubmit={solicitarAcesso} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email">E-mail</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    autoFocus
                    placeholder="operador@sabemi.com.br"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                {erro ? (
                  <Alert tone="error" icon="bi-exclamation-octagon-fill">
                    {erro}
                  </Alert>
                ) : null}

                <Button type="submit" disabled={enviando || email.trim() === ""}>
                  {enviando ? (
                    <>
                      <i className="bi bi-arrow-repeat animate-spin" aria-hidden="true" />
                      Enviando…
                    </>
                  ) : (
                    <>
                      <i className="bi bi-send" aria-hidden="true" />
                      Enviar link de acesso
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle>Confirme o acesso</CardTitle>
              <CardDescription>
                Enviamos um link e um código para <strong>{pedido?.email}</strong>.
              </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
              {/* O indicador de espera e a parte visivel do polling: mostra que
                  a aba esta trabalhando e que o link pode ser aberto em outro
                  aparelho. */}
              <div
                className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface-muted px-4 py-3"
                aria-live="polite"
              >
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  {aguardando ? (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-70" />
                  ) : null}
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand" />
                </span>
                <div className="min-w-0 text-sm">
                  <p className="font-medium">Aguardando confirmação…</p>
                  <p className="text-xs text-[color:var(--muted-foreground)]">
                    Pode abrir o link em outro aparelho — esta aba entra sozinha.
                  </p>
                </div>
              </div>

              {aviso ? (
                <Alert tone="warning" icon="bi-exclamation-triangle-fill">
                  {aviso}
                </Alert>
              ) : null}

              {/* Atalho de desenvolvimento: em produção o servidor nunca envia
                  estes campos (ver AuthOptions.ExposeLoginCodes). */}
              {pedido?.dev_magic_url ? (
                <Alert tone="info" icon="bi-tools">
                  <p className="mb-2 font-semibold">Atalho de desenvolvimento</p>
                  <p className="mb-2 text-xs">
                    Sem servidor de e-mail configurado, o link e o código aparecem aqui.
                  </p>
                  <a
                    href={pedido.dev_magic_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 font-semibold underline"
                  >
                    <i className="bi bi-box-arrow-up-right" aria-hidden="true" />
                    Abrir link de confirmação
                  </a>
                  {pedido.dev_otp_code ? (
                    <p className="mt-2 text-xs">
                      Código:{" "}
                      <code className="tabular rounded bg-surface px-1.5 py-0.5 font-mono font-bold">
                        {pedido.dev_otp_code}
                      </code>
                    </p>
                  ) : null}
                </Alert>
              ) : null}

              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs uppercase tracking-wide text-[color:var(--muted-foreground)]">
                  ou digite o código
                </span>
                <Separator className="flex-1" />
              </div>

              <form onSubmit={confirmarOtp} className="flex flex-col gap-3">
                <Input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  placeholder="000000"
                  aria-label="Código de 6 dígitos"
                  className="tabular text-center text-2xl font-semibold tracking-[0.4em]"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />

                {erro ? (
                  <Alert tone="error" icon="bi-exclamation-octagon-fill">
                    {erro}
                  </Alert>
                ) : null}

                <Button type="submit" disabled={verificando || otp.length !== 6}>
                  {verificando ? "Verificando…" : "Entrar com o código"}
                </Button>

                <Button type="button" variant="ghost" size="sm" onClick={voltar}>
                  Usar outro e-mail
                </Button>
              </form>
            </CardContent>
          </>
        )}
      </Card>

      <p className="text-center text-xs text-[color:var(--muted-foreground)]">
        O token de sessão fica em cookie <code>httpOnly</code> — nunca acessível ao JavaScript.
      </p>
    </div>
  );
}
