namespace Sabemi.Infrastructure.Email;

/// <summary>
/// Credenciais e remetente da Brevo.
/// </summary>
/// <remarks>
/// <b>Por que a Brevo, e por que a MESMA conta nos dois backends.</b> O e-mail de
/// acesso é o mesmo produto, venha ele do .NET ou do VINEXT: mesmo remetente,
/// mesmo domínio verificado, mesma reputação de envio. Duas contas dariam duas
/// reputações a cuidar e um remetente que muda conforme o backend que atendeu -
/// que é justo o tipo de inconsistência que faz um provedor marcar a mensagem
/// como suspeita.
///
/// O que NÃO é compartilhado é o código do cliente: um é C#, o outro TypeScript.
/// O que os mantém equivalentes é a API (v3, o mesmo endpoint e o mesmo corpo) e
/// o conteúdo (<c>LoginEmail</c> / <c>login-email.ts</c>, com teste de paridade).
///
/// <b>Sobre o SMTP.</b> O <c>.env</c> também traz variáveis <c>SMTP_*</c> da
/// Brevo. Elas NÃO são usadas por estes backends - são do GoTrue, que só fala
/// SMTP e envia os e-mails da plataforma Supabase. Aqui usamos a API HTTP, que dá
/// erro imediato e legível em vez de uma falha assíncrona de entrega.
/// </remarks>
public sealed class BrevoOptions
{
    public const string SectionName = "Brevo";

    /// <summary>
    /// Chave da API v3 (<c>Brevo &gt; SMTP &amp; API &gt; API keys</c>).
    ///
    /// Vazia desliga o envio real: o backend cai para o remetente que escreve no
    /// log, e a UI mostra o link na tela. É o que permite avaliar o projeto sem
    /// uma conta na Brevo.
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Remetente. Precisa ser um endereço de um domínio VERIFICADO na conta -
    /// a Brevo recusa o envio com 400 caso contrário, e a mensagem de erro dela
    /// não deixa isso óbvio.
    /// </summary>
    public string SenderEmail { get; set; } = "nao-responda@sabemi.com.br";

    /// <summary>Nome exibido no remetente.</summary>
    public string SenderName { get; set; } = "Sabemi";

    /// <summary>
    /// Endpoint da API. Configurável para que os testes apontem para um servidor
    /// local em vez de precisarem de rede - e para permitir um proxy corporativo
    /// sem alterar código.
    /// </summary>
    public string BaseUrl { get; set; } = "https://api.brevo.com";

    /// <summary>
    /// Teto de tempo do envio.
    /// </summary>
    /// <remarks>
    /// 10s, e não o padrão de 100s do <c>HttpClient</c>. Quem espera é o usuário,
    /// olhando a tela de login: uma espera de 100 segundos é indistinguível de
    /// uma página travada. Estourado o prazo, o backend registra a falha e a UI
    /// oferece o link direto - o acesso não fica bloqueado por lentidão de um
    /// terceiro.
    /// </remarks>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>Há chave configurada?</summary>
    public bool Configurado => !string.IsNullOrWhiteSpace(ApiKey);
}
