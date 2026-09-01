using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;
using Shouldly;

namespace Sabemi.UnitTests.Domain;

/// <summary>
/// Regras de ciclo de vida do log de eventos brutos.
/// </summary>
/// <remarks>
/// Sao testes sem banco: exercitam a maquina de estados da entidade, que e onde
/// a distincao entre "vai tentar de novo" e "acabou em erro" e decidida. Errar
/// isso faz o dashboard mentir sobre o que ainda esta em andamento.
/// </remarks>
public class PaymentEventTests
{
    private static readonly DateTimeOffset Agora = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    private static PaymentEvent Valido() => PaymentEvent.Accepted(
        "TRX-1", "CTR-1", 100m, Agora.AddHours(-1), "PAGO", "{}", true, Agora);

    [Fact]
    public void Accepted_nasce_pendente_e_sem_erro()
    {
        var evento = Valido();

        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Pendente);
        evento.Erro.ShouldBeNull();
        evento.ProcessadoEm.ShouldBeNull();
        evento.Tentativas.ShouldBe(0);
        evento.AssinaturaVerificada.ShouldBeTrue();
    }

    [Fact]
    public void Rejected_nasce_invalido_e_ja_encerrado()
    {
        // Um evento invalido nunca sera processado, entao ja nasce com data de
        // desfecho: deixa-lo sem `processado_em` o faria parecer preso na fila.
        var evento = PaymentEvent.Rejected(
            "TRX-2", null, null, null, null, "{}", "valor obrigatorio", false, Agora);

        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Invalido);
        evento.Erro.ShouldBe("valor obrigatorio");
        evento.ProcessadoEm.ShouldBe(Agora);
    }

    [Fact]
    public void Rejected_preserva_o_que_deu_para_extrair_do_payload()
    {
        // O dashboard precisa de contexto mesmo quando o payload esta defeituoso.
        var evento = PaymentEvent.Rejected(
            "TRX-3", "CTR-9", 50m, Agora, "PAGO", """{"a":1}""", "status invalido", false, Agora);

        evento.IdContrato.ShouldBe("CTR-9");
        evento.Valor.ShouldBe(50m);
        evento.StatusOrigem.ShouldBe("PAGO");
        evento.PayloadBruto.ShouldBe("""{"a":1}""");
    }

    [Fact]
    public void MarkSucceeded_limpa_o_erro_de_uma_tentativa_anterior()
    {
        var evento = Valido();
        evento.MarkRetrying("timeout do gateway", 1);

        evento.MarkSucceeded(Agora);

        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Sucesso);
        // O erro precisa sumir: um evento que terminou bem exibindo a mensagem da
        // tentativa que falhou faria o operador investigar um problema resolvido.
        evento.Erro.ShouldBeNull();
        evento.ProcessadoEm.ShouldBe(Agora);
    }

    [Fact]
    public void MarkRetrying_devolve_o_evento_para_pendente()
    {
        var evento = Valido();
        evento.MarkProcessing(1);

        evento.MarkRetrying("falha transitoria", 1);

        // Volta a Pendente, e nao Erro: ainda ha tentativa pela frente, e marcar
        // erro agora acionaria alarme por algo que vai se resolver sozinho.
        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Pendente);
        evento.ProcessadoEm.ShouldBeNull();
        evento.Tentativas.ShouldBe(1);
    }

    [Fact]
    public void MarkFailed_encerra_em_erro_definitivo()
    {
        var evento = Valido();
        evento.MarkProcessing(3);

        evento.MarkFailed("estourou as tentativas", Agora);

        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Erro);
        evento.Erro.ShouldBe("estourou as tentativas");
        evento.ProcessadoEm.ShouldBe(Agora);
    }

    [Fact]
    public void Mensagem_de_erro_gigante_e_truncada()
    {
        // A coluna e limitada; uma stack trace inteira estouraria o insert e
        // transformaria uma falha de negocio numa falha de persistencia.
        var evento = Valido();

        evento.MarkFailed(new string('x', 5000), Agora);

        evento.Erro!.Length.ShouldBe(2000);
    }
}
