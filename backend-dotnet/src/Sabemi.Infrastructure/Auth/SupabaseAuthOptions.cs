namespace Sabemi.Infrastructure.Auth;

/// <summary>
/// Endereço e chaves do GoTrue (Supabase Auth).
/// </summary>
/// <remarks>
/// <b>Local ou remoto, sem diferença de código.</b> A única coisa que muda entre
/// o GoTrue do <c>docker-compose.supabase.yml</c> e o de um projeto hospedado é a
/// <see cref="Url"/> e as chaves. É a mesma propriedade que a conexão do banco
/// tem: apontar para remoto é editar o <c>.env</c>.
/// </remarks>
public sealed class SupabaseAuthOptions
{
    public const string SectionName = "Supabase";

    /// <summary>
    /// Base do gateway: <c>http://localhost:54321</c> local, ou
    /// <c>https://SEU_REF.supabase.co</c> remoto. Os caminhos do GoTrue ficam
    /// sob <c>/auth/v1</c>.
    /// </summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>
    /// Chave <c>anon</c>. Vai no header <c>apikey</c>, que o Kong exige antes de
    /// encaminhar ao GoTrue.
    /// </summary>
    /// <remarks>
    /// É pública por desenho - ela existe para ser embutida em cliente de
    /// browser. Aqui ela só atravessa o gateway; o que autoriza de fato é o
    /// próprio fluxo do GoTrue (posse da caixa de e-mail).
    /// </remarks>
    public string AnonKey { get; set; } = string.Empty;

    /// <summary>
    /// Chave <c>service_role</c>. NÃO é usada no fluxo de login.
    /// </summary>
    /// <remarks>
    /// Ela ignora RLS e permite administrar usuários. O fluxo de acesso não
    /// precisa disso - usar a <c>anon</c> é o mínimo suficiente, e manter a
    /// <c>service_role</c> fora do caminho quente reduz o estrago de um log
    /// vazado ou de um erro que ecoe o header.
    ///
    /// Fica declarada porque o <c>.env</c> a traz e porque uma rotina
    /// administrativa futura vai precisar dela - com um comentário dizendo o
    /// preço.
    /// </remarks>
    public string ServiceRoleKey { get; set; } = string.Empty;

    /// <summary>
    /// Teto de tempo das chamadas.
    /// </summary>
    /// <remarks>
    /// 10s, e não o padrão de 100s do <c>HttpClient</c>. Quem espera é o usuário
    /// na tela de login, e 100 segundos é indistinguível de uma página travada.
    /// </remarks>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>Há endereço e chave configurados?</summary>
    public bool Configurado =>
        !string.IsNullOrWhiteSpace(Url) && !string.IsNullOrWhiteSpace(AnonKey);
}
