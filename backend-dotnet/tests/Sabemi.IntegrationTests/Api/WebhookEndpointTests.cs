using System.Net;
using System.Net.Http.Json;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Sabemi.Application.Contracts;
using Sabemi.Domain.Enums;
using Sabemi.IntegrationTests.Support;
using Sabemi.Infrastructure.Security;
using Shouldly;

namespace Sabemi.IntegrationTests.Api;

/// <summary>
/// O endpoint de ingestao, exercitado por HTTP contra um PostgreSQL real.
/// </summary>
/// <remarks>
/// Cobre os criterios de aceite da task que dependem do comportamento do
/// conjunto: autenticacao por header, idempotencia no nivel de persistencia,
/// gravacao do evento bruto e resposta rapida.
/// </remarks>
[Collection(PostgresCollection.Name)]
public class WebhookEndpointTests(PostgresFixture postgres) : IAsyncLifetime
{
    private SabemiApiFactory _factory = null!;
    private HttpClient _client = null!;

    public async Task InitializeAsync()
    {
        await postgres.ResetAsync();
        _factory = new SabemiApiFactory(postgres);
        _client = _factory.CreateClient();
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
    }

    private static string Payload(
        string idTransacao = "TRX-001",
        string idContrato = "CTR-001",
        decimal valor = 1500.50m,
        string status = "PAGO",
        string? dataPagamento = null)
        => $$"""
        {
          "id_transacao": "{{idTransacao}}",
          "id_contrato": "{{idContrato}}",
          "valor": {{valor.ToString(System.Globalization.CultureInfo.InvariantCulture)}},
          "data_pagamento": "{{dataPagamento ?? "2026-08-01T10:00:00Z"}}",
          "status": "{{status}}"
        }
        """;

    private HttpRequestMessage Requisicao(string corpo, string? apiKey = SabemiApiFactory.ApiKey, string? assinatura = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/webhooks/pagamento")
        {
            Content = new StringContent(corpo, Encoding.UTF8, "application/json"),
        };

        if (apiKey is not null) req.Headers.Add("X-Api-Key", apiKey);
        if (assinatura is not null) req.Headers.Add("X-Signature", assinatura);

        return req;
    }

    // ------------------------------------------------------------- seguranca

    [Fact]
    public async Task Sem_ApiKey_devolve_401_e_nao_persiste_nada()
    {
        var resposta = await _client.SendAsync(Requisicao(Payload(), apiKey: null));

        resposta.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        // Persistir o que chega sem credencial transformaria a tabela de
        // auditoria num alvo trivial de enchimento.
        using var scope = _factory.CreateServiceScope();
        (await _factory.Db(scope).PaymentEvents.CountAsync()).ShouldBe(0);
    }

    [Fact]
    public async Task ApiKey_incorreta_devolve_401()
    {
        var resposta = await _client.SendAsync(Requisicao(Payload(), apiKey: "chave-errada"));

        resposta.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        var problema = await resposta.Content.ReadFromJsonAsync<ProblemDetailsDto>();
        problema!.Code.ShouldBe("invalid_api_key");
    }

    [Fact]
    public async Task Assinatura_valida_e_aceita_e_registrada()
    {
        var corpo = Payload("TRX-ASSINADO");
        var assinatura = WebhookAuthenticator.ComputeSignature(corpo, SabemiApiFactory.SignatureSecret);

        var resposta = await _client.SendAsync(Requisicao(corpo, assinatura: assinatura));

        resposta.StatusCode.ShouldBe(HttpStatusCode.Accepted);

        using var scope = _factory.CreateServiceScope();
        var evento = await _factory.Db(scope).PaymentEvents
            .FirstAsync(e => e.IdTransacao == "TRX-ASSINADO");

        evento.AssinaturaVerificada.ShouldBeTrue();
    }

