using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;
using Sabemi.Application.Abstractions;
using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;

namespace Sabemi.Infrastructure.Queue;

/// <summary>
/// Fila durable sobre a tabela <c>processing_jobs</c>, com reivindicacao
/// concorrente via <c>FOR UPDATE SKIP LOCKED</c>.
/// </summary>
/// <remarks>
/// <para><b>Por que o banco e nao um broker.</b> Um RabbitMQ ou Redis resolveria
/// a fila, mas traria de volta o problema que se quer evitar: a mensagem e o
/// evento passariam a viver em sistemas diferentes, sem transacao comum, e a
/// falha entre gravar um e publicar o outro seria justamente o trabalho perdido
/// em silencio. Com a fila no mesmo banco, evento e job entram na mesma
/// transacao - a atomicidade e de graca. Em troca abre-se mao de vazao muito
/// alta, que nao e o problema aqui.</para>
///
/// <para><b>Como o SKIP LOCKED funciona.</b> Cada worker abre uma transacao,
/// seleciona as proximas N linhas pendentes com <c>FOR UPDATE SKIP LOCKED</c> e
/// as marca como <c>Processando</c>. As linhas travadas por outro worker sao
/// puladas em vez de esperadas. Dez replicas concorrem sem bloquear umas as
/// outras e sem que duas peguem a mesma linha.</para>
///
/// <para>A reivindicacao usa um unico <c>UPDATE ... FROM (SELECT ... FOR UPDATE
/// SKIP LOCKED) RETURNING</c>: selecionar e depois atualizar em comandos
/// separados abriria uma janela entre a leitura e a escrita.</para>
/// </remarks>
public sealed class PostgresJobQueue(
    Persistence.SabemiDbContext db,
    IClock clock,
    ILogger<PostgresJobQueue> logger) : IJobQueue
{
    public async Task<IReadOnlyList<ProcessingJob>> ClaimAsync(
        string workerId, int batchSize, CancellationToken cancellationToken = default)
    {
        var agora = clock.UtcNow;

        // Um comando so: seleciona-e-marca. O SELECT interno segura as travas ate
        // o fim do statement, entao nenhuma outra replica ve estas linhas como
        // pendentes.
        const string sql = """
            UPDATE dotnet.processing_jobs AS j
               SET estado            = 'Processando',
                   tentativas        = j.tentativas + 1,
                   reivindicado_em   = {0},
                   reivindicado_por  = {1},
                   atualizado_em     = {0}
              FROM (
                    SELECT id
                      FROM dotnet.processing_jobs
                     WHERE estado = 'Pendente'
                       AND disponivel_em <= {0}
                     ORDER BY disponivel_em, criado_em
                     LIMIT {2}
                       FOR UPDATE SKIP LOCKED
                   ) AS candidatos
             WHERE j.id = candidatos.id
            RETURNING j.id
            """;

        var ids = await db.Database
            .SqlQueryRaw<Guid>(sql, agora, workerId, batchSize)
            .ToListAsync(cancellationToken);

        if (ids.Count == 0)
        {
            return [];
        }

        // Recarrega as entidades rastreadas (com o evento junto) para o servico
        // de aplicacao trabalhar com objetos de dominio, e nao com linhas cruas.
        var jobs = await db.ProcessingJobs
            .Include(j => j.PaymentEvent)
            .Where(j => ids.Contains(j.Id))
            .ToListAsync(cancellationToken);

        logger.LogDebug("Worker {WorkerId} reivindicou {Count} job(s).", workerId, jobs.Count);
        return jobs;
    }

    /// <summary>
    /// Devolve a fila os itens presos em <c>Processando</c> alem do visibility
    /// timeout - tipicamente porque o worker que os reivindicou morreu.
    /// </summary>
    /// <remarks>
    /// Sem esta varredura, um <c>kill -9</c> no meio de um item o deixaria
    /// travado para sempre: nenhum worker o reivindicaria de novo (ja nao esta
    /// pendente) e ninguem o concluiria (quem o segurava morreu). E este metodo
    /// que faz "at-least-once" ser verdade e nao so intencao.
    /// </remarks>
    public async Task<int> ReleaseStaleAsync(TimeSpan visibilityTimeout, CancellationToken cancellationToken = default)
    {
        var limite = clock.UtcNow - visibilityTimeout;

        return await db.ProcessingJobs
            .Where(j => j.Estado == JobState.Processando
                        && j.ReivindicadoEm != null
                        && j.ReivindicadoEm < limite)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Estado, JobState.Pendente)
                .SetProperty(j => j.DisponivelEm, clock.UtcNow)
                .SetProperty(j => j.ReivindicadoEm, (DateTimeOffset?)null)
                .SetProperty(j => j.ReivindicadoPor, (string?)null)
                .SetProperty(j => j.UltimoErro, "Worker perdeu o lease (visibility timeout expirado).")
                .SetProperty(j => j.AtualizadoEm, clock.UtcNow),
                cancellationToken);
    }
}

/// <summary>
/// Reconhece a violacao de indice unico do PostgreSQL (SQLSTATE 23505).
/// </summary>
/// <remarks>
/// E o que permite a ingestao tratar duplicidade como um desfecho normal em vez
/// de um erro. Fica aqui, e nao na camada de aplicacao, porque o codigo de erro
/// e especifico do provider - trocar de banco troca esta classe e mais nada.
/// </remarks>
public sealed class NpgsqlDuplicateKeyDetector : IDuplicateKeyDetector
{
    private const string UniqueViolation = "23505";

    public bool IsDuplicateKey(Exception exception)
    {
        for (var e = exception; e is not null; e = e.InnerException)
        {
            if (e is PostgresException pg && pg.SqlState == UniqueViolation)
            {
                return true;
            }
        }
        return false;
    }
}
