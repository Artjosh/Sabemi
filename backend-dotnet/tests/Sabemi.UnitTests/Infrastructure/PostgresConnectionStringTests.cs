using Microsoft.Extensions.Configuration;
using Npgsql;
using Sabemi.Infrastructure.Persistence;
using Shouldly;

namespace Sabemi.UnitTests.Infrastructure;

/// <summary>
/// Tradução da `DATABASE_URL` para a conexão do Npgsql.
/// </summary>
/// <remarks>
/// Este é o ponto do sistema onde um erro só apareceria em produção: uma senha
/// mal decodificada ou um SSL não exigido não quebram nada localmente - o
/// Postgres do Compose aceita tudo. A falha aparece no primeiro deploy contra um
/// Supabase remoto, como "falha de autenticação" ou, pior, como uma conexão em
/// claro pela internet que ninguém percebe.
/// </remarks>
public class PostgresConnectionStringTests
{
    /// <summary>Monta a configuração como o host a receberia do ambiente.</summary>
    private static IConfiguration Ambiente(params (string Chave, string Valor)[] valores)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(valores.Select(v =>
                new KeyValuePair<string, string?>(v.Chave, v.Valor)))
            .Build();

    private static NpgsqlConnectionStringBuilder Resolver(IConfiguration configuracao)
        => new(PostgresConnectionString.Resolver(configuracao));

