using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Sabemi.Application.Contracts;
using Sabemi.Domain.Entities;
using Sabemi.IntegrationTests.Support;
using Shouldly;

namespace Sabemi.IntegrationTests.Api;

/// <summary>
/// Autenticacao passwordless com polling cross-device.
/// </summary>
/// <remarks>
/// A feature reproduzida do projeto de referencia. Os testes cobrem o fluxo
/// inteiro pela borda HTTP - inclusive o cenario que da nome a feature: o link
/// confirmado por OUTRO cliente, e a aba de origem descobrindo isso sozinha no
/// polling seguinte.
/// </remarks>
[Collection(PostgresCollection.Name)]
public class AuthPollingTests(PostgresFixture postgres) : IAsyncLifetime
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

    private async Task<MagicLinkStartDto> IniciarLogin(string email = "operador@sabemi.com.br")
    {
        var resposta = await _client.PostAsJsonAsync("/auth/magic-link", new { email });
        resposta.StatusCode.ShouldBe(HttpStatusCode.OK);
        return (await resposta.Content.ReadFromJsonAsync<MagicLinkStartDto>())!;
    }

    private Task<HttpResponseMessage> Poll(string selector)
        => _client.PostAsync($"/auth/login-status?selector={Uri.EscapeDataString(selector)}", null);

    // ----------------------------------------------------------------- inicio

    [Fact]
    public async Task Inicio_devolve_selector_e_o_pedido_fica_pendente()
    {
        var inicio = await IniciarLogin();

        inicio.Selector.ShouldNotBeNullOrWhiteSpace();
        inicio.Email.ShouldBe("operador@sabemi.com.br");

        using var scope = _factory.CreateServiceScope();
        var pedido = await _factory.Db(scope).LoginRequests.SingleAsync();
        pedido.Status.ShouldBe(LoginRequestStatus.Pendente);
    }

    [Fact]
    public async Task Segredos_sao_guardados_apenas_como_hash()
    {
        // Um vazamento do banco nao pode entregar logins ativos. O que fica
        // gravado sao digests SHA-256, nunca o token ou o codigo em claro.
        var inicio = await IniciarLogin();

        using var scope = _factory.CreateServiceScope();
        var pedido = await _factory.Db(scope).LoginRequests.SingleAsync();

        pedido.MagicTokenHash.ShouldNotBeNull();
        pedido.MagicTokenHash!.Length.ShouldBe(64);
        pedido.OtpCodeHash!.Length.ShouldBe(64);

        // O que esta no banco NAO e o segredo em claro: nem o codigo exposto em
        // dev, nem o token que viaja no link.
        pedido.OtpCodeHash.ShouldNotBe(inicio.DevOtpCode);
        inicio.DevMagicUrl.ShouldNotBeNull();
        inicio.DevMagicUrl!.ShouldNotContain(pedido.MagicTokenHash!);
    }

    [Theory]
    [InlineData("")]
    [InlineData("sem-arroba")]
    [InlineData("dois@@arrobas.com")]
    [InlineData("com espaco@x.com")]
    public async Task Email_implausivel_e_recusado(string email)
    {
        var resposta = await _client.PostAsJsonAsync("/auth/magic-link", new { email });

        resposta.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Novo_pedido_invalida_o_anterior_do_mesmo_email()
    {
        // Sem isto, quem pedisse duas vezes teria dois codigos validos ao mesmo
        // tempo - e o link antigo continuaria funcionando.
        var primeiro = await IniciarLogin();
        var segundo = await IniciarLogin();

        var respostaAntiga = await Poll(primeiro.Selector);
        respostaAntiga.StatusCode.ShouldBe(HttpStatusCode.NotFound);

        var respostaNova = await Poll(segundo.Selector);
        respostaNova.StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    // ---------------------------------------------------------------- polling

    [Fact]
    public async Task Polling_devolve_pending_enquanto_ninguem_confirma()
    {
        var inicio = await IniciarLogin();

        var resposta = await Poll(inicio.Selector);
        var status = await resposta.Content.ReadFromJsonAsync<LoginStatusDto>();

        resposta.StatusCode.ShouldBe(HttpStatusCode.OK);
        status!.Status.ShouldBe("pending");
        status.Authenticated.ShouldBeFalse();
        // Resposta minima: ela e pedida a cada 2,5s.
        status.AccessToken.ShouldBeNull();
    }

    [Fact]
    public async Task Fluxo_CROSS_DEVICE_completo()
    {
        // O cenario que define a feature: o link e aberto por um cliente HTTP
        // diferente (outro aparelho), e a aba de origem entra sozinha.
        var inicio = await IniciarLogin();

        (await Poll(inicio.Selector)).Content
            .ReadFromJsonAsync<LoginStatusDto>().Result!.Status.ShouldBe("pending");

        // "Outro dispositivo" abre o link.
        using var outroDispositivo = _factory.CreateClient();
        var caminho = new Uri(inicio.DevMagicUrl!).PathAndQuery;
        var confirmacao = await outroDispositivo.GetAsync(caminho);
        confirmacao.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await confirmacao.Content.ReadAsStringAsync()).ShouldContain("Acesso confirmado");

        // A aba original descobre no proximo ciclo.
        var aprovado = await Poll(inicio.Selector);
        var status = await aprovado.Content.ReadFromJsonAsync<LoginStatusDto>();

        status!.Status.ShouldBe("approved");
        status.Authenticated.ShouldBeTrue();
        status.AccessToken.ShouldNotBeNullOrWhiteSpace();
        status.User!.Email.ShouldBe("operador@sabemi.com.br");
    }

    [Fact]
    public async Task Pedido_e_de_uso_unico_e_o_segundo_polling_devolve_404()
    {
        // E assim que o cliente sabe parar de perguntar, em vez de girar ate o
        // timeout de 15 minutos.
        var inicio = await IniciarLogin();
        await _client.GetAsync(new Uri(inicio.DevMagicUrl!).PathAndQuery);

        (await Poll(inicio.Selector)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Poll(inicio.Selector)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Selector_inexistente_devolve_404()
    {
        var resposta = await Poll("selector-que-nunca-existiu");

        resposta.StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Primeiro_acesso_cria_a_conta_automaticamente()
    {
        // Nao ha tela de cadastro: a posse da caixa de e-mail e o unico fator.
        var inicio = await IniciarLogin("novo.usuario@sabemi.com.br");

        using (var scope = _factory.CreateServiceScope())
        {
            // A conta ainda NAO existe: apenas pedir o link nao cria usuario,
            // senao bastaria digitar e-mails para encher a tabela.
            (await _factory.Db(scope).Users.CountAsync()).ShouldBe(0);
        }

        await _client.GetAsync(new Uri(inicio.DevMagicUrl!).PathAndQuery);

        using var scope2 = _factory.CreateServiceScope();
        var usuario = await _factory.Db(scope2).Users.SingleAsync();
        usuario.Email.ShouldBe("novo.usuario@sabemi.com.br");
    }

    [Fact]
    public async Task Login_repetido_reaproveita_a_mesma_conta()
    {
        for (var i = 0; i < 2; i++)
        {
            var inicio = await IniciarLogin("recorrente@sabemi.com.br");
            await _client.GetAsync(new Uri(inicio.DevMagicUrl!).PathAndQuery);
            await Poll(inicio.Selector);
        }

        using var scope = _factory.CreateServiceScope();
        (await _factory.Db(scope).Users.CountAsync(u => u.Email == "recorrente@sabemi.com.br"))
            .ShouldBe(1);
    }

    // -------------------------------------------------------------------- OTP

    [Fact]
    public async Task OTP_correto_autentica_na_hora()
    {
        var inicio = await IniciarLogin();

        var resposta = await _client.PostAsJsonAsync("/auth/verify-otp",
            new { selector = inicio.Selector, code = inicio.DevOtpCode });

        resposta.StatusCode.ShouldBe(HttpStatusCode.OK);

        var status = await resposta.Content.ReadFromJsonAsync<LoginStatusDto>();
        status!.Authenticated.ShouldBeTrue();
        status.AccessToken.ShouldNotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task OTP_incorreto_devolve_400_e_mantem_o_pedido_vivo()
    {
        var inicio = await IniciarLogin();

        var resposta = await _client.PostAsJsonAsync("/auth/verify-otp",
            new { selector = inicio.Selector, code = "000000" });

        resposta.StatusCode.ShouldBe(HttpStatusCode.BadRequest);

        // Um erro de digitacao nao pode destruir o pedido - so esgotar as
        // tentativas destroi.
        (await Poll(inicio.Selector)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Forca_bruta_no_OTP_destroi_o_pedido()
    {
        var inicio = await IniciarLogin();

        // O limite padrao e 5 tentativas.
        for (var i = 0; i < 5; i++)
        {
            await _client.PostAsJsonAsync("/auth/verify-otp",
                new { selector = inicio.Selector, code = "111111" });
        }

        var bloqueado = await _client.PostAsJsonAsync("/auth/verify-otp",
            new { selector = inicio.Selector, code = inicio.DevOtpCode });

        // Nem o codigo CORRETO entra depois disso.
        bloqueado.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        (await Poll(inicio.Selector)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task OTP_de_outro_pedido_nao_serve()
    {
        var pedidoA = await IniciarLogin("a@sabemi.com.br");
        var pedidoB = await IniciarLogin("b@sabemi.com.br");

        var resposta = await _client.PostAsJsonAsync("/auth/verify-otp",
            new { selector = pedidoA.Selector, code = pedidoB.DevOtpCode });

        resposta.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }

    // ---------------------------------------------------------------- sessao

    [Fact]
    public async Task Token_emitido_da_acesso_ao_dashboard()
    {
        var inicio = await IniciarLogin();
        await _client.GetAsync(new Uri(inicio.DevMagicUrl!).PathAndQuery);
        var status = await (await Poll(inicio.Selector)).Content.ReadFromJsonAsync<LoginStatusDto>();

        using var autenticado = _factory.CreateClient();
        autenticado.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", status!.AccessToken);

        (await autenticado.GetAsync("/auth/me")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await autenticado.GetAsync("/payments")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Dashboard_sem_sessao_devolve_401_no_formato_do_contrato()
    {
        var resposta = await _client.GetAsync("/payments");

        resposta.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        var problema = await resposta.Content.ReadFromJsonAsync<ProblemDetailsDto>();
        problema!.Code.ShouldBe("unauthorized");
    }

    [Fact]
    public async Task Token_forjado_e_recusado()
    {
        using var cliente = _factory.CreateClient();
        cliente.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "eyJ.forjado.abc");

        (await cliente.GetAsync("/payments")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Link_invalido_devolve_pagina_de_erro()
    {
        var resposta = await _client.GetAsync("/auth/confirm?token=token-que-nao-existe");

        resposta.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await resposta.Content.ReadAsStringAsync()).ShouldContain("Link");
    }
}