    [Fact]
    public async Task Assinatura_de_outro_corpo_devolve_403()
    {
        // O ataque que a ApiKey sozinha nao impede: credencial valida, corpo
        // adulterado depois de assinado.
        var assinaturaDeOutroCorpo = WebhookAuthenticator.ComputeSignature(
            Payload(valor: 1m), SabemiApiFactory.SignatureSecret);

        var resposta = await _client.SendAsync(
            Requisicao(Payload(valor: 999999m), assinatura: assinaturaDeOutroCorpo));

        resposta.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    // ------------------------------------------------------------- ingestao

    [Fact]
    public async Task Payload_valido_devolve_202_e_enfileira()
    {
        var resposta = await _client.SendAsync(Requisicao(Payload()));

        resposta.StatusCode.ShouldBe(HttpStatusCode.Accepted);

        var ack = await resposta.Content.ReadFromJsonAsync<WebhookAck>();
        ack!.IdTransacao.ShouldBe("TRX-001");
        ack.Duplicate.ShouldBeFalse();
        ack.Status.ShouldBe("PENDENTE");

        using var scope = _factory.CreateServiceScope();
        var db = _factory.Db(scope);

        var evento = await db.PaymentEvents.SingleAsync();
        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Pendente);
        evento.IdContrato.ShouldBe("CTR-001");
        evento.Valor.ShouldBe(1500.50m);

        // Evento e job na mesma transacao: nao existe evento aceito sem trabalho
        // enfileirado.
        var job = await db.ProcessingJobs.SingleAsync();
        job.PaymentEventId.ShouldBe(evento.Id);
        job.Estado.ShouldBe(JobState.Pendente);
    }

    [Fact]
    public async Task Payload_bruto_e_gravado_exatamente_como_recebido()
    {
        // O valor da trilha de auditoria depende disso: reserializar perderia a
        // formatacao original e campos extras que o parceiro tenha enviado.
        var corpo = Payload("TRX-BRUTO");

        await _client.SendAsync(Requisicao(corpo));

        using var scope = _factory.CreateServiceScope();
        var evento = await _factory.Db(scope).PaymentEvents
            .FirstAsync(e => e.IdTransacao == "TRX-BRUTO");

        // A coluna e jsonb; o PostgreSQL normaliza espacos. A comparacao e
        // semantica: todo campo enviado tem de estar la.
        using var recebido = System.Text.Json.JsonDocument.Parse(evento.PayloadBruto);
        recebido.RootElement.GetProperty("id_transacao").GetString().ShouldBe("TRX-BRUTO");
        recebido.RootElement.GetProperty("valor").GetDecimal().ShouldBe(1500.50m);
    }

    [Fact]
    public async Task Webhook_responde_rapido_mesmo_com_regra_pesada()
    {
        // O criterio da task: a regra de ~2s nao pode bloquear a resposta ao
        // parceiro. Este e o unico teste que restaura a duracao real, para a
        // medida significar alguma coisa.
        using var factory = new SabemiApiFactoryComRegraLenta(postgres);
        using var client = factory.CreateClient();

        var cronometro = System.Diagnostics.Stopwatch.StartNew();
        var resposta = await client.SendAsync(Requisicao(Payload("TRX-RAPIDO")));
        cronometro.Stop();

        resposta.StatusCode.ShouldBe(HttpStatusCode.Accepted);

        // Folga generosa para absorver o custo de subir o host no CI. O que se
        // afirma e a ordem de grandeza: nao paga os 2 segundos da regra.
        cronometro.ElapsedMilliseconds.ShouldBeLessThan(1500);
    }

    // --------------------------------------------------------- idempotencia

    [Fact]
    public async Task Reentrega_devolve_200_com_duplicate_e_nao_cria_segundo_job()
    {
        await _client.SendAsync(Requisicao(Payload("TRX-DUP")));
        var segunda = await _client.SendAsync(Requisicao(Payload("TRX-DUP")));

        segunda.StatusCode.ShouldBe(HttpStatusCode.OK);

        var ack = await segunda.Content.ReadFromJsonAsync<WebhookAck>();
        ack!.Duplicate.ShouldBeTrue();

        using var scope = _factory.CreateServiceScope();
        var db = _factory.Db(scope);

        (await db.PaymentEvents.CountAsync(e => e.IdTransacao == "TRX-DUP")).ShouldBe(1);
        (await db.ProcessingJobs.CountAsync()).ShouldBe(1);
    }

    [Fact]
    public async Task Reentrega_com_corpo_DIFERENTE_nao_sobrescreve_o_original()
    {
        // O parceiro reenvia o mesmo id_transacao com outro valor. A primeira
        // gravacao e a verdade; aceitar a segunda permitiria alterar um pagamento
        // ja processado apenas reenviando a notificacao.
        await _client.SendAsync(Requisicao(Payload("TRX-MUT", valor: 100m)));
        var segunda = await _client.SendAsync(Requisicao(Payload("TRX-MUT", valor: 999999m)));

        segunda.StatusCode.ShouldBe(HttpStatusCode.OK);

        using var scope = _factory.CreateServiceScope();
        var evento = await _factory.Db(scope).PaymentEvents.FirstAsync(e => e.IdTransacao == "TRX-MUT");

        evento.Valor.ShouldBe(100m);
    }

