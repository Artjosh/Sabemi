using Sabemi.Domain.Enums;

namespace Sabemi.Domain.Entities;

/// <summary>
/// Item da fila durable de processamento (padrao transactional outbox).
/// </summary>
/// <remarks>
/// A task pede que a regra pesada (~2s) nao bloqueie o webhook, e que o
/// mecanismo de background nao possa perder trabalho em silencio.
/// <c>Task.Run</c>, <c>IHostedService</c> com fila em memoria ou
/// <c>BackgroundTaskQueue</c> falham no segundo requisito: se o processo cair
/// entre o "202 Accepted" e o fim do processamento, o trabalho desaparece e
/// ninguem fica sabendo.
///
/// Aqui a fila e uma tabela. O evento bruto e o job sao gravados na MESMA
/// transacao do webhook, entao ou os dois existem ou nenhum existe. Um processo
/// separado (<c>Sabemi.Worker</c>) reivindica itens com
/// <c>FOR UPDATE SKIP LOCKED</c>, o que permite varias replicas consumindo a
/// mesma fila sem entregar o mesmo item duas vezes.
///
/// Um worker morto no meio do trabalho tambem esta coberto: o item fica
/// <see cref="JobState.Processando"/> com <see cref="ReivindicadoEm"/> antigo, e
/// o varredor de itens travados (<c>VisibilityTimeout</c>) o devolve a fila.
/// </remarks>
public class ProcessingJob
{
    public Guid Id { get; private set; } = Guid.CreateVersion7();

    public Guid PaymentEventId { get; private set; }

    public PaymentEvent? PaymentEvent { get; private set; }

    public JobState Estado { get; private set; } = JobState.Pendente;

    public int Tentativas { get; private set; }

    public int MaxTentativas { get; private set; } = 3;

    /// <summary>
    /// Momento a partir do qual o item pode ser reivindicado. E o que implementa
    /// o backoff exponencial: uma falha transitoria empurra esta data para
    /// frente em vez de gerar uma nova tentativa imediata.
    /// </summary>
    public DateTimeOffset DisponivelEm { get; private set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset? ReivindicadoEm { get; private set; }

    /// <summary>Identidade da replica que reivindicou - util no diagnostico.</summary>
    public string? ReivindicadoPor { get; private set; }

    public string? UltimoErro { get; private set; }

    public DateTimeOffset CriadoEm { get; private set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset AtualizadoEm { get; private set; } = DateTimeOffset.UtcNow;

    private ProcessingJob() { }

    public static ProcessingJob For(PaymentEvent evento, int maxTentativas, DateTimeOffset agora)
        => new()
        {
            PaymentEventId = evento.Id,
            PaymentEvent = evento,
            MaxTentativas = maxTentativas,
            DisponivelEm = agora,
            CriadoEm = agora,
            AtualizadoEm = agora
        };

    /// <summary>Marca o item como reivindicado por um worker.</summary>
    public void Claim(string workerId, DateTimeOffset agora)
    {
        Estado = JobState.Processando;
        Tentativas += 1;
        ReivindicadoEm = agora;
        ReivindicadoPor = workerId;
        AtualizadoEm = agora;
    }

    public void Complete(DateTimeOffset agora)
    {
        Estado = JobState.Concluido;
        UltimoErro = null;
        AtualizadoEm = agora;
    }

    /// <summary>Ainda restam tentativas depois da atual?</summary>
    public bool CanRetry => Tentativas < MaxTentativas;

    /// <summary>
    /// Devolve o item a fila com backoff exponencial (base 2, teto de 5 min),
    /// para uma dependencia instavel nao ser martelada.
    /// </summary>
    public void Reschedule(string erro, DateTimeOffset agora, TimeSpan baseDelay)
    {
        var fator = Math.Pow(2, Math.Max(0, Tentativas - 1));
        var espera = TimeSpan.FromMilliseconds(Math.Min(baseDelay.TotalMilliseconds * fator, TimeSpan.FromMinutes(5).TotalMilliseconds));

        Estado = JobState.Pendente;
        UltimoErro = Truncate(erro, 2000);
        DisponivelEm = agora.Add(espera);
        ReivindicadoEm = null;
        ReivindicadoPor = null;
        AtualizadoEm = agora;
    }

    /// <summary>Encerra o item em falha definitiva (dead letter logica).</summary>
    public void Fail(string erro, DateTimeOffset agora)
    {
        Estado = JobState.Falhou;
        UltimoErro = Truncate(erro, 2000);
        AtualizadoEm = agora;
    }

    /// <summary>
    /// Devolve o item a fila por decisao de uma pessoa, depois de uma falha
    /// definitiva.
    /// </summary>
    /// <remarks>
    /// <b>Por que zerar as tentativas.</b> Um item que falhou esgotou o
    /// orcamento de tentativas. Reenfileirar sem zerar devolveria um item que
    /// falha na primeira tentativa e volta a morrer - o botao pareceria nao
    /// funcionar. Quem clica esta afirmando que a causa foi tratada (o contrato
    /// que faltava foi cadastrado, a dependencia voltou), e isso e um novo
    /// orcamento.
    ///
    /// <b>Por que <c>DisponivelEm</c> agora, sem backoff.</b> O backoff protege
    /// uma dependencia instavel de ser martelada por um laco automatico. Aqui
    /// nao ha laco: houve um clique, e a pessoa esta esperando o resultado.
    ///
    /// <b>O que NAO e limpo.</b> <see cref="UltimoErro"/> permanece ate o proximo
    /// desfecho. Se a nova tentativa falhar de outra forma, o campo e
    /// sobrescrito; se passar, o <see cref="Complete"/> o limpa. Apaga-lo aqui
    /// destruiria o unico registro do que havia acontecido, justo enquanto
    /// alguem investiga.
    /// </remarks>
    public void Requeue(DateTimeOffset agora)
    {
        Estado = JobState.Pendente;
        Tentativas = 0;
        DisponivelEm = agora;
        ReivindicadoEm = null;
        ReivindicadoPor = null;
        AtualizadoEm = agora;
    }

    /// <summary>
    /// Devolve a fila um item cujo worker morreu sem concluir (o
    /// <c>VisibilityTimeout</c> expirou). Nao consome uma nova tentativa aqui:
    /// a tentativa ja foi contada no <see cref="Claim"/>.
    /// </summary>
    public void Release(DateTimeOffset agora)
    {
        Estado = JobState.Pendente;
        DisponivelEm = agora;
        ReivindicadoEm = null;
        ReivindicadoPor = null;
        UltimoErro = "Worker perdeu o lease (visibility timeout expirado).";
        AtualizadoEm = agora;
    }

    private static string Truncate(string value, int max)
        => value.Length <= max ? value : value[..max];
}
