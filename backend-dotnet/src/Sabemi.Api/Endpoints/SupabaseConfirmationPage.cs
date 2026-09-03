using System.Text.Json;

namespace Sabemi.Api.Endpoints;

/// <summary>
/// Página que o GoTrue abre depois de validar o magic link.
/// </summary>
/// <remarks>
/// <b>Por que existe uma página, e não um redirect direto.</b> O GoTrue devolve o
/// token de acesso no FRAGMENTO da URL (<c>#access_token=…</c>), e fragmento não
/// é enviado ao servidor - é justamente por isso que ele é usado para
/// credenciais. Só o navegador o vê. Então esta página lê o fragmento, o envia
/// por POST, e o servidor valida o token contra o GoTrue antes de aprovar o
/// pedido.
///
/// <b>O que ela apaga, e por quê.</b> Ao terminar, o fragmento é removido da
/// barra de endereços com <c>history.replaceState</c>. Sem isso, o token de
/// acesso ficaria no histórico do aparelho - que costuma ser o celular de alguém,
/// às vezes compartilhado.
///
/// <b>Sobre a interpolação.</b> O <c>selector</c> vem da query e é inserido no
/// JavaScript, então passa por <c>JsonSerializer.Serialize</c> - que produz uma
/// string JSON válida e escapada. Concatenar com aspas simples seria uma
/// injeção de script esperando um selector com <c>'</c> dentro.
/// </remarks>
internal static class SupabaseConfirmationPage
{
    public static string Render(string selector)
    {
        // Serialize produz o literal COM as aspas e com todo escape necessário.
        var selectorJs = JsonSerializer.Serialize(selector);

        return $$"""
        <!doctype html>
        <html lang="pt-BR">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Sabemi - Acesso</title>
          <style>
            :root { color-scheme: light dark; }
            body {
              margin: 0; min-height: 100vh; display: grid; place-items: center;
              background: #0f172a; color: #e2e8f0;
              font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
            }
            .card {
              max-width: 26rem; padding: 2.5rem 2rem; border-radius: 1rem; text-align: center;
              background: #1e293b; border: 1px solid #334155;
            }
            .badge {
              width: 3.5rem; height: 3.5rem; border-radius: 999px; margin: 0 auto 1.25rem;
              display: grid; place-items: center; font-size: 1.75rem; font-weight: 700;
            }
            .aguardando { background: #1d4ed822; color: #60a5fa; }
            .ok         { background: #16a34a22; color: #16a34a; }
            .erro       { background: #dc262622; color: #dc2626; }
            h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
            p { color: #94a3b8; line-height: 1.6; margin: 0; font-size: .95rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge aguardando" id="badge">&hellip;</div>
            <h1 id="titulo">Confirmando o acesso</h1>
            <p id="mensagem">Um instante.</p>
          </div>

          <script>
            (function () {
              var selector = {{selectorJs}};

              function mostrar(estado, titulo, mensagem) {
                var badge = document.getElementById("badge");
                badge.className = "badge " + estado;
                badge.innerHTML = estado === "ok" ? "&#10003;" : "&#10007;";
                document.getElementById("titulo").textContent = titulo;
                document.getElementById("mensagem").textContent = mensagem;
              }

              // O token vem no fragmento, que so o navegador ve. `substring(1)`
              // remove o `#`.
              var fragmento = new URLSearchParams(window.location.hash.substring(1));
              var token = fragmento.get("access_token");

              // O GoTrue tambem usa o fragmento para reportar erro - por exemplo
              // um link ja usado ou expirado. Ler isso primeiro evita mostrar
              // "token ausente" quando a causa e conhecida.
              var erroDoProvedor = fragmento.get("error_description") || fragmento.get("error");

              // Apaga o fragmento da barra de enderecos: sem isso o token de
              // acesso ficaria no historico do aparelho.
              try {
                history.replaceState(null, "", window.location.pathname + window.location.search);
              } catch (e) {
                // Navegador sem history API: o token no historico e um problema
                // menor do que nao confirmar o acesso.
              }

              if (erroDoProvedor) {
                mostrar("erro", "Link invalido", erroDoProvedor);
                return;
              }

              if (!token || !selector) {
                mostrar(
                  "erro",
                  "Link invalido",
                  "Este link expirou ou ja foi utilizado. Solicite um novo acesso."
                );
                return;
              }

              fetch("/auth/supabase/aprovar", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ selector: selector, access_token: token })
              })
                .then(function (r) {
                  if (r.ok) {
                    mostrar(
                      "ok",
                      "Acesso confirmado",
                      "Pode voltar para a aba onde voce iniciou o login. Ela entrara sozinha em alguns segundos."
                    );
                  } else {
                    mostrar(
                      "erro",
                      "Link invalido",
                      "Este link expirou ou ja foi utilizado. Solicite um novo acesso."
                    );
                  }
                })
                .catch(function () {
                  // Rede fora no meio da confirmacao.
                  //
                  // A mensagem NAO manda recarregar: o fragmento com o token ja
                  // foi apagado da barra de enderecos, entao um F5 chegaria aqui
                  // sem token nenhum e mostraria "link invalido" - pior do que
                  // dizer a verdade. Voltar ao e-mail funciona: o link do GoTrue
                  // continua valido enquanto nao for consumido.
                  mostrar(
                    "erro",
                    "Falha de conexao",
                    "Nao foi possivel confirmar agora. Abra o link do e-mail novamente."
                  );
                });
            })();
          </script>
        </body>
        </html>
        """;
    }
}
