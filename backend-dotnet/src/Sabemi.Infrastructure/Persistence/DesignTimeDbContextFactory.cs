using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

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
/// aberta ao criar uma migration. Ela pode ser sobrescrita por
/// <c>ConnectionStrings__Postgres</c> quando o comando de fato precisa falar com
/// o banco (<c>database update</c>, <c>dbcontext script</c>).</para>
/// </remarks>
// Fora da metrica de cobertura: este tipo so e instanciado pelas ferramentas
// de linha de comando do EF Core, nunca pela aplicacao em execucao. Cobri-lo
// exigiria um teste que invoca o `dotnet ef`, o que mede a ferramenta e nao o
// nosso codigo. Os testes de integracao ja validam o schema que ele produz.
[ExcludeFromCodeCoverage]
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<SabemiDbContext>
{
    private const string FallbackConnectionString =
        "Host=localhost;Port=5432;Database=sabemi;Username=sabemi;Password=sabemi";

    public SabemiDbContext CreateDbContext(string[] args)
    {
        var connectionString =
            Environment.GetEnvironmentVariable("ConnectionStrings__Postgres")
            ?? FallbackConnectionString;

        var options = new DbContextOptionsBuilder<SabemiDbContext>()
            .UseNpgsql(connectionString, npgsql =>
                npgsql.MigrationsHistoryTable("__EFMigrationsHistory", SabemiDbContext.Schema))
            .Options;

        return new SabemiDbContext(options);
    }
}
