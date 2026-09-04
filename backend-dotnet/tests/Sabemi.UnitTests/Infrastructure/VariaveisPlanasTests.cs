using Microsoft.Extensions.Configuration;
using Sabemi.Infrastructure.Configuration;
using Shouldly;

namespace Sabemi.UnitTests.Infrastructure;

/// <summary>
/// Os nomes planos de variável de ambiente que o backend .NET precisa entender.
/// </summary>
/// <remarks>
/// <para>Este arquivo existe por causa de um defeito real, encontrado no
/// primeiro deploy fora do Compose. Os dois backends leem a mesma configuração
/// sob nomes diferentes — <c>WEBHOOK_API_KEY</c> no VINEXT,
/// <c>WebhookSecurity__ApiKey</c> no .NET — e quem sempre ligou um ao outro foi
/// o <c>docker-compose.yml</c>. Num host que não usa o Compose esse
/// intermediário não existe, e definir <c>JWT_SECRET</c> passa a configurar
/// METADE do sistema.</para>
///
/// <para>A metade não configurada não reclama: ela cai no padrão do
/// <c>appsettings.json</c>. O sistema sobe, responde <c>200</c>, o painel abre —
/// e o <c>api</c> assina a sessão com o segredo versionado do repositório. O
/// único sintoma seria o operador ser deslogado ao trocar de backend no painel,
/// que ninguém liga à causa.</para>
///
/// <para>É a mesma armadilha que a seção 6.9 do handoff registrou para o
/// <c>AUTH_EXPOSE_LOGIN_CODES</c>, reaparecendo num lugar onde o teste de
/// paridade do Compose não alcança — porque ali não há Compose para ler.</para>
/// </remarks>
public class VariaveisPlanasTests : IDisposable
{
    private readonly List<string> _definidas = [];

    private void Definir(string nome, string? valor)
    {
        _definidas.Add(nome);
        Environment.SetEnvironmentVariable(nome, valor);
    }

    public void Dispose()
    {
        // Variável de ambiente é estado de processo: uma que sobrevivesse ao
        // teste contaminaria o próximo, com uma falha que aponta para o lugar
        // errado.
        foreach (var nome in _definidas) Environment.SetEnvironmentVariable(nome, null);
        GC.SuppressFinalize(this);
    }

    private static ConfigurationManager Configuracao(params (string chave, string valor)[] existentes)
    {
        var manager = new ConfigurationManager();
        if (existentes.Length > 0)
        {
            manager.AddInMemoryCollection(
                existentes.Select(e => new KeyValuePair<string, string?>(e.chave, e.valor)));
        }
        return manager;
    }

    [Fact]
    public void O_nome_plano_alimenta_a_chave_do_IConfiguration()
    {
        Definir("JWT_SECRET", "um-segredo-de-teste-com-mais-de-32-caracteres");
        Definir("WEBHOOK_API_KEY", "chave-combinada");

        var configuracao = Configuracao();
        VariaveisPlanas.Aplicar(configuracao);

        configuracao["Jwt:Secret"].ShouldBe("um-segredo-de-teste-com-mais-de-32-caracteres");
        configuracao["WebhookSecurity:ApiKey"].ShouldBe("chave-combinada");
    }

    [Fact]
    public void O_nome_especifico_vence_o_plano()
    {
        // Sob Compose, quem chega é `Jwt__Secret`. Esta classe não pode
        // sobrescrever uma escolha explícita - senão mudaria o comportamento de
        // quem já estava configurado.
        Definir("JWT_SECRET", "o-plano-nao-deve-vencer-este-valor-explicito");

        var configuracao = Configuracao(("Jwt:Secret", "veio-do-compose-e-manda"));
        VariaveisPlanas.Aplicar(configuracao);

        configuracao["Jwt:Secret"].ShouldBe("veio-do-compose-e-manda");
    }

    [Fact]
    public void Sem_variavel_no_ambiente_nada_e_inventado()
    {
        var configuracao = Configuracao();
        VariaveisPlanas.Aplicar(configuracao);

        configuracao["Jwt:Secret"].ShouldBeNull();
        configuracao["WebhookSecurity:ApiKey"].ShouldBeNull();
    }

    [Fact]
    public void Producao_recusa_subir_com_o_segredo_de_exemplo()
    {
        var configuracao = Configuracao(("Jwt:Secret", VariaveisPlanas.SegredoDeExemplo));

        var erro = Should.Throw<InvalidOperationException>(
            () => VariaveisPlanas.ExigirSegredoProprio(configuracao, producao: true));

        // A mensagem precisa dizer o que fazer, e avisar do par: um segredo
        // diferente em cada backend derruba a sessão na troca.
        erro.Message.ShouldContain("JWT_SECRET");
        erro.Message.ShouldContain("VINEXT");
    }

    [Fact]
    public void Fora_de_producao_o_segredo_de_exemplo_e_aceito()
    {
        // É o que permite clonar e rodar sem configurar nada.
        var configuracao = Configuracao(("Jwt:Secret", VariaveisPlanas.SegredoDeExemplo));

        Should.NotThrow(() => VariaveisPlanas.ExigirSegredoProprio(configuracao, producao: false));
    }

    [Fact]
    public void Producao_aceita_um_segredo_proprio()
    {
        var configuracao = Configuracao(("Jwt:Secret", "este-e-um-segredo-proprio-com-mais-de-32-chars"));

        Should.NotThrow(() => VariaveisPlanas.ExigirSegredoProprio(configuracao, producao: true));
    }

    [Fact]
    public void O_mapa_cobre_toda_configuracao_compartilhada_pelos_dois_backends()
    {
        // Acrescentar uma configuração que valha para os dois lados e esquecer
        // desta lista recria exatamente o defeito. Os nomes abaixo são os que o
        // `docker-compose.yml` liga hoje.
        string[] compartilhadas =
        [
            "JWT_SECRET",
            "WEBHOOK_API_KEY",
            "WEBHOOK_SIGNATURE_SECRET",
            "WEBHOOK_REQUIRE_SIGNATURE",
            "API_PUBLIC_URL",
            "FRONTEND_PUBLIC_URL",
            "AUTH_EXPOSE_LOGIN_CODES",
            "AUTH_RESEND_COOLDOWN_SECONDS",
            "AUTH_RATE_LIMIT",
            "PROCESSING_SIMULATED_WORK_MS",
            "PROCESSING_BATCH_SIZE",
            "PROCESSING_MAX_ATTEMPTS",
            "BREVO_API_KEY",
            "BREVO_SENDER_EMAIL",
            "BREVO_SENDER_NAME",
        ];

        foreach (var nome in compartilhadas)
        {
            VariaveisPlanas.Mapa.ShouldContainKey(
                nome,
                $"'{nome}' vale para os dois backends e precisa estar no mapa.");
        }
    }
}
