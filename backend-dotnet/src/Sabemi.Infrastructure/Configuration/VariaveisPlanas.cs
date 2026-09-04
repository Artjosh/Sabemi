using Microsoft.Extensions.Configuration;

namespace Sabemi.Infrastructure.Configuration;

/// <summary>
/// Faz os nomes "planos" de variavel de ambiente valerem para o backend .NET.
///
/// <para><b>O problema.</b> Os dois backends leem a mesma configuracao sob nomes
/// diferentes: o VINEXT usa o nome da variavel direto
/// (<c>WEBHOOK_API_KEY</c>), e o .NET usa a convencao do
/// <see cref="IConfiguration"/> (<c>WebhookSecurity__ApiKey</c>). Quem liga um ao
/// outro sempre foi o <c>docker-compose.yml</c>.</para>
///
/// <para><b>Por que isso e perigoso fora do Compose.</b> Em qualquer host que
/// nao use o compose - Railway, Fly, Render, um systemd - esse intermediario
/// deixa de existir. Quem define <c>JWT_SECRET</c> achando que configurou o
/// sistema configurou METADE dele: o VINEXT usa o valor, e o .NET cai no padrao
/// do <c>appsettings.json</c>.</para>
///
/// <para>E a falha e silenciosa, que e o que a torna cara. Aconteceu no primeiro
/// deploy real: os dois backends respondiam <c>200</c>, o painel abria, e o
/// <c>api</c> estava assinando sessao com o segredo VERSIONADO do repositorio.
/// O unico sintoma visivel era o webhook do .NET recusando a chave com
/// <c>401</c> - e so porque a chave tambem estava no par. Se apenas o JWT
/// estivesse errado, nada apareceria ate alguem trocar de backend no painel e
/// ser deslogado sem motivo aparente.</para>
///
/// <para><b>A correcao segue um precedente do proprio repositorio.</b>
/// <c>DATABASE_URL</c> ja serve aos dois backends, traduzida por
/// <c>PostgresConnectionString</c>. Aqui a mesma ideia vale para o resto: o nome
/// plano passa a ser entendido pelo .NET, entao um host sem compose recebe UMA
/// lista de variaveis e os dois lados leem os mesmos valores.</para>
///
/// <para><b>Precedencia: o nome especifico VENCE.</b> Se alguem definiu
/// <c>Jwt__Secret</c>, e ele que vale - o nome plano so preenche o que esta
/// ausente. Assim o comportamento sob Compose fica exatamente igual ao de antes,
/// e esta classe nunca sobrescreve uma escolha explicita.</para>
/// </summary>
public static class VariaveisPlanas
{
    /// <summary>
    /// Nome plano da variavel, e a chave de configuracao que ele alimenta.
    ///
    /// Esta tabela e o gemeo do mapeamento que o <c>docker-compose.yml</c> faz.
    /// <c>frontend/tests/node/compose-parity.test.ts</c> le os dois e falha se
    /// divergirem - porque uma configuracao que exista em um lado e nao no outro
    /// e exatamente o defeito que esta classe existe para impedir.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> Mapa =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["JWT_SECRET"] = "Jwt:Secret",

            ["WEBHOOK_API_KEY"] = "WebhookSecurity:ApiKey",
            ["WEBHOOK_SIGNATURE_SECRET"] = "WebhookSecurity:SignatureSecret",
            ["WEBHOOK_REQUIRE_SIGNATURE"] = "WebhookSecurity:RequireSignature",

            ["API_PUBLIC_URL"] = "Auth:PublicBaseUrl",
            ["AUTH_EXPOSE_LOGIN_CODES"] = "Auth:ExposeLoginCodesInDevelopment",
            ["AUTH_RESEND_COOLDOWN_SECONDS"] = "Auth:ResendCooldownSeconds",
            ["AUTH_RATE_LIMIT"] = "RateLimit:AuthPermitLimit",
            ["FRONTEND_PUBLIC_URL"] = "Cors:AllowedOrigins:0",

            ["PROCESSING_SIMULATED_WORK_MS"] = "Processing:SimulatedWorkMs",
            ["PROCESSING_BATCH_SIZE"] = "Processing:BatchSize",
            ["PROCESSING_MAX_ATTEMPTS"] = "Processing:MaxTentativas",

            ["BREVO_API_KEY"] = "Brevo:ApiKey",
            ["BREVO_SENDER_EMAIL"] = "Brevo:SenderEmail",
            ["BREVO_SENDER_NAME"] = "Brevo:SenderName",

            ["SUPABASE_URL"] = "Supabase:Url",
            ["SUPABASE_ANON_KEY"] = "Supabase:AnonKey",
        };

    /// <summary>
    /// O segredo de exemplo que acompanha o <c>appsettings.json</c>. Ele existe
    /// para o projeto rodar recem-clonado; usa-lo em producao seria assinar
    /// sessao com um valor que qualquer pessoa le no repositorio.
    /// </summary>
    public const string SegredoDeExemplo =
        "troque-este-segredo-em-producao-com-no-minimo-32-caracteres";

    /// <summary>
    /// Acrescenta, na configuracao, os valores planos que ainda nao tem
    /// equivalente especifico definido.
    /// </summary>
    public static void Aplicar(IConfigurationManager configuracao)
    {
        var preenchidos = new Dictionary<string, string?>(StringComparer.Ordinal);

        foreach (var (plano, chave) in Mapa)
        {
            // O nome especifico ja definido vence - ver a nota de precedencia.
            if (!string.IsNullOrWhiteSpace(configuracao[chave])) continue;

            var valor = Environment.GetEnvironmentVariable(plano);
            if (!string.IsNullOrWhiteSpace(valor)) preenchidos[chave] = valor;
        }

        if (preenchidos.Count > 0) configuracao.AddInMemoryCollection(preenchidos);
    }

    /// <summary>
    /// Recusa subir em producao com o segredo de exemplo.
    ///
    /// <para>Sem esta checagem, o modo de falha e o pior possivel: tudo responde
    /// <c>200</c>, o login funciona, e a unica anomalia visivel e o operador ser
    /// deslogado ao trocar de backend - porque os dois assinam com segredos
    /// diferentes. Falhar na subida troca uma brecha silenciosa por uma
    /// mensagem.</para>
    /// </summary>
    public static void ExigirSegredoProprio(IConfiguration configuracao, bool producao)
    {
        if (!producao) return;

        if (string.Equals(configuracao["Jwt:Secret"], SegredoDeExemplo, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Jwt:Secret ainda e o segredo de exemplo do appsettings.json. Em producao " +
                "ele assinaria a sessao com um valor publico no repositorio. Defina " +
                "JWT_SECRET (ou Jwt__Secret) - e use o MESMO valor no backend VINEXT, " +
                "senao trocar de backend no painel derruba a sessao.");
        }
    }
}
