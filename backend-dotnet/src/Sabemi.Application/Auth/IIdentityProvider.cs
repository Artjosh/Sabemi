using Sabemi.Domain.Entities;

namespace Sabemi.Application.Auth;

/// <summary>
/// Quem envia o desafio de acesso e quem valida o código digitado.
/// </summary>
/// <remarks>
/// <b>O que esta abstração NÃO cobre, e por quê.</b> Ela não cobre o pedido de
/// login em si - o <c>selector</c>, o polling, o uso único. Isso continua sempre
/// local, porque é o que dá o fluxo cross-device (pedir no desktop, confirmar no
/// celular) e o GoTrue não tem esse conceito: ele emite um magic link e espera o
/// clique redirecionar o MESMO navegador.
///
/// A divisão é o que permite ter os dois: a identidade é verificada por um
/// serviço dedicado, e a experiência cross-device continua funcionando.
///
/// <b>Duas implementações.</b>
/// <list type="bullet">
/// <item><c>LocalIdentityProvider</c> - geramos o magic token e o OTP, guardamos
/// os hashes e enviamos o e-mail (Brevo ou log).</item>
/// <item><c>SupabaseIdentityProvider</c> - o GoTrue gera, envia e valida; nós
/// só guardamos o selector.</item>
/// </list>
/// </remarks>
public interface IIdentityProvider
{
    /// <summary>Qual provedor esta implementação representa.</summary>
    IdentityProvider Kind { get; }

    /// <summary>
    /// Cria o pedido de login e dispara o desafio para o e-mail informado.
    /// </summary>
    /// <param name="email">Já normalizado (minúsculas, sem espaços).</param>
    /// <param name="selector">
    /// Identificador público do pedido, gerado por quem chama. Vai para o
    /// <c>redirect_to</c> no modo Supabase, porque é o que permite ao clique no
    /// celular aprovar o pedido que está sendo pollado no desktop.
    /// </param>
    Task<ChallengeResult> StartChallengeAsync(
        string email,
        string selector,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Valida o código digitado pelo usuário.
    /// </summary>
    /// <remarks>
    /// Recebe o <see cref="LoginRequest"/> porque o modo local precisa do hash
    /// gravado nele, e porque o contador de tentativas é do pedido - não do
    /// provedor.
    /// </remarks>
    Task<OtpVerification> VerifyOtpAsync(
        LoginRequest pedido,
        string code,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Valida um token de acesso emitido pelo provedor e devolve o e-mail do
    /// dono. <c>null</c> se o token não vale.
    /// </summary>
    /// <remarks>
    /// <b>Por que isto é necessário, e é a parte que não pode ser simplificada.</b>
    /// No modo Supabase, o clique no magic link cai num endpoint nosso que
    /// carrega o <c>selector</c> na query - e o selector é PÚBLICO por desenho
    /// (ele viaja em cada chamada de polling). Aprovar o pedido apenas por ele
    /// deixaria qualquer pessoa que observasse uma requisição de polling entrar
    /// na conta alheia.
    ///
    /// Então o que aprova não é o selector: é o token que o GoTrue emitiu, e que
    /// só existe para quem realmente abriu o e-mail. Este método é o que confere
    /// esse token - e quem chama ainda compara o e-mail devolvido com o do
    /// pedido, para um token válido de OUTRA conta não aprovar este.
    ///
    /// No modo local não há token externo: a implementação devolve <c>null</c> e
    /// o endpoint correspondente responde 404, porque a rota não existe naquele
    /// fluxo.
    /// </remarks>
    Task<string?> VerifyAccessTokenAsync(
        string accessToken,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// O que o desafio produziu.
/// </summary>
/// <param name="Pedido">
/// O pedido a persistir. Cada provedor o cria com a fábrica que corresponde ao
/// que ele guarda - <c>Create</c> (com hashes) ou <c>CreateDelegado</c> (sem).
/// </param>
/// <param name="EmailEnviado">
/// Houve envio real? É o que decide se a tela diz "confira seu e-mail" ou
/// mostra o código. Uma promessa errada aqui manda o usuário procurar um e-mail
/// que nunca vai chegar.
/// </param>
/// <param name="MagicUrl">
/// Link de confirmação, quando existe e pode ser mostrado. No modo Supabase é
/// <c>null</c>: o link é gerado dentro do GoTrue e nunca passa por aqui - e é
/// por isso que, nesse modo, a demonstração sem provedor de e-mail depende do
/// log do container do GoTrue.
/// </param>
/// <param name="OtpCode">
/// Código, sob a mesma condição do link. <c>null</c> no modo Supabase.
/// </param>
public readonly record struct ChallengeResult(
    LoginRequest Pedido,
    bool EmailEnviado,
    string? MagicUrl,
    string? OtpCode);

/// <summary>Desfecho da validação de um código.</summary>
public enum OtpVerification
{
    /// <summary>Código correto. Quem chama emite a sessão e consome o pedido.</summary>
    Valido,

    /// <summary>Código incorreto. Quem chama conta a tentativa.</summary>
    Invalido,

    /// <summary>
    /// O provedor externo não pôde ser consultado (fora do ar, timeout).
    /// </summary>
    /// <remarks>
    /// Separado de <see cref="Invalido"/> de propósito. Um provedor indisponível
    /// não é um código errado: contar como tentativa faria uma queda de dois
    /// segundos do GoTrue consumir o orçamento de tentativas do usuário e o
    /// obrigaria a pedir um acesso novo. E a mensagem na tela precisa dizer
    /// "tente de novo em instantes", não "código incorreto".
    /// </remarks>
    Indisponivel
}
