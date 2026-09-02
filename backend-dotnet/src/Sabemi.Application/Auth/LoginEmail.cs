using System.Net;

namespace Sabemi.Application.Auth;

/// <summary>
/// O e-mail de acesso: assunto, corpo HTML e corpo em texto.
/// </summary>
/// <param name="Subject">Assunto.</param>
/// <param name="Html">Corpo HTML.</param>
/// <param name="Text">
/// Corpo alternativo em texto. Não é opcional: um e-mail só-HTML tem
/// pontuação pior em filtros de spam, e alguns clientes corporativos bloqueiam
/// HTML por política. Um código de acesso que não chega é um usuário que não
/// entra.
/// </param>
public readonly record struct LoginEmailContent(string Subject, string Html, string Text);

/// <summary>
/// Monta o e-mail com o link e o código de acesso.
/// </summary>
/// <remarks>
/// <b>Este arquivo tem um gêmeo:</b> <c>frontend/server/bff/login-email.ts</c>. Os
/// dois produzem o MESMO e-mail - mesmo assunto, mesmo texto, mesma estrutura -
/// e um teste de paridade compara os dois resultados. O motivo é direto: o
/// usuário não deveria receber e-mails diferentes dependendo de qual backend
/// atendeu o pedido de acesso, e a escolha do backend é um detalhe interno que
/// ele nem vê.
///
/// <b>Por que o conteúdo vive na aplicação, e não no provedor.</b> Poderia ser um
/// template na Brevo, referenciado por id. Não é, por duas razões: um template
/// remoto não entra em revisão de código nem no histórico do repositório, e
/// trocar de provedor exigiria recriá-lo. Aqui, o e-mail é código - e o teste que
/// verifica que o código de acesso aparece no corpo roda em CI.
///
/// <b>Sobre o escape.</b> Tanto o link quanto o OTP são gerados pelo servidor, e
/// não vêm de entrada do usuário. O escape é aplicado de todo modo: o link já
/// contém um token base64url que pode trazer <c>-</c> e <c>_</c>, e um dia esta
/// função pode passar a receber algo derivado do e-mail digitado. Escapar sempre
/// é mais barato do que auditar a origem de cada valor a cada mudança.
/// </remarks>
public static class LoginEmail
{
    /// <summary>Assunto, igual nos dois backends.</summary>
    public const string Assunto = "Seu acesso ao painel Sabemi";

    /// <summary>
    /// Monta o conteúdo.
    /// </summary>
    /// <param name="magicUrl">Link de confirmação de uso único.</param>
    /// <param name="otpCode">Código de 6 dígitos, para quem não pode clicar.</param>
    /// <param name="minutosDeValidade">
    /// Aparece no corpo. Dizer "expira em 15 minutos" evita o suporte que começa
    /// com "cliquei no link de ontem e não funcionou".
    /// </param>
    public static LoginEmailContent Build(string magicUrl, string otpCode, int minutosDeValidade)
    {
        var link = WebUtility.HtmlEncode(magicUrl);
        var codigo = WebUtility.HtmlEncode(otpCode);

        // HTML deliberadamente simples e com estilo inline. Clientes de e-mail
        // descartam <style> no <head> (o Gmail, entre eles) e não têm suporte
        // consistente a flexbox ou grid - qualquer coisa mais elaborada apareceria
        // quebrada em algum cliente relevante.
        var html = $"""
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head><meta charset="utf-8"></head>
            <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
              <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;">Acesso ao painel Sabemi</h1>

                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;">
                  Você pediu acesso ao painel de conciliação de pagamentos.
                  Use o botão abaixo para entrar.
                </p>

                <p style="margin:0 0 24px;">
                  <a href="{link}"
                     style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:bold;">
                    Entrar no painel
                  </a>
                </p>

                <p style="margin:0 0 8px;font-size:14px;line-height:1.6;">
                  Se preferir, digite este código na tela em que você pediu o acesso:
                </p>

                <p style="margin:0 0 24px;font-size:28px;font-weight:bold;letter-spacing:4px;font-family:monospace;">
                  {codigo}
                </p>

                <p style="margin:0 0 8px;font-size:12px;color:#64748b;line-height:1.6;">
                  O link e o código valem por {minutosDeValidade} minutos e servem uma única vez.
                </p>

                <p style="margin:0;font-size:12px;color:#64748b;line-height:1.6;">
                  Se não foi você que pediu, ignore esta mensagem: sem o link ou o código,
                  ninguém entra na sua conta.
                </p>
              </div>
            </body>
            </html>
            """;

        // No texto o link vai CRU, sem escape de HTML: entidades como `&amp;`
        // quebrariam a URL ao ser colada no navegador.
        var texto = $"""
            Acesso ao painel Sabemi

            Você pediu acesso ao painel de conciliação de pagamentos.

            Entre por este link:
            {magicUrl}

            Ou digite este código na tela em que você pediu o acesso:
            {otpCode}

            O link e o código valem por {minutosDeValidade} minutos e servem uma única vez.

            Se não foi você que pediu, ignore esta mensagem: sem o link ou o código,
            ninguém entra na sua conta.
            """;

        return new LoginEmailContent(Assunto, html, texto);
    }
}
