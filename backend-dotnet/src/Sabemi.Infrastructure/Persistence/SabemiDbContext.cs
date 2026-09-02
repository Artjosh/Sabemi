using Microsoft.EntityFrameworkCore;
using Sabemi.Application.Abstractions;
using Sabemi.Domain.Entities;

namespace Sabemi.Infrastructure.Persistence;

/// <summary>
/// Contexto EF Core do backend .NET.
/// </summary>
/// <remarks>
/// <para><b>Um schema para os DOIS backends.</b> Tudo vive em <c>sabemi</c>, e
/// o backend VINEXT le e escreve nas MESMAS tabelas. E o que permite trocar de
/// backend sem perder os dados nem refazer o login: os dois enxergam os mesmos
/// pagamentos e os mesmos usuarios.</para>
///
/// <para><b>Quem e dono das migrations.</b> O EF Core, sozinho. O Prisma
/// descreve o mesmo modelo mas nao migra - se os dois migrassem, cada um veria
/// as tabelas do outro como deriva a corrigir e tentaria destrui-las. A
/// divergencia entre os dois modelos e detectada no CI por
/// <c>prisma migrate diff</c>, entao ela nao pode passar despercebida.</para>
///
/// <para><b>Sobre ORM.</b> A especificacao sugeria Prisma. Prisma nao gera
/// cliente para .NET - integra-lo exigiria um processo Node so para acessar o
/// banco a partir do C#, acrescentando um salto de rede e um ponto de falha para
/// nao ganhar nada. O requisito real e demonstrar ORM com migrations, e no .NET
/// isso e EF Core. Prisma nao foi descartado: ele e o ORM do backend VINEXT,
/// onde e a escolha natural. Cada lado usa a ferramenta da sua plataforma.</para>
/// </remarks>
public sealed class SabemiDbContext(DbContextOptions<SabemiDbContext> options)
    : DbContext(options), IAppDbContext
{
    public const string Schema = "sabemi";

    public DbSet<PaymentEvent> PaymentEvents => Set<PaymentEvent>();
    public DbSet<ContractStatus> ContractStatuses => Set<ContractStatus>();
    public DbSet<ProcessingJob> ProcessingJobs => Set<ProcessingJob>();
    public DbSet<LoginRequest> LoginRequests => Set<LoginRequest>();
    public DbSet<AppUser> Users => Set<AppUser>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema(Schema);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(SabemiDbContext).Assembly);
    }

    /// <summary>
    /// Executa o trabalho em uma transacao, sob a estrategia de retentativa do
    /// provider.
    /// </summary>
    /// <remarks>
    /// <para>A estrategia (<c>EnableRetryOnFailure</c>) pode reexecutar o
    /// delegate inteiro se o PostgreSQL derrubar a conexao no meio - o que
    /// acontece de verdade num failover ou num reinicio. Cada tentativa abre uma
    /// transacao nova; a anterior ja foi desfeita pelo banco.</para>
    ///
    /// <para>Provider nao relacional (o InMemory dos testes de unidade) nao tem
    /// transacoes nem estrategia: o delegate roda direto. Isso mantem um unico
    /// caminho de codigo nos servicos, em vez de espalhar condicoes sobre qual
    /// provider esta ativo.</para>
    /// </remarks>
    public async Task ExecuteInTransactionAsync(
        Func<CancellationToken, Task> operation,
        CancellationToken cancellationToken = default)
    {
        if (!Database.IsRelational())
        {
            await operation(cancellationToken);
            return;
        }

        // Ja existe uma transacao ambiente (caso de teste que envolve varias
        // chamadas): participa dela em vez de abrir outra aninhada.
        if (Database.CurrentTransaction is not null)
        {
            await operation(cancellationToken);
            return;
        }

        var strategy = Database.CreateExecutionStrategy();

        await strategy.ExecuteAsync(async ct =>
        {
            await using var tx = await Database.BeginTransactionAsync(ct);
            await operation(ct);
            await tx.CommitAsync(ct);
        }, cancellationToken);
    }

    /// <summary>
    /// Limpa o rastreamento para que a proxima tentativa releia do banco.
    /// </summary>
    /// <remarks>
    /// Sem isto, uma reexecucao do delegate aplicaria a mesma mutacao sobre uma
    /// entidade que ja a sofreu em memoria - somando um pagamento duas vezes no
    /// total do contrato, ainda que a transacao anterior tenha sido desfeita no
    /// banco.
    /// </remarks>
    public void ResetTrackedState() => ChangeTracker.Clear();
}
