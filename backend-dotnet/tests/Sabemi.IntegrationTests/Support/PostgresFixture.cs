using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sabemi.Application.Abstractions;
using Sabemi.Infrastructure.Persistence;
using Testcontainers.PostgreSql;

namespace Sabemi.IntegrationTests.Support;

/// <summary>
/// PostgreSQL real, em container, compartilhado pela suite de integracao.
/// </summary>
/// <remarks>
/// <b>Por que um banco de verdade e nao o provider InMemory.</b> Boa parte do
/// que este projeto precisa provar simplesmente NAO EXISTE no InMemory:
///
///   * indices unicos - e sem eles a idempotencia nao pode ser exercitada, ja
///     que ela e uma restricao do banco e nao uma verificacao em codigo;
///   * <c>FOR UPDATE SKIP LOCKED</c> - o mecanismo da fila;
///   * transacoes de verdade, tipo <c>jsonb</c>, concorrencia por <c>xmin</c>.
///
/// Um teste de idempotencia no InMemory passaria sempre, inclusive com a
/// implementacao quebrada. Seria pior do que nao ter teste: daria confianca
/// falsa exatamente no requisito mais importante da task.
///
/// O container sobe uma vez por execucao (<c>ICollectionFixture</c>) e cada
/// teste limpa as tabelas que usa - ver <see cref="ResetAsync"/>.
/// </remarks>
public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("postgres:17-alpine")
        .WithDatabase("sabemi_test")
        .WithUsername("sabemi")
        .WithPassword("sabemi")
        // O banco de teste e descartavel: sincronizacao com o disco so
        // acrescentaria latencia a cada insert da suite.
        .WithCommand("-c", "fsync=off", "-c", "full_page_writes=off", "-c", "synchronous_commit=off")
        .Build();

    public string ConnectionString => _container.GetConnectionString();

    public async Task InitializeAsync()
    {
        await _container.StartAsync();

        // As migrations sao aplicadas pelas MESMAS migrations do runtime. Assim a
        // suite valida tambem que elas produzem o schema que o codigo espera - um
        // teste que criasse as tabelas por conta propria deixaria de perceber uma
        // migration quebrada.
        await using var db = CreateDbContext();
        await db.Database.MigrateAsync();
    }

    public async Task DisposeAsync() => await _container.DisposeAsync();

    public SabemiDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<SabemiDbContext>()
            .UseNpgsql(ConnectionString, npgsql =>
                npgsql.MigrationsHistoryTable("__EFMigrationsHistory", SabemiDbContext.Schema))
            .Options;

        return new SabemiDbContext(options);
    }

    /// <summary>
    /// Esvazia as tabelas entre os testes.
    /// </summary>
    /// <remarks>
    /// <c>TRUNCATE ... CASCADE</c> em vez de recriar o schema: e ordens de
    /// grandeza mais rapido e mantem os testes independentes uns dos outros, sem
    /// depender da ordem de execucao.
    /// </remarks>
    public async Task ResetAsync()
    {
        // O schema vem de `SabemiDbContext.Schema` em vez de literal: quando ele
        // mudou de `dotnet` para `sabemi`, este SQL foi um dos poucos pontos que
        // o compilador nao pegou - e a suite inteira quebrou de uma vez.
        var schema = SabemiDbContext.Schema;

        await using var db = CreateDbContext();

        // EF1002 avisa sobre SQL interpolado, e esta certo em geral: interpolar
        // entrada de usuario e injecao. Aqui o unico valor interpolado e
        // `SabemiDbContext.Schema`, uma constante do proprio codigo - nao ha
        // origem externa. Parametrizar nao e opcao: nome de schema nao pode ser
        // parametro de bind.
#pragma warning disable EF1002
        await db.Database.ExecuteSqlRawAsync(
            $"""
            TRUNCATE TABLE {schema}.processing_jobs,
                           {schema}.payment_events,
                           {schema}.contract_statuses,
                           {schema}.login_requests,
                           {schema}.users
            RESTART IDENTITY CASCADE
            """);
#pragma warning restore EF1002
    }
}

[CollectionDefinition(Name)]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>
{
    public const string Name = "postgres";
}

/// <summary>
/// Sobe a API real apontando para o PostgreSQL do container.
/// </summary>
/// <remarks>
/// Exercita a aplicacao pela borda HTTP: roteamento, model binding,
/// autenticacao, middleware de erro e serializacao entram no teste. Chamar os
/// servicos diretamente pularia justamente a camada onde moram os defeitos de
/// integracao - um status code errado, um header nao lido, um JSON com o nome
/// de campo trocado.
/// </remarks>
public class SabemiApiFactory(PostgresFixture postgres) : WebApplicationFactory<Program>
{
    public const string ApiKey = "chave-de-teste";
    public const string SignatureSecret = "segredo-de-teste";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");

        builder.UseSetting("ConnectionStrings:Postgres", postgres.ConnectionString);

        // A fixture ja aplicou as migrations; migrar de novo a cada host so
        // acrescentaria tempo.
        builder.UseSetting("Database:MigrateOnStartup", "false");

        builder.UseSetting("Jwt:Secret", "segredo-de-teste-com-mais-de-32-caracteres-aqui");
        builder.UseSetting("WebhookSecurity:ApiKey", ApiKey);
        builder.UseSetting("WebhookSecurity:SignatureSecret", SignatureSecret);

        // Assinatura opcional por padrao: a maioria dos testes exercita outra
        // coisa. Os testes de assinatura enviam o header explicitamente.
        builder.UseSetting("WebhookSecurity:RequireSignature", "false");

        // A regra "pesada" fica instantanea: o que se verifica e o fluxo, nao a
        // capacidade do Task.Delay de esperar. O teste que cobre a resposta rapida
        // do webhook restaura uma duracao real.
        builder.UseSetting("Processing:SimulatedWorkDuration", "00:00:00");
        builder.UseSetting("Processing:BaseRetryDelay", "00:00:00");

        builder.UseSetting("Auth:ExposeLoginCodesInDevelopment", "true");
    }

    /// <summary>Cria um escopo com os serviços da aplicacao, para arranjo e verificacao.</summary>
    public IServiceScope CreateServiceScope() => Services.CreateScope();

    public SabemiDbContext Db(IServiceScope scope) => scope.ServiceProvider.GetRequiredService<SabemiDbContext>();

    public T Service<T>(IServiceScope scope) where T : notnull =>
        scope.ServiceProvider.GetRequiredService<T>();
}

/// <summary>Relogio controlado, para exercitar expiracao sem esperar de verdade.</summary>
public sealed class FakeClock(DateTimeOffset inicio) : IClock
{
    public DateTimeOffset UtcNow { get; private set; } = inicio;

    public void Advance(TimeSpan quanto) => UtcNow = UtcNow.Add(quanto);
}
