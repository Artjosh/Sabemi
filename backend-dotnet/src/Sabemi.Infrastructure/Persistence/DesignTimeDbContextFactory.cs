using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.Extensions.Configuration;

namespace Sabemi.Infrastructure.Persistence;

/// <summary>
/// Constroi o <see cref="SabemiDbContext"/> para as ferramentas de linha de
/// comando do EF Core (<c>dotnet ef migrations add</c>, <c>database update</c>).
/// </summary>
/// <remarks>
/// <para>Sem esta fabrica, o <c>dotnet ef</c> tentaria descobrir o contexto
/// executando o host da API. Isso funciona por acidente e falha de formas
/// irritantes: o host aplica migrations na subida, entao gerar uma migration
/// exigiria um banco no ar - e criar a primeira migration em uma maquina limpa
/// se tornaria impossivel.</para>
///
/// <para>Aqui a unica coisa que importa e o <i>modelo</i>. A string de conexao
/// serve so para o provider saber gerar SQL do PostgreSQL; nenhuma conexao e
/// aberta ao criar uma migration. Ela vem do ambiente quando o comando de fato
/// precisa falar com o banco (<c>database update</c>, <c>dbcontext script</c>).</para>
///
/// <para><b>A MESMA resolucao da aplicacao.</b> Le <c>DATABASE_URL</c> (ou
/// <c>ConnectionStrings__Postgres</c>) pelo <see cref="PostgresConnectionString"/>,
/// e nao por uma leitura propria. Isso importa: com uma leitura propria, um
/// <c>database update</c> apontado para um Supabase remoto por <c>DATABASE_URL</c>
/// ignorava a variavel em silencio e migrava o banco LOCAL - a saida dizia
/// "sucesso" e o banco remoto continuava sem as tabelas.</para>
/// </remarks>
// Fora da metrica de cobertura: este tipo so e instanciado pelas ferramentas
// de linha de comando do EF Core, nunca pela aplicacao em execucao. Cobri-lo
// exigiria um teste que invoca o `dotnet ef`, o que mede a ferramenta e nao o
// nosso codigo. Os testes de integracao ja validam o schema que ele produz.
[ExcludeFromCodeCoverage]
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<SabemiDbContext>
{
    /// <summary>
    /// Usada apenas por comandos que NAO conectam (<c>migrations add</c>,
    /// <c>migrations script</c>). Aponta para o Postgres de desenvolvimento com
    /// os valores do Compose, para que criar uma migration numa maquina limpa
    /// nao exija configuracao alguma.
    /// </summary>
    private const string FallbackConnectionString =
        "Host=localhost;Port=5432;Database=postgres;Username=sabemi_app;Password=sabemi";

    public SabemiDbContext CreateDbContext(string[] args)
    {
        // `AddEnvironmentVariables` para o `PostgresConnectionString` ver as duas
        // variaveis aceitas com a mesma precedencia que a aplicacao usa.
        var configuracao = new ConfigurationBuilder()
            .AddEnvironmentVariables()
            .Build();

        var connectionString =
            PostgresConnectionString.Resolver(configuracao) ?? FallbackConnectionString;

        var options = new DbContextOptionsBuilder<SabemiDbContext>()
            .UseNpgsql(connectionString, npgsql =>
                npgsql.MigrationsHistoryTable("__EFMigrationsHistory", SabemiDbContext.Schema))
            .Options;

        return new SabemiDbContext(options);
    }
}
