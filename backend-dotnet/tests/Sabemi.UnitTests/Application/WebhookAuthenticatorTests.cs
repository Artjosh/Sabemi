using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sabemi.Infrastructure.Security;
using Shouldly;

namespace Sabemi.UnitTests.Application;

/// <summary>
/// Autenticacao do webhook: ApiKey e assinatura HMAC.
/// </summary>
/// <remarks>
/// Este e o portao de entrada do sistema. Os testes cobrem tanto o caminho feliz
/// quanto as formas de contorna-lo: chave errada, assinatura ausente, assinatura
/// de OUTRO corpo, e a configuracao vazia (que precisa falhar fechada, nao
/// aberta).
/// </remarks>
public class WebhookAuthenticatorTests
{
    private const string ApiKey = "chave-secreta-do-parceiro";
    private const string Segredo = "segredo-hmac-compartilhado";
    private const string Corpo = """{"id_transacao":"TRX-1","valor":100}""";

    private static WebhookAuthenticator Criar(
        string apiKey = ApiKey,
        string segredo = Segredo,
        bool exigirAssinatura = true)
        => new(
            Options.Create(new WebhookSecurityOptions
            {
                ApiKey = apiKey,
                SignatureSecret = segredo,
                RequireSignature = exigirAssinatura,
            }),
            NullLogger<WebhookAuthenticator>.Instance);

    [Fact]
    public void Chave_e_assinatura_corretas_sao_aceitas()
    {
        var auth = Criar();
        var assinatura = WebhookAuthenticator.ComputeSignature(Corpo, Segredo);

        var (resultado, verificada) = auth.Authenticate(ApiKey, assinatura, Corpo);

        resultado.ShouldBe(WebhookAuthResult.Ok);
        verificada.ShouldBeTrue();
    }

    [Fact]
    public void Aceita_a_assinatura_com_o_prefixo_sha256()
    {
        // Convencao usada por GitHub e Stripe; o parceiro pode ja seguir uma delas.
        var auth = Criar();
        var assinatura = WebhookAuthenticator.ComputeSignature(Corpo, Segredo);

        var (resultado, _) = auth.Authenticate(ApiKey, $"sha256={assinatura}", Corpo);

        resultado.ShouldBe(WebhookAuthResult.Ok);
    }

    [Fact]
    public void Aceita_assinatura_em_maiusculas()
    {
        var auth = Criar();
        var assinatura = WebhookAuthenticator.ComputeSignature(Corpo, Segredo).ToUpperInvariant();

        var (resultado, _) = auth.Authenticate(ApiKey, assinatura, Corpo);

        resultado.ShouldBe(WebhookAuthResult.Ok);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("chave-errada")]
    [InlineData("chave-secreta-do-parceir")]  // um caractere a menos
    public void Chave_ausente_ou_incorreta_e_recusada(string? chave)
    {
        var auth = Criar();
        var assinatura = WebhookAuthenticator.ComputeSignature(Corpo, Segredo);

        var (resultado, _) = auth.Authenticate(chave, assinatura, Corpo);

        resultado.ShouldBe(WebhookAuthResult.InvalidApiKey);
    }

    [Fact]
    public void Assinatura_ausente_e_recusada_quando_exigida()
    {
        var auth = Criar(exigirAssinatura: true);

        var (resultado, _) = auth.Authenticate(ApiKey, null, Corpo);

        resultado.ShouldBe(WebhookAuthResult.MissingSignature);
    }

    [Fact]
    public void Assinatura_ausente_e_tolerada_quando_nao_exigida()
    {
        // Modo de migracao gradual: o parceiro ainda nao assina, mas o segredo ja
        // esta configurado do nosso lado.
        var auth = Criar(exigirAssinatura: false);

        var (resultado, verificada) = auth.Authenticate(ApiKey, null, Corpo);

        resultado.ShouldBe(WebhookAuthResult.Ok);
        verificada.ShouldBeFalse();
    }

    [Fact]
    public void Assinatura_de_outro_corpo_e_recusada()
    {
        // O caso que a ApiKey sozinha nao pega: credencial valida, corpo adulterado
        // em transito.
        var auth = Criar();
        var assinaturaDeOutroCorpo = WebhookAuthenticator.ComputeSignature("""{"valor":1}""", Segredo);

        var (resultado, _) = auth.Authenticate(ApiKey, assinaturaDeOutroCorpo, Corpo);

        resultado.ShouldBe(WebhookAuthResult.InvalidSignature);
    }

    [Fact]
    public void Assinatura_com_o_segredo_errado_e_recusada()
    {
        var auth = Criar();
        var assinatura = WebhookAuthenticator.ComputeSignature(Corpo, "segredo-do-atacante");

        var (resultado, _) = auth.Authenticate(ApiKey, assinatura, Corpo);

        resultado.ShouldBe(WebhookAuthResult.InvalidSignature);
    }

    [Fact]
    public void Alterar_um_unico_caractere_do_corpo_invalida_a_assinatura()
    {
        var auth = Criar();
        var assinatura = WebhookAuthenticator.ComputeSignature(Corpo, Segredo);
        var corpoAdulterado = Corpo.Replace("100", "900");

        var (resultado, _) = auth.Authenticate(ApiKey, assinatura, corpoAdulterado);

        resultado.ShouldBe(WebhookAuthResult.InvalidSignature);
    }

    [Fact]
    public void Sem_segredo_configurado_a_assinatura_nao_e_verificada()
    {
        var auth = Criar(segredo: "");

        var (resultado, verificada) = auth.Authenticate(ApiKey, "qualquer-coisa", Corpo);

        resultado.ShouldBe(WebhookAuthResult.Ok);
        verificada.ShouldBeFalse();
    }

    [Fact]
    public void Sem_ApiKey_configurada_o_endpoint_falha_FECHADO()
    {
        // O teste mais importante deste arquivo. Uma configuracao faltando nao pode
        // resultar em endpoint aberto - o modo de falha teria de ser descoberto por
        // um incidente.
        var auth = Criar(apiKey: "");

        var (resultado, _) = auth.Authenticate("qualquer-chave", null, Corpo);

        resultado.ShouldBe(WebhookAuthResult.InvalidApiKey);
    }

    [Fact]
    public void Assinatura_e_deterministica_e_muda_com_o_corpo()
    {
        var a = WebhookAuthenticator.ComputeSignature(Corpo, Segredo);
        var b = WebhookAuthenticator.ComputeSignature(Corpo, Segredo);
        var c = WebhookAuthenticator.ComputeSignature(Corpo + " ", Segredo);

        a.ShouldBe(b);
        a.ShouldNotBe(c);
        a.Length.ShouldBe(64);  // SHA-256 em hexadecimal
    }
}
