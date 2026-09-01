using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Auth;
using Sabemi.Application.Contracts;
using Sabemi.Application.Payments;
using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;
using Sabemi.Infrastructure.Persistence;
using Sabemi.IntegrationTests.Support;
using Shouldly;

namespace Sabemi.IntegrationTests.Api;

/// <summary>
/// Filtros e agregacoes do dashboard.
/// </summary>
/// <remarks>
/// Cobre os filtros exigidos pela task (situacao e contrato) e a paginacao.
/// Roda contra PostgreSQL real porque o que interessa e a consulta TRADUZIDA:
/// um filtro que o EF nao consiga traduzir cairia em avaliacao no cliente,
/// trazendo a tabela inteira para a memoria - um problema que so aparece com
/// banco de verdade e volume.
/// </remarks>
[Collection(PostgresCollection.Name)]
public class DashboardQueryTests(PostgresFixture postgres) : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    public async Task InitializeAsync()
    {
        await postgres.ResetAsync();
        await SemearDados();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    /// <summary>
    /// Conjunto que cobre todas as situacoes e dois contratos, para os filtros
    /// terem o que discriminar.
    /// </summary>
    private async Task SemearDados()
    {
        await using var db = postgres.CreateDbContext();

        void Sucesso(string id, string contrato, int minutos)
        {
            var e = PaymentEvent.Accepted(id, contrato, 100m, T0, "PAGO", "{}", true, T0.AddMinutes(minutos));
            e.MarkProcessing(1);
            e.MarkSucceeded(T0.AddMinutes(minutos + 1));
            db.PaymentEvents.Add(e);
        }

        void Erro(string id, string contrato, int minutos)
        {
            var e = PaymentEvent.Accepted(id, contrato, 100m, T0, "PAGO", "{}", true, T0.AddMinutes(minutos));
            e.MarkProcessing(3);
            e.MarkFailed("gateway indisponivel", T0.AddMinutes(minutos + 1));
            db.PaymentEvents.Add(e);
        }

        void Invalido(string id, string? contrato, int minutos)
        {
            db.PaymentEvents.Add(PaymentEvent.Rejected(
                id, contrato, null, null, null, "{}", "valor obrigatorio", false, T0.AddMinutes(minutos)));
        }

        void Pendente(string id, string contrato, int minutos)
        {
            db.PaymentEvents.Add(PaymentEvent.Accepted(
                id, contrato, 100m, T0, "PAGO", "{}", true, T0.AddMinutes(minutos)));
        }

        Sucesso("S-1", "CTR-A", 1);
        Sucesso("S-2", "CTR-A", 2);
        Sucesso("S-3", "CTR-B", 3);
        Erro("E-1", "CTR-A", 4);
        Erro("E-2", "CTR-B", 5);
        Invalido("I-1", "CTR-A", 6);
        Invalido("I-2", null, 7);
        Pendente("P-1", "CTR-B", 8);

        await db.SaveChangesAsync();
    }

    private PaymentQueryService Servico(SabemiDbContext db) => new(db);

    [Fact]
    public async Task Sem_filtro_devolve_tudo_do_mais_recente_para_o_mais_antigo()
    {
        await using var db = postgres.CreateDbContext();

        var pagina = await Servico(db).ListAsync(PaymentQuery.From(null, null, null, null));

        pagina.Total.ShouldBe(8);
        pagina.Items.Count.ShouldBe(8);

        // Mais recente primeiro: o operador quer ver o que acabou de chegar.
        pagina.Items[0].IdTransacao.ShouldBe("P-1");
        pagina.Items[^1].IdTransacao.ShouldBe("S-1");
    }

    [Theory]
    [InlineData("SUCESSO", 3)]
    [InlineData("ERRO", 2)]
    [InlineData("INVALIDO", 2)]
    [InlineData("PENDENTE", 1)]
    [InlineData("DUPLICADO", 0)]
    public async Task Filtro_por_situacao(string status, int esperado)
    {
        await using var db = postgres.CreateDbContext();

        var pagina = await Servico(db).ListAsync(PaymentQuery.From(status, null, null, null));

        pagina.Total.ShouldBe(esperado);
        pagina.Items.ShouldAllBe(e => e.StatusProcessamento == status);
    }

    [Theory]
    [InlineData("CTR-A", 4)]
    [InlineData("CTR-B", 3)]
    [InlineData("CTR-INEXISTENTE", 0)]
    public async Task Filtro_por_contrato(string contrato, int esperado)
    {
        await using var db = postgres.CreateDbContext();

        var pagina = await Servico(db).ListAsync(PaymentQuery.From(null, contrato, null, null));

        pagina.Total.ShouldBe(esperado);
        pagina.Items.ShouldAllBe(e => e.IdContrato == contrato);
    }

    [Fact]
    public async Task Filtros_combinados_sao_aplicados_juntos()
    {
        await using var db = postgres.CreateDbContext();

        var pagina = await Servico(db).ListAsync(PaymentQuery.From("SUCESSO", "CTR-A", null, null));

        pagina.Total.ShouldBe(2);
        pagina.Items.ShouldAllBe(e => e.IdContrato == "CTR-A" && e.StatusProcessamento == "SUCESSO");
    }

    [Fact]
    public async Task Filtro_por_ERRO_e_o_caminho_para_investigar_falhas()
    {
        // O caso de uso do requisito de visualizacao de erros.
        await using var db = postgres.CreateDbContext();

        var pagina = await Servico(db).ListAsync(PaymentQuery.From("ERRO", null, null, null));

        pagina.Items.ShouldAllBe(e => e.Erro != null);
        pagina.Items[0].Erro.ShouldContain("gateway indisponivel");
    }

    [Fact]
    public async Task Paginacao_divide_sem_repetir_nem_perder()
    {
        await using var db = postgres.CreateDbContext();
        var servico = Servico(db);

        var p1 = await servico.ListAsync(PaymentQuery.From(null, null, 1, 3));
        var p2 = await servico.ListAsync(PaymentQuery.From(null, null, 2, 3));
        var p3 = await servico.ListAsync(PaymentQuery.From(null, null, 3, 3));

        p1.Items.Count.ShouldBe(3);
        p2.Items.Count.ShouldBe(3);
        p3.Items.Count.ShouldBe(2);

        // O total e sempre o do conjunto filtrado, nao o da pagina.
        p1.Total.ShouldBe(8);

        var ids = p1.Items.Concat(p2.Items).Concat(p3.Items).Select(e => e.IdTransacao).ToList();
        ids.Distinct().Count().ShouldBe(8);
    }

    [Fact]
    public async Task Pagina_alem_do_fim_devolve_lista_vazia_com_total_correto()
    {
        await using var db = postgres.CreateDbContext();

        var pagina = await Servico(db).ListAsync(PaymentQuery.From(null, null, 99, 20));

        pagina.Items.ShouldBeEmpty();
        pagina.Total.ShouldBe(8);
    }

    [Fact]
    public async Task Resumo_traz_TODAS_as_chaves_mesmo_as_zeradas()
    {
        // O contrato promete o conjunto completo, para o frontend nao precisar
        // tratar chave ausente ao montar os cartoes.
        await using var db = postgres.CreateDbContext();

        var resumo = await Servico(db).GetSummaryAsync();

        resumo.Total.ShouldBe(8);
        resumo.PorStatus.Count.ShouldBe(Enum.GetValues<ProcessingStatus>().Length);

        resumo.PorStatus["SUCESSO"].ShouldBe(3);
        resumo.PorStatus["ERRO"].ShouldBe(2);
        resumo.PorStatus["INVALIDO"].ShouldBe(2);
        resumo.PorStatus["PENDENTE"].ShouldBe(1);
        resumo.PorStatus["DUPLICADO"].ShouldBe(0);
        resumo.PorStatus["PROCESSANDO"].ShouldBe(0);
    }

    [Fact]
    public async Task Detalhe_traz_o_payload_bruto()
    {
        await using var db = postgres.CreateDbContext();

        var detalhe = await Servico(db).GetByTransactionIdAsync("S-1");

        detalhe.ShouldNotBeNull();
        detalhe!.IdTransacao.ShouldBe("S-1");
        detalhe.PayloadBruto.ShouldNotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Detalhe_de_transacao_inexistente_devolve_nulo()
    {
        await using var db = postgres.CreateDbContext();

        (await Servico(db).GetByTransactionIdAsync("NAO-EXISTE")).ShouldBeNull();
    }

    [Fact]
    public async Task Contrato_inexistente_devolve_nulo()
    {
        await using var db = postgres.CreateDbContext();

        (await Servico(db).GetContractAsync("CTR-FANTASMA")).ShouldBeNull();
    }
}

/// <summary>
/// Comportamentos do servico de autenticacao que dependem do tempo.
/// </summary>
/// <remarks>
/// Separados dos testes HTTP porque exigem controlar o relogio: verificar
/// expiracao esperando 15 minutos de verdade nao e uma suite, e uma pausa para o
/// cafe.
/// </remarks>
[Collection(PostgresCollection.Name)]
public class AuthExpiryTests(PostgresFixture postgres) : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    public async Task InitializeAsync() => await postgres.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    private sealed class NotificadorSilencioso : ILoginNotificationSender
    {
        public Task<bool> SendAsync(string email, string magicUrl, string otpCode, CancellationToken ct = default)
            => Task.FromResult(false);
    }

    private sealed class TokenFalso : ITokenIssuer
    {
        public (string Token, int ExpiresInSeconds) Issue(AppUser user) => ("token-de-teste", 3600);
    }

    private (AuthService Auth, FakeClock Clock, SabemiDbContext Db) Montar()
    {
        var db = postgres.CreateDbContext();
        var clock = new FakeClock(T0);

        var opcoes = Options.Create(new AuthOptions
        {
            MagicLinkTtl = TimeSpan.FromMinutes(15),
            OtpMaxAttempts = 5,
            ExposeLoginCodesInDevelopment = true,
            IsProduction = false,
            PublicBaseUrl = "http://localhost:8080",
        });

        var auth = new AuthService(
            db, clock, new TokenFalso(), new NotificadorSilencioso(), opcoes,
            NullLogger<AuthService>.Instance);

        return (auth, clock, db);
    }

    [Fact]
    public async Task Pedido_expirado_nao_pode_mais_ser_consultado()
    {
        var (auth, clock, db) = Montar();
        await using var _ = db;

        var inicio = await auth.StartAsync("expira@sabemi.com.br");
        inicio.Ok.ShouldBeTrue();

        clock.Advance(TimeSpan.FromMinutes(16));

        var resultado = await auth.PollAsync(inicio.Value!.Selector);

        resultado.Ok.ShouldBeFalse();
        resultado.Failure.ShouldBe(AuthFailure.NotFound);
    }

    [Fact]
    public async Task Link_expirado_nao_aprova()
    {
        var (auth, clock, db) = Montar();
        await using var _ = db;

        var inicio = await auth.StartAsync("link@sabemi.com.br");
        var token = ExtrairToken(inicio.Value!.DevMagicUrl!);

        clock.Advance(TimeSpan.FromMinutes(16));

        (await auth.ConfirmAsync(token)).ShouldBeFalse();
    }

    [Fact]
    public async Task OTP_expirado_e_recusado()
    {
        var (auth, clock, db) = Montar();
        await using var _ = db;

        var inicio = await auth.StartAsync("otp@sabemi.com.br");

        clock.Advance(TimeSpan.FromMinutes(16));

        var resultado = await auth.VerifyOtpAsync(inicio.Value!.Selector, inicio.Value.DevOtpCode!);

        resultado.Ok.ShouldBeFalse();
        resultado.Failure.ShouldBe(AuthFailure.NotFound);
    }

    [Fact]
    public async Task Pedido_dentro_do_prazo_continua_valido()
    {
        var (auth, clock, db) = Montar();
        await using var _ = db;

        var inicio = await auth.StartAsync("dentro@sabemi.com.br");

        clock.Advance(TimeSpan.FromMinutes(14));

        var resultado = await auth.PollAsync(inicio.Value!.Selector);

        resultado.Ok.ShouldBeTrue();
        resultado.Value!.Status.ShouldBe("pending");
    }

    [Fact]
    public async Task Limpeza_remove_apenas_os_vencidos()
    {
        var (auth, clock, db) = Montar();
        await using var _ = db;

        await auth.StartAsync("velho@sabemi.com.br");
        clock.Advance(TimeSpan.FromMinutes(16));
        var recente = await auth.StartAsync("novo@sabemi.com.br");

        var removidos = await auth.PurgeExpiredAsync();

        removidos.ShouldBe(1);
        (await auth.PollAsync(recente.Value!.Selector)).Ok.ShouldBeTrue();
    }

    [Fact]
    public async Task Em_producao_os_codigos_NUNCA_aparecem_na_resposta()
    {
        // Falha fechada: a decisao e do servidor e nenhuma configuracao a
        // contorna em producao.
        await using var db = postgres.CreateDbContext();

        var auth = new AuthService(
            db, new FakeClock(T0), new TokenFalso(), new NotificadorSilencioso(),
            Options.Create(new AuthOptions
            {
                IsProduction = true,
                // Ligado de proposito: o ambiente tem de vencer esta opcao.
                ExposeLoginCodesInDevelopment = true,
            }),
            NullLogger<AuthService>.Instance);

        var inicio = await auth.StartAsync("producao@sabemi.com.br");

        inicio.Value!.DevMagicUrl.ShouldBeNull();
        inicio.Value.DevOtpCode.ShouldBeNull();
    }

    private static string ExtrairToken(string magicUrl)
        => System.Web.HttpUtility.ParseQueryString(new Uri(magicUrl).Query)["token"]!;
}
