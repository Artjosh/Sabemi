using Microsoft.EntityFrameworkCore;
using Sabemi.Domain.Entities;

namespace Sabemi.Application.Abstractions;

/// <summary>
/// Superficie de persistencia vista pela camada de aplicacao.
/// </summary>
/// <remarks>
/// Expor <see cref="DbSet{T}"/> em vez de um repositorio por agregado e uma
/// escolha consciente. A alternativa - <c>IPaymentEventRepository</c>,
/// <c>IContractRepository</c>, <c>ISpecification</c> e afins - triplicaria o
/// codigo para reimplementar, pior, o que o LINQ do EF Core ja faz. O que
/// realmente precisa ficar escondido e o que e especifico do PostgreSQL
/// (<c>SKIP LOCKED</c>, codigo de erro de unicidade); isso mora em
/// <see cref="IJobQueue"/> e <see cref="IDuplicateKeyDetector"/>, nao aqui.
/// </remarks>
public interface IAppDbContext
{
    DbSet<PaymentEvent> PaymentEvents { get; }
    DbSet<ContractStatus> ContractStatuses { get; }
    DbSet<ProcessingJob> ProcessingJobs { get; }
    DbSet<LoginRequest> LoginRequests { get; }
    DbSet<AppUser> Users { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Executa <paramref name="operation"/> dentro de uma transacao, sob a
    /// estrategia de resiliencia do provider.
    /// </summary>
    /// <remarks>
    /// <para>Usada onde a atomicidade e requisito e nao conveniencia: gravar
    /// evento + job na ingestao, e concluir job + atualizar contrato no worker.</para>
    ///
    /// <para><b>Por que um delegate e nao Begin/Commit.</b> Com
    /// <c>EnableRetryOnFailure</c> ligado, o EF Core recusa transacoes abertas
    /// manualmente: numa falha transitoria ele precisa reexecutar a transacao
    /// inteira, e nao tem como refazer o que aconteceu entre um <c>Begin</c> e um
    /// <c>Commit</c> espalhados pelo codigo. Entregando o trabalho como delegate,
    /// a estrategia pode reexecuta-lo como unidade.</para>
    ///
    /// <para><b>Consequencia para quem escreve o delegate:</b> ele pode rodar mais
    /// de uma vez. Portanto nao pode depender de estado ja modificado em memoria -
    /// mutar uma entidade rastreada duas vezes somaria o efeito duas vezes. Use
    /// <see cref="ResetTrackedState"/> no inicio e releia o que for alterar.</para>
    /// </remarks>
    Task ExecuteInTransactionAsync(
        Func<CancellationToken, Task> operation,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Descarta tudo o que o contexto rastreia, para uma nova tentativa comecar
    /// do estado que esta no banco.
    /// </summary>
    void ResetTrackedState();
}

/// <summary>
/// Traduz erros do provider para uma pergunta que a aplicacao sabe fazer.
/// </summary>
/// <remarks>
/// A idempotencia depende de detectar violacao de indice unico. Isso e um codigo
/// de erro do PostgreSQL (23505) dentro de uma <c>DbUpdateException</c>. Sem
/// esta abstracao, a camada de aplicacao precisaria referenciar Npgsql - e os
/// testes precisariam de um PostgreSQL de verdade so para exercitar o caminho
/// do duplicado.
/// </remarks>
public interface IDuplicateKeyDetector
{
    bool IsDuplicateKey(Exception exception);
}

/// <summary>
/// Fila durable de processamento, apoiada em tabela.
/// </summary>
/// <remarks>
/// A reivindicacao usa <c>SELECT ... FOR UPDATE SKIP LOCKED</c>, o que permite N
/// replicas do worker consumindo a mesma fila sem que duas peguem o mesmo item e
/// sem que uma trave a outra. Nao ha broker aqui de proposito: o banco ja e
/// transacional e ja esta no diagrama, e gravar o evento e o job na mesma
/// transacao e exatamente o que impede o trabalho de sumir.
/// </remarks>
public interface IJobQueue
{
    /// <summary>
    /// Reivindica ate <paramref name="batchSize"/> itens disponiveis, marcando-os
    /// como <c>Processando</c>. Devolve lista vazia quando a fila esta vazia.
    /// </summary>
    Task<IReadOnlyList<ProcessingJob>> ClaimAsync(string workerId, int batchSize, CancellationToken cancellationToken = default);

    /// <summary>
    /// Devolve a fila os itens presos em <c>Processando</c> por mais tempo que o
    /// visibility timeout - o caso do worker que morreu no meio do trabalho.
    /// </summary>
    Task<int> ReleaseStaleAsync(TimeSpan visibilityTimeout, CancellationToken cancellationToken = default);
}

/// <summary>
/// Relogio injetavel.
/// </summary>
/// <remarks>
/// Existe para os testes: expiracao de pedido de login, backoff e visibility
/// timeout sao todos regras baseadas em tempo. Sem isto, exercita-las exigiria
/// <c>Thread.Sleep</c> na suite.
/// </remarks>
public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

/// <summary>Relogio real. Substituido por um relogio controlado nos testes.</summary>
public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

/// <summary>Emissao do JWT de sessao do painel.</summary>
public interface ITokenIssuer
{
    /// <summary>Emite o token da sessao e informa sua validade em segundos.</summary>
    (string Token, int ExpiresInSeconds) Issue(AppUser user);
}

/// <summary>
/// Entrega do link/codigo de acesso.
/// </summary>
/// <remarks>
/// Abstraido porque o teste tecnico nao deve exigir um servidor SMTP para rodar.
/// A implementacao padrao apenas registra em log; trocar por SMTP ou por um
/// provedor transacional e implementar esta interface.
/// </remarks>
public interface ILoginNotificationSender
{
    Task<bool> SendAsync(string email, string magicUrl, string otpCode, CancellationToken cancellationToken = default);
}

/// <summary>Regra de negocio pesada aplicada a um evento aceito.</summary>
public interface IPaymentBusinessRule
{
    Task ExecuteAsync(PaymentEvent evento, CancellationToken cancellationToken = default);
}
