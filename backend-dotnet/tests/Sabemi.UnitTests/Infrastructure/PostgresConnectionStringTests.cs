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
    public void Traduz_uma_URL_completa_e_aplica_os_padroes()
    {
        var conexao = Resolver(Ambiente(
            ("DATABASE_URL", "postgresql://sabemi_app:senha123@db.exemplo.com:6543/postgres")));

        conexao.Host.ShouldBe("db.exemplo.com");
        conexao.Port.ShouldBe(6543);
        conexao.Database.ShouldBe("postgres");
        conexao.Username.ShouldBe("sabemi_app");
        conexao.Password.ShouldBe("senha123");

        // Sem porta e sem banco: os padroes do PostgreSQL. O esquema `postgres://`
        // tambem vale - e o que a Supabase entrega no painel.
        var minima = Resolver(Ambiente(("DATABASE_URL", "postgres://u:p@localhost")));
        minima.Port.ShouldBe(5432);
        minima.Database.ShouldBe("postgres");
        minima.Username.ShouldBe("u");
    }

    [Fact]
    public void Usuario_e_senha_percent_encoded_sao_DECODIFICADOS()
    {
        // A senha que a Supabase gera costuma ter `@`, `:` e `/`, e o usuario do
        // pooler tem um `@` no meio do nome. Sem decodificar, a autenticacao falha
        // com "password authentication failed" - que aponta para o lugar errado.
        var conexao = Resolver(Ambiente((
            "DATABASE_URL",
            "postgresql://postgres.abcdefgh%40pooler:se%40nha%3Aforte%2F1@db.exemplo.com/postgres")));

        conexao.Username.ShouldBe("postgres.abcdefgh@pooler");
        conexao.Password.ShouldBe("se@nha:forte/1");
    }

    [Theory]
    // Host remoto sem `sslmode` ainda exige TLS: trafegar credencial de banco em
    // claro pela internet nao pode depender de alguem lembrar do parametro.
    [InlineData("db.exemplo.com", null, SslMode.Require)]

    // Local nao exige: dentro da rede do Docker nao ha o que interceptar, e
    // exigir TLS ali quebraria o desenvolvimento sem ganho.
    [InlineData("localhost", null, SslMode.Prefer)]
    [InlineData("postgres", null, SslMode.Prefer)]

    // O parametro explicito vence em qualquer direcao.
    [InlineData("db.exemplo.com", "disable", SslMode.Disable)]
    [InlineData("db.exemplo.com", "require", SslMode.Require)]

    // `verify-full` valida a cadeia; `require` criptografa sem validar. A
    // distincao mora no proprio SslMode desde que `TrustServerCertificate` virou
    // obsoleta no Npgsql - nao ha mais um segundo parametro a conferir aqui.
    [InlineData("db.exemplo.com", "verify-full", SslMode.VerifyFull)]
    public void O_TLS_e_decidido_pelo_host_e_pelo_sslmode(
        string host, string? sslmode, SslMode esperado)
    {
        var url = $"postgresql://u:p@{host}/postgres"
            + (sslmode is null ? "" : $"?sslmode={sslmode}");

        var conexao = Resolver(Ambiente(("DATABASE_URL", url)));

        conexao.SslMode.ShouldBe(esperado);
    }

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
