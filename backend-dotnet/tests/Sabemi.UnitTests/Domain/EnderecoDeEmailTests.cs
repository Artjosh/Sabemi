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
/// Sao cinco comportamentos, um caso cada, mais a paridade com o backend VINEXT.
/// A primeira versao destes testes tinha 18 casos para uma funcao de 12 linhas -
/// variacoes da mesma asfirmacao, que nao acrescentavam ramo nem regra.
/// </remarks>
public class EnderecoDeEmailTests
{
    [Theory]
    [InlineData("operador@sabemi.com.br", true)]
    [InlineData("MAIUSCULA@SABEMI.COM.BR", true)]

    // Um caso por dominio da lista: e a superficie real da regra, e um erro de
    // digitacao em qualquer entrada aparece aqui.
    [InlineData("e2e-dotnet-123@e2e.invalid", false)]
    [InlineData("qualquer@exemplo.test", false)]
    [InlineData("alguem@algo.example", false)]
    [InlineData("dev@app.localhost", false)]

    // Sem subdominio o sufixo ".invalid" nao casaria, e o endereco passaria.
    [InlineData("alguem@invalid", false)]

    // Raiz explicita e sintaxe legitima de nome de dominio. Sem normalizar,
    // "a@b.invalid." escaparia da regra por um caractere.
    [InlineData("alguem@sub.invalid.", false)]

    // Sem dominio nao ha onde entregar.
    [InlineData(null, false)]
    [InlineData("sem-arroba", false)]
    public void Somente_um_dominio_que_pode_receber_gera_tentativa(string? email, bool esperado)
    {
        // RFC 2606 / 6761: `.invalid`, `.test`, `.example` e `.localhost` existem
        // para NAO existirem. Nao ha MX, nenhuma mensagem chega, e cada tentativa
        // e um hard bounce garantido.
        EnderecoDeEmail.PodeReceber(email).ShouldBe(esperado);
    }

    [Fact]
    public void A_lista_e_a_mesma_do_backend_VINEXT()
    {
        // Os dois backends compartilham a tabela de pedidos de login. Uma regra
        // que valesse em um e nao no outro seria uma diferenca de comportamento
        // invisivel: o mesmo endereco receberia tentativa por um caminho e nao
        // pelo outro, dependendo de qual backend estivesse selecionado.
        //
        // O espelho e `frontend/server/bff/email-address.ts`, e o teste de la le
        // ESTE arquivo para comparar - a lista abaixo e a copia que ele confere.
        string[] doVinext = [".invalid", ".test", ".example", ".localhost"];

        EnderecoDeEmail.DominiosReservados.ShouldBe(doVinext, ignoreOrder: true);
    }
}
