using System.Net.Sockets;
using Sabemi.Domain.Processing;
using Shouldly;

namespace Sabemi.UnitTests.Domain;

/// <summary>
/// A leitura de falhas que decide o retry automatico.
/// </summary>
/// <remarks>
/// O que se verifica aqui nao e "o classificador reconhece strings", e sim a
/// regra de negocio embutida nele: uma causa que nao melhora com o tempo nao
/// deve consumir tentativas, e uma que melhora nao deve virar falha definitiva.
/// Errar o primeiro caso atrasa em minutos o aviso ao operador; errar o segundo
/// deixa um pagamento sem consolidar.
/// </remarks>
public class FailureClassifierTests
{
    [Fact]
    public void Timeout_e_transitorio_e_retentavel()
    {
        var d = FailureClassifier.Classify(new TimeoutException("O tempo acabou."));

        d.Category.ShouldBe(FailureCategory.Transitoria);
        d.Code.ShouldBe("TIMEOUT");
        d.IsRetryable.ShouldBeTrue();
    }

    [Fact]
    public void Falha_de_rede_e_transitoria()
    {
        FailureClassifier.Classify(new SocketException(10061))
            .Category.ShouldBe(FailureCategory.Transitoria);

        FailureClassifier.Classify(new HttpRequestException("Falha ao conectar."))
            .Category.ShouldBe(FailureCategory.Transitoria);
    }

    [Fact]
    public void Cancelamento_nao_e_lido_como_timeout()
    {
        // TaskCanceledException herda de OperationCanceledException, e um
        // desligamento do worker nao e a mesma coisa que uma operacao lenta: o
        // item volta para a fila por caminhos diferentes e o operador nao deveria
        // ver "demorou demais" quando o que houve foi um deploy.
        var d = FailureClassifier.Classify(new TaskCanceledException());

        d.Code.ShouldBe("CANCELADO");
        d.IsRetryable.ShouldBeTrue();
    }

    [Theory]
    [InlineData(typeof(ArgumentException))]
    [InlineData(typeof(FormatException))]
    public void Erro_de_programacao_e_permanente(Type tipo)
    {
        // Retentar apenas repete o mesmo caminho de codigo com os mesmos dados.
        var excecao = (Exception)Activator.CreateInstance(tipo)!;

        var d = FailureClassifier.Classify(excecao);

        d.Category.ShouldBe(FailureCategory.Permanente);
        d.IsRetryable.ShouldBeFalse();
    }

    [Theory]
    [InlineData("deadlock detected", "DEADLOCK", true)]
    [InlineData("could not serialize access due to concurrent update", "CONFLITO_DE_CONCORRENCIA", true)]
    [InlineData("Connection refused (localhost:5432)", "BANCO_INDISPONIVEL", true)]
    [InlineData("sorry, too many clients already", "POOL_ESGOTADO", true)]
    [InlineData("23503: insert or update violates foreign key constraint", "REFERENCIA_INEXISTENTE", false)]
    [InlineData("new row violates check constraint \"ck_valor_positivo\"", "REGRA_DE_NEGOCIO_VIOLADA", false)]
    [InlineData("null value violates not-null constraint", "CAMPO_OBRIGATORIO_AUSENTE", false)]
    [InlineData("numeric field overflow", "VALOR_FORA_DA_FAIXA", false)]
    public void O_texto_do_erro_do_banco_decide_a_categoria(string mensagem, string codigo, bool retentavel)
    {
        var d = FailureClassifier.Classify(new InvalidOperationException(mensagem));

        d.Code.ShouldBe(codigo);
        d.IsRetryable.ShouldBe(retentavel);
    }

    [Fact]
    public void Chave_primaria_nula_do_EF_Core_e_PERMANENTE()
    {
        // Divergência encontrada na stack real, não em teste: um evento sem
        // `id_contrato` era classificado como PERMANENTE pelo backend VINEXT (o
        // Prisma lança `PrismaClientValidationError`) e como DESCONHECIDA pelo
        // .NET, cuja mensagem do EF Core não casava com nenhuma agulha.
        //
        // A consequência era visível: o .NET gastava três tentativas por uma
        // chave que nunca passaria a existir, e o painel mostrava "falha não
        // classificada" em vez de uma ação útil - para a MESMA falha que o outro
        // backend explicava direito.
        var ex = new InvalidOperationException(
            "Unable to track an entity of type 'ContractStatus' because its "
            + "primary key property 'IdContrato' is null.");

        var d = FailureClassifier.Classify(ex);

        d.Category.ShouldBe(FailureCategory.Permanente);
        d.Code.ShouldBe("DADO_INVALIDO");
        d.IsRetryable.ShouldBeFalse();
    }

    [Fact]
    public void A_causa_e_procurada_dentro_dos_ENVELOPES()
    {
        // Duas formas do mesmo mecanismo, num caso so. O Npgsql envelopa o erro
        // do PostgreSQL e codigo assincrono envelopa em AggregateException;
        // olhar so a excecao de fora classificaria tudo como desconhecido.
        var interna = new InvalidOperationException("deadlock detected");
        var externa = new InvalidOperationException("Uma falha ocorreu.", interna);

        FailureClassifier.Classify(externa).Code.ShouldBe("DEADLOCK");
        FailureClassifier.Classify(new AggregateException(new TimeoutException("lento")))
            .Code.ShouldBe("TIMEOUT");
    }

    [Fact]
    public void Uma_causa_desconhecida_e_RETENTADA()
    {
        // A escolha do padrao importa: errar retentando custa uma espera; errar
        // desistindo custa um pagamento que nunca consolidou.
        var d = FailureClassifier.Classify(new InvalidOperationException("algo bem estranho"));

        d.Category.ShouldBe(FailureCategory.Desconhecida);
        d.IsRetryable.ShouldBeTrue();
    }

    [Fact]
    public void O_catalogo_e_consistente_em_toda_entrada()
    {
        // Tres invariantes numa varredura so, porque as tres percorrem a mesma
        // lista e falham pelo mesmo motivo: alguem acrescentou uma entrada sem
        // preencher tudo.
        foreach (var d in FailureCatalog.All)
        {
            // Os dois textos vao direto para o tooltip. Um vazio deixaria o
            // operador diante de uma caixa em branco - pior que nao ter tooltip.
            d.Code.ShouldNotBeNullOrWhiteSpace();
            d.Explanation.ShouldNotBeNullOrWhiteSpace();
            d.SuggestedAction.ShouldNotBeNullOrWhiteSpace();

            // A UI usa `retentavel` para decidir se oferece o botao de
            // reenfileirar. Divergindo da categoria, ofereceria a acao errada.
            d.IsRetryable.ShouldBe(d.Category != FailureCategory.Permanente);
        }

        // Codigos duplicados fariam `Describe` devolver a primeira entrada e
        // esconder a segunda, silenciosamente.
        var codigos = FailureCatalog.All.Select(d => d.Code).ToList();
        codigos.Distinct().Count().ShouldBe(codigos.Count);
    }

    [Fact]
    public void Um_codigo_desconhecido_nao_derruba_a_consulta()
    {
        // Uma versao mais nova pode ter gravado um codigo que esta nao conhece.
        // A consulta de um evento antigo nao pode quebrar o painel por isso.
        var d = FailureCatalog.Describe("CODIGO_QUE_NAO_EXISTE");

        d.Code.ShouldBe(FailureCatalog.NaoClassificado);
    }

}