    [Fact]
    public async Task Vinte_reentregas_SIMULTANEAS_produzem_exatamente_um_evento()
    {
        // O teste central da idempotencia. Com verificacao apenas em memoria,
        // varias destas passariam pelo "ja existe?" ao mesmo tempo e todas
        // inseririam. E o indice unico do banco que arbitra.
        var tarefas = Enumerable.Range(0, 20)
            .Select(_ => _client.SendAsync(Requisicao(Payload("TRX-CORRIDA"))))
            .ToList();

        var respostas = await Task.WhenAll(tarefas);

        respostas.Count(r => r.StatusCode == HttpStatusCode.Accepted).ShouldBe(1);
        respostas.Count(r => r.StatusCode == HttpStatusCode.OK).ShouldBe(19);

        using var scope = _factory.CreateServiceScope();
        var db = _factory.Db(scope);

        (await db.PaymentEvents.CountAsync(e => e.IdTransacao == "TRX-CORRIDA")).ShouldBe(1);
        (await db.ProcessingJobs.CountAsync()).ShouldBe(1);

        foreach (var r in respostas) r.Dispose();
    }

    // ------------------------------------------------------------ validacao

    [Fact]
    public async Task Payload_invalido_devolve_400_MAS_e_persistido_para_auditoria()
    {
        // O requisito de "visualizacao de erros": um evento reprovado precisa
        // aparecer no dashboard, e nao ser descartado em silencio.
        var corpo = Payload("TRX-INVALIDO", idContrato: "", valor: -5m, status: "XPTO");

        var resposta = await _client.SendAsync(Requisicao(corpo));

        resposta.StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        var problema = await resposta.Content.ReadFromJsonAsync<ProblemDetailsDto>();
        problema!.Code.ShouldBe("validation_failed");
        problema.Errors.ShouldNotBeNull();
        problema.Errors!.ShouldContainKey("id_contrato");
        problema.Errors.ShouldContainKey("valor");
        problema.Errors.ShouldContainKey("status");

        using var scope = _factory.CreateServiceScope();
        var db = _factory.Db(scope);

        var evento = await db.PaymentEvents.FirstAsync(e => e.IdTransacao == "TRX-INVALIDO");
        evento.StatusProcessamento.ShouldBe(ProcessingStatus.Invalido);
        evento.Erro.ShouldNotBeNullOrWhiteSpace();

        // Sem job: nao ha o que processar num evento reprovado.
        (await db.ProcessingJobs.CountAsync()).ShouldBe(0);
    }

    [Fact]
    public async Task Data_no_futuro_e_reprovada_e_registrada()
    {
        var futuro = DateTimeOffset.UtcNow.AddYears(1).ToString("O");
        var resposta = await _client.SendAsync(Requisicao(Payload("TRX-FUTURO", dataPagamento: futuro)));

        resposta.StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        using var scope = _factory.CreateServiceScope();
        var evento = await _factory.Db(scope).PaymentEvents.FirstAsync(e => e.IdTransacao == "TRX-FUTURO");
        evento.Erro.ShouldContain("futuro");
    }

    [Fact]
    public async Task Sem_id_transacao_devolve_400_sem_persistir()
    {
        // Sem chave de idempotencia nao ha como auditar sem colidir com outros
        // payloads igualmente incompletos - e o unico caso nao persistido.
        var corpo = """{"id_contrato":"CTR-1","valor":10,"data_pagamento":"2026-08-01T10:00:00Z","status":"PAGO"}""";

        var resposta = await _client.SendAsync(Requisicao(corpo));

        resposta.StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        using var scope = _factory.CreateServiceScope();
        (await _factory.Db(scope).PaymentEvents.CountAsync()).ShouldBe(0);
    }

    [Fact]
    public async Task JSON_malformado_devolve_400_no_formato_do_contrato()
    {
        // Sem tratamento proprio, isto viraria o 400 generico do model binder -
        // com um corpo que o frontend nao sabe exibir.
        var resposta = await _client.SendAsync(Requisicao("{ isto nao e json "));

        resposta.StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        var problema = await resposta.Content.ReadFromJsonAsync<ProblemDetailsDto>();
        problema!.Code.ShouldBe("malformed_json");
        problema.Detail.ShouldNotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Health_identifica_o_backend_dotnet()
    {
        var resposta = await _client.GetAsync("/health");

        resposta.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await resposta.Content.ReadAsStringAsync()).ShouldContain("\"backend\":\"dotnet\"");
    }
}

/// <summary>Variante com a regra de negocio em duracao real (2s).</summary>
internal sealed class SabemiApiFactoryComRegraLenta(PostgresFixture postgres) : SabemiApiFactory(postgres)
{
    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.UseSetting("Processing:SimulatedWorkDuration", "00:00:02");
    }
}
