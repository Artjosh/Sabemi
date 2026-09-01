using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;
using Shouldly;

namespace Sabemi.UnitTests.Domain;

/// <summary>
/// Regras da fila durable: contagem de tentativas, backoff e recuperacao de
/// itens orfaos.
/// </summary>
/// <remarks>
/// Esta e a logica que sustenta a promessa de nao perder trabalho. Testa-la sem
/// banco e sem esperar relogio e possivel porque o tempo entra como parametro -
/// razao pela qual a entidade recebe `agora` em vez de chamar
/// <c>DateTimeOffset.UtcNow</c> internamente.
/// </remarks>
public class ProcessingJobTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Base = TimeSpan.FromSeconds(5);

    private static ProcessingJob NovoJob(int maxTentativas = 3)
    {
        var evento = PaymentEvent.Accepted("TRX-1", "CTR-1", 10m, T0, "PAGO", "{}", false, T0);
        return ProcessingJob.For(evento, maxTentativas, T0);
    }

    [Fact]
    public void Job_nasce_pendente_e_imediatamente_disponivel()
    {
        var job = NovoJob();

        job.Estado.ShouldBe(JobState.Pendente);
        job.Tentativas.ShouldBe(0);
        job.DisponivelEm.ShouldBe(T0);
        job.ReivindicadoEm.ShouldBeNull();
    }

    [Fact]
    public void Claim_conta_a_tentativa_e_registra_quem_pegou()
    {
        var job = NovoJob();

        job.Claim("worker-a", T0);

        job.Estado.ShouldBe(JobState.Processando);
        // A tentativa e contada na reivindicacao, e nao no sucesso: um worker que
        // morre no meio precisa ter consumido a tentativa, senao um item que
        // derruba o processo seria retomado para sempre.
        job.Tentativas.ShouldBe(1);
        job.ReivindicadoPor.ShouldBe("worker-a");
        job.ReivindicadoEm.ShouldBe(T0);
    }

    [Fact]
    public void CanRetry_acompanha_o_limite_configurado()
    {
        var job = NovoJob(maxTentativas: 2);

        job.Claim("w", T0);
        job.CanRetry.ShouldBeTrue();   // 1 de 2

        job.Reschedule("erro", T0, Base);
        job.Claim("w", T0);
        job.CanRetry.ShouldBeFalse();  // 2 de 2 - acabou
    }

    [Theory]
    [InlineData(1, 5)]    // 5s * 2^0
    [InlineData(2, 10)]   // 5s * 2^1
    [InlineData(3, 20)]   // 5s * 2^2
    [InlineData(4, 40)]   // 5s * 2^3
    public void Reschedule_aplica_backoff_exponencial(int tentativas, int esperaEsperadaSegundos)
    {
        var job = NovoJob(maxTentativas: 10);
        for (var i = 0; i < tentativas; i++)
        {
            job.Claim("w", T0);
            if (i < tentativas - 1) job.Reschedule("erro", T0, Base);
        }

        job.Reschedule("erro", T0, Base);

        job.Estado.ShouldBe(JobState.Pendente);
        (job.DisponivelEm - T0).TotalSeconds.ShouldBe(esperaEsperadaSegundos);
        // O lease e liberado: outro worker pode pegar quando a espera terminar.
        job.ReivindicadoEm.ShouldBeNull();
        job.ReivindicadoPor.ShouldBeNull();
    }

    [Fact]
    public void Backoff_tem_teto_de_cinco_minutos()
    {
        // Sem teto, a 20a tentativa cairia daqui a semanas - o item ficaria
        // tecnicamente na fila e praticamente abandonado.
        var job = NovoJob(maxTentativas: 100);
        for (var i = 0; i < 20; i++)
        {
            job.Claim("w", T0);
            job.Reschedule("erro", T0, Base);
        }

        (job.DisponivelEm - T0).ShouldBeLessThanOrEqualTo(TimeSpan.FromMinutes(5));
    }

    [Fact]
    public void Fail_encerra_o_item_definitivamente()
    {
        var job = NovoJob();
        job.Claim("w", T0);

        job.Fail("erro fatal", T0);

        job.Estado.ShouldBe(JobState.Falhou);
        job.UltimoErro.ShouldBe("erro fatal");
    }

    [Fact]
    public void Complete_limpa_o_erro_da_tentativa_anterior()
    {
        var job = NovoJob();
        job.Claim("w", T0);
        job.Reschedule("falhou uma vez", T0, Base);
        job.Claim("w", T0);

        job.Complete(T0);

        job.Estado.ShouldBe(JobState.Concluido);
        job.UltimoErro.ShouldBeNull();
    }

    [Fact]
    public void Release_devolve_o_orfao_sem_gastar_tentativa()
    {
        var job = NovoJob();
        job.Claim("worker-que-morreu", T0);
        var tentativasAntes = job.Tentativas;

        job.Release(T0.AddMinutes(3));

        job.Estado.ShouldBe(JobState.Pendente);
        // A tentativa ja foi contada no Claim. Conta-la de novo aqui faria um
        // item perder o orcamento de tentativas por culpa de quedas do worker.
        job.Tentativas.ShouldBe(tentativasAntes);
        job.ReivindicadoPor.ShouldBeNull();
        job.UltimoErro.ShouldContain("lease");
    }
}
