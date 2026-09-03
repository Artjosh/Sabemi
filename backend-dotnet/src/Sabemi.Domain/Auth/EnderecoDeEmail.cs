namespace Sabemi.Domain.Auth;

/// <summary>
/// Decide se vale tentar entregar e-mail em um endereco.
/// </summary>
/// <remarks>
/// <b>Por que existe.</b> Alguns dominios de topo sao RESERVADOS por RFC
/// justamente para nao existirem: <c>.test</c>, <c>.example</c>,
/// <c>.invalid</c> e <c>.localhost</c> (RFC 2606, reafirmados pela RFC 6761).
/// Nenhum deles resolve em MX, nenhum endereco neles pode receber nada. Toda
/// mensagem enviada para um vira <b>hard bounce</b>.
///
/// E hard bounce nao e so uma mensagem perdida: provedores de envio contam
/// bounces para medir se quem envia sabe para quem esta enviando. Uma taxa alta
/// derruba a entregabilidade de <i>todo</i> o restante - inclusive dos e-mails
/// que importam. O efeito e acumulativo e nao se desfaz.
///
/// <b>Por que nao e uma concessao aos testes.</b> Recusar entrega em dominio
/// reservado e a decisao certa em producao tambem: a mensagem nao chegaria de
/// qualquer forma, e a tentativa cobra um preco. Que isso torne a suite ponta a
/// ponta incapaz de gerar bounces e consequencia, nao motivacao - a suite
/// autentica com enderecos inventados, e passou a inventa-los em
/// <c>@e2e.invalid</c>.
///
/// <b>O que NAO se faz aqui.</b> Nao se valida formato nem existencia de caixa.
/// Formato e trabalho do validador de entrada; existencia so o servidor de
/// destino sabe. A pergunta aqui e mais estreita e tem resposta certa:
/// <i>este dominio pode, em principio, receber e-mail?</i>
///
/// O backend VINEXT tem a traducao literal em
/// <c>server/bff/email-address.ts</c>, e um teste de paridade compara as duas
/// listas - as regras precisam ser as mesmas porque os dois compartilham a
/// tabela de pedidos de login.
/// </remarks>
public static class EnderecoDeEmail
{
    /// <summary>
    /// Dominios de topo reservados por RFC, que nunca recebem e-mail.
    /// </summary>
    /// <remarks>
    /// A lista e fechada de proposito. Ela vem de RFC, nao de configuracao:
    /// deixar configuravel abriria a porta para alguem suprimir um dominio real
    /// por engano e passar a perder e-mail de acesso em silencio.
    /// </remarks>
    public static readonly string[] DominiosReservados =
    [
        ".invalid",
        ".test",
        ".example",
        ".localhost",
    ];

    /// <summary>
    /// <c>true</c> se vale tentar entregar neste endereco.
    /// </summary>
    /// <remarks>
    /// Endereco vazio ou sem dominio devolve <c>false</c>: nao ha onde entregar.
    /// </remarks>
    public static bool PodeReceber(string? email)
    {
        if (string.IsNullOrWhiteSpace(email))
        {
            return false;
        }

        var arroba = email.LastIndexOf('@');
        if (arroba < 0 || arroba == email.Length - 1)
        {
            return false;
        }

        // Um ponto final e legitimo em nome de dominio (raiz explicita) e nao
        // deve esconder o TLD reservado: `a@b.invalid.` e igualmente inentregavel.
        var dominio = email[(arroba + 1)..].Trim().TrimEnd('.').ToLowerInvariant();

        // Tambem cobre o dominio reservado usado NU, sem subdominio: `a@invalid`.
        return !DominiosReservados.Any(reservado =>
            dominio.EndsWith(reservado, StringComparison.Ordinal)
            || dominio == reservado.TrimStart('.'));
    }
}
