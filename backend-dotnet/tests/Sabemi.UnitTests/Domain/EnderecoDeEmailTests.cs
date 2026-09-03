using Sabemi.Domain.Auth;
using Shouldly;

namespace Sabemi.UnitTests.Domain;

/// <summary>
/// A regra que impede o sistema de gerar hard bounces.
/// </summary>
/// <remarks>
/// Nasceu de um incidente: uma execucao da suite ponta a ponta com provedor de
/// e-mail ativo mandou 26 mensagens para enderecos inventados em
/// <c>@sabemi.com.br</c>. Todas viraram hard bounce, e bounce nao e mensagem
/// perdida - e reputacao de envio perdida, de forma acumulativa e irreversivel.
///
/// O primeiro remedio foi a suite abortar quando havia provedor. Isto e o
/// remedio de verdade: enderecos que <i>nao podem</i> receber nao recebem
/// tentativa, e a suite passou a inventar os seus em <c>@e2e.invalid</c>.
/// </remarks>
public class EnderecoDeEmailTests
{
    [Theory]
    [InlineData("operador@sabemi.com.br")]
    [InlineData("alguem@gmail.com")]
    [InlineData("com.ponto@sub.dominio.co.uk")]
    [InlineData("MAIUSCULA@SABEMI.COM.BR")]
    public void Um_endereco_entregavel_recebe_tentativa(string email)
    {
        EnderecoDeEmail.PodeReceber(email).ShouldBeTrue();
    }

    [Theory]
    [InlineData("e2e-dotnet-123@e2e.invalid")]
    [InlineData("qualquer@exemplo.test")]
    [InlineData("alguem@algo.example")]
    [InlineData("dev@app.localhost")]
    public void Um_dominio_reservado_por_RFC_nunca_recebe_tentativa(string email)
    {
        // RFC 2606 / 6761: estes TLDs existem para NAO existirem. Nao ha MX,
        // nenhuma mensagem chega, e cada tentativa e um hard bounce garantido.
        EnderecoDeEmail.PodeReceber(email).ShouldBeFalse();
    }

    [Theory]
    [InlineData("alguem@invalid")]
    [InlineData("alguem@test")]
    [InlineData("alguem@localhost")]
    public void O_dominio_reservado_tambem_conta_quando_usado_NU(string email)
    {
        // Sem subdominio o sufixo ".invalid" nao casaria, e o endereco passaria.
        EnderecoDeEmail.PodeReceber(email).ShouldBeFalse();
    }

    [Fact]
    public void Um_ponto_final_no_dominio_nao_esconde_o_TLD_reservado()
    {
        // Raiz explicita e sintaxe legitima de nome de dominio. Sem normalizar,
        // "a@b.invalid." escaparia da regra por um caractere.
        EnderecoDeEmail.PodeReceber("alguem@sub.invalid.").ShouldBeFalse();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("sem-arroba")]
    [InlineData("termina-em@")]
    public void Sem_dominio_nao_ha_onde_entregar(string? email)
    {
        EnderecoDeEmail.PodeReceber(email).ShouldBeFalse();
    }

    [Fact]
    public void A_lista_e_a_mesma_do_backend_VINEXT()
    {
        // Os dois backends compartilham a tabela de pedidos de login. Uma regra
        // que valesse em um e nao no outro seria uma diferenca de comportamento
        // invisivel: o mesmo endereco receberia tentativa por um caminho e nao
        // pelo outro, dependendo de qual backend estivesse selecionado.
        //
        // O espelho e `frontend/server/bff/email-address.ts`. Este teste falha
        // se alguem acrescentar um dominio aqui e esquecer la - a lista abaixo e
        // copiada do arquivo TypeScript de proposito.
        string[] doVinext = [".invalid", ".test", ".example", ".localhost"];

        EnderecoDeEmail.DominiosReservados.ShouldBe(doVinext, ignoreOrder: true);
    }
}