    [Fact]
    public void Traduz_uma_URL_completa()
    {
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "postgresql://sabemi_app:senha123@db.exemplo.com:6543/postgres")));

        conexao.Host.ShouldBe("db.exemplo.com");
        conexao.Port.ShouldBe(6543);
        conexao.Database.ShouldBe("postgres");
        conexao.Username.ShouldBe("sabemi_app");
        conexao.Password.ShouldBe("senha123");
    }

    [Fact]
    public void Aceita_o_esquema_postgres_alem_de_postgresql()
    {
        // Os dois aparecem no painel do Supabase, dependendo de onde se copia.
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "postgres://u:p@localhost/postgres")));

        conexao.Username.ShouldBe("u");
    }

    [Fact]
    public void Porta_ausente_vira_5432()
    {
        var conexao = Resolver(Ambiente(("DATABASE_URL", "postgresql://u:p@localhost/postgres")));

        conexao.Port.ShouldBe(5432);
    }

    [Fact]
    public void Banco_ausente_vira_postgres()
    {
        var conexao = Resolver(Ambiente(("DATABASE_URL", "postgresql://u:p@localhost")));

        conexao.Database.ShouldBe("postgres");
    }

    [Fact]
    public void Senha_percent_encoded_e_DECODIFICADA()
    {
        // O Supabase gera senhas com caractere especial, e elas chegam
        // percent-encoded na URL. Passá-las sem decodificar produz uma falha que
        // parece credencial errada - e a pessoa vai conferir a senha no painel,
        // onde ela está certa.
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "postgresql://u:se%40nha%3Aforte%2F1@db.exemplo.com/postgres")));

        conexao.Password.ShouldBe("se@nha:forte/1");
    }

    [Fact]
    public void Usuario_percent_encoded_tambem()
    {
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "postgresql://postgres.abcdefgh%40pooler:p@db.exemplo.com/postgres")));

        conexao.Username.ShouldBe("postgres.abcdefgh@pooler");
    }

    // ------------------------------------------------------------------- SSL

    [Fact]
    public void Host_REMOTO_sem_sslmode_ainda_exige_TLS()
    {
        // A decisão mais importante deste arquivo. Uma URL remota sem `sslmode`
        // não pode resultar em conexão em claro pela internet: falhar pedindo TLS
        // é recuperável, trafegar credenciais em claro não.
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "postgresql://u:p@db.exemplo.com/postgres")));

        conexao.SslMode.ShouldBe(SslMode.Require);
    }

    [Theory]
    [InlineData("localhost")]
    [InlineData("127.0.0.1")]
    [InlineData("postgres")]
    public void Host_LOCAL_sem_sslmode_nao_exige_TLS(string host)
    {
        // O Postgres do Compose não tem certificado. Exigir TLS aqui impediria a
        // stack de subir - e o tráfego não sai da máquina.
        var conexao = Resolver(Ambiente(("DATABASE_URL", $"postgresql://u:p@{host}/postgres")));

        conexao.SslMode.ShouldBe(SslMode.Prefer);
    }

    [Theory]
    [InlineData("disable", SslMode.Disable)]
    [InlineData("prefer", SslMode.Prefer)]
    [InlineData("require", SslMode.Require)]
    [InlineData("verify-full", SslMode.VerifyFull)]
    public void O_sslmode_da_URL_e_respeitado(string parametro, SslMode esperado)
    {
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", $"postgresql://u:p@db.exemplo.com/postgres?sslmode={parametro}")));

        conexao.SslMode.ShouldBe(esperado);
    }

    [Fact]
    public void Require_confia_no_certificado_do_servidor()
    {
        // `Require` significa "criptografe, mas não valide a cadeia". O
        // certificado do Supabase é assinado por uma CA que não está no trust
        // store da imagem, e sem isto a conexão falha com "remote certificate is
        // invalid". Quem precisa de validação real usa `verify-full`.
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "postgresql://u:p@db.exemplo.com/postgres?sslmode=require")));

        conexao.TrustServerCertificate.ShouldBeTrue();
    }

    [Fact]
    public void Verify_full_NAO_confia_cegamente()
    {
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "postgresql://u:p@db.exemplo.com/postgres?sslmode=verify-full")));

        conexao.TrustServerCertificate.ShouldBeFalse();
    }

    // --------------------------------------------------------- precedência

    [Fact]
    public void A_DATABASE_URL_vence_o_ConnectionStrings_Postgres()
    {
        // Este teste existe por causa de uma falha real. O `appsettings.json` é
        // versionado e traz uma `ConnectionStrings:Postgres` de desenvolvimento
        // (`Host=localhost`). O `IConfiguration` não distingue "veio do arquivo"
        // de "veio do ambiente", então dar precedência à forma nativa fez o valor
        // do ARQUIVO vencer a variável que o Compose passava: a API subiu
        // tentando `localhost:5432` DENTRO do container e morreu com "Connection
        // refused", ignorando a `DATABASE_URL` em silêncio.
        var conexao = Resolver(Ambiente(
            ("ConnectionStrings:Postgres", "Host=do-arquivo;Username=u;Password=p"),
            ("DATABASE_URL", "postgresql://u:p@do-ambiente:5432/postgres")));

        conexao.Host.ShouldBe("do-ambiente");
    }

    [Fact]
    public void Sem_DATABASE_URL_a_forma_nativa_e_usada()
    {
        // A forma nativa continua servindo a quem precisa de um parâmetro do
        // Npgsql que não cabe numa URL - basta não definir DATABASE_URL.
        var conexao = Resolver(Ambiente(
            ("ConnectionStrings:Postgres", "Host=nativo;Username=u;Password=p;Timeout=42")));

        conexao.Host.ShouldBe("nativo");
        conexao.Timeout.ShouldBe(42);
    }

    [Fact]
    public void Aceita_o_formato_nativo_DENTRO_da_DATABASE_URL()
    {
        // Quem já tinha uma connection string exportada como DATABASE_URL veria
        // um erro de "URL inválida" sem entender por quê.
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "Host=nativo;Username=u;Password=p")));

        conexao.Host.ShouldBe("nativo");
    }

    [Fact]
    public void Sem_configuracao_alguma_devolve_null()
    {
        // Quem chama decide a mensagem de erro - ela precisa dizer as DUAS
        // variáveis aceitas.
        PostgresConnectionString.Resolver(Ambiente()).ShouldBeNull();
    }

    [Fact]
    public void URL_sem_usuario_falha_com_mensagem_util()
    {
        var erro = Should.Throw<InvalidOperationException>(() =>
            PostgresConnectionString.Resolver(Ambiente(
                ("DATABASE_URL", "postgresql://db.exemplo.com/postgres"))));

        erro.Message.ShouldContain("usuário");
    }

    [Fact]
    public void URL_malformada_falha_dizendo_o_formato_esperado()
    {
        var erro = Should.Throw<InvalidOperationException>(() =>
            PostgresConnectionString.Resolver(Ambiente(
                ("DATABASE_URL", "postgresql://:@:"))));

        erro.Message.ShouldContain("postgresql://");
    }

    [Fact]
    public void A_conexao_se_identifica_em_pg_stat_activity()
    {
        // Com dois backends no mesmo banco, é o que permite saber de quem é cada
        // conexão ao investigar uma consulta lenta ou um lock.
        var conexao = Resolver(Ambiente(("DATABASE_URL", "postgresql://u:p@localhost/postgres")));

        conexao.ApplicationName.ShouldBe("sabemi-dotnet");
    }
}
