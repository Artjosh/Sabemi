"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { THEME_STORAGE_KEY } from "@/lib/utils";

/**
 * Alterna entre claro e escuro.
 *
 * <b>Por que existe, se o CSS ja respeita `prefers-color-scheme`.</b> Respeitar
 * a preferencia do sistema e o padrao certo, e continua sendo o estado inicial.
 * Mas nao cobre o caso real de quem opera o painel: a maquina no escuro a noite
 * e a tela clara exigida pela sala de manha - ou o contrario, numa demonstracao
 * com projetor. Este botao permite discordar do sistema sem mexer nele.
 *
 * <b>Um clique inverte o tema. Sempre.</b> A primeira versao ciclava
 * `sistema -> claro -> escuro -> sistema`, e isso tinha um defeito que so
 * aparece com o sistema no escuro: o estado inicial e "sistema", entao o
 * primeiro clique levava a "claro" - CLAREANDO uma tela que a pessoa queria
 * escurecer - e so o segundo chegava em "escuro". Dois cliques, e o primeiro
 * na direcao errada.
 *
 * A causa era tratar "sistema" como um passo do ciclo. Aqui ele e apenas o
 * ponto de partida: o clique le o tema EFETIVO na tela (o atributo, ou o
 * `prefers-color-scheme` quando nao ha atributo) e grava explicitamente o
 * oposto. O botao passa a ser o que aparenta ser - um interruptor.
 *
 * <b>Como a troca chega ao CSS.</b> Escrevendo `data-theme` no <html>. As cores
 * sao declaradas com `light-dark()` e resolvem pelo `color-scheme`, que o
 * `globals.css` amarra a esse atributo - entao trocar o atributo repinta a
 * pagina inteira sem re-render do React e sem uma classe `dark:` por utilitario.
 *
 * <b>O piscar na primeira pintura</b> e evitado no `app/layout.tsx`, por um
 * script inline que aplica o valor salvo ANTES do primeiro paint. Se a decisao
 * ficasse so aqui, num efeito, a pagina apareceria clara por um quadro antes de
 * escurecer - o defeito classico de tema persistido.
 */

export type Theme = "light" | "dark";

const APARENCIA: Record<Theme, { icone: string; rotulo: string }> = {
  light: { icone: "bi-sun-fill", rotulo: "Tema claro — clique para escurecer" },
  dark: { icone: "bi-moon-stars-fill", rotulo: "Tema escuro — clique para clarear" },
};

/** O tema que esta na tela agora: o escolhido, ou o do sistema se nao houver. */
function esquemaEfetivo(): Theme {
  const escolhido = document.documentElement.getAttribute("data-theme");
  if (escolhido === "light" || escolhido === "dark") return escolhido;

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  // Comeca em `null` porque no servidor nao ha como saber o tema do sistema.
  // Renderizar "claro" por padrao faria o icone trocar sozinho na hidratacao de
  // quem usa o escuro - o mesmo piscar, so que no botao.
  const [tema, setTema] = React.useState<Theme | null>(null);

  React.useEffect(() => {
    setTema(esquemaEfetivo());

    // Enquanto ninguem escolheu, o sistema manda - e ele pode mudar com a tela
    // aberta (agendamento de noite do SO). Sem este ouvinte o icone ficaria
    // mostrando o tema anterior.
    const consulta = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!consulta) return;

    const aoMudar = () => {
      if (!document.documentElement.hasAttribute("data-theme")) setTema(esquemaEfetivo());
    };
    consulta.addEventListener("change", aoMudar);
    return () => consulta.removeEventListener("change", aoMudar);
  }, []);

  const aparencia = APARENCIA[tema ?? "light"];

  return (
    <Button
      variant="ghost"
      size="icon"
      className="rounded-full"
      onClick={() => {
        const proximo: Theme = esquemaEfetivo() === "dark" ? "light" : "dark";

        document.documentElement.setAttribute("data-theme", proximo);
        setTema(proximo);

        try {
          localStorage.setItem(THEME_STORAGE_KEY, proximo);
        } catch {
          // Modo privativo ou armazenamento bloqueado: o tema vale para esta
          // aba e nao persiste. Nao vale quebrar a tela por causa disso.
        }
      }}
      title={aparencia.rotulo}
      aria-label={aparencia.rotulo}
    >
      {/* Ate saber o tema efetivo, o icone fica invisivel mas ocupa o espaco -
          o botao nao muda de tamanho na hidratacao. */}
      <i className={`bi ${aparencia.icone} ${tema ? "" : "opacity-0"}`} aria-hidden="true" />
    </Button>
  );
}
