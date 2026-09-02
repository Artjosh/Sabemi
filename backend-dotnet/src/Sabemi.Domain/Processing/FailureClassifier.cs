using System.Net.Sockets;

namespace Sabemi.Domain.Processing;

/// <summary>
/// Le uma excecao e devolve o diagnostico que decide o retry e alimenta o
/// tooltip do painel.
/// </summary>
/// <remarks>
/// <b>Por que no dominio, e nao na infraestrutura.</b> "Um contrato inexistente
/// nao melhora com a repeticao" e uma regra de negocio, nao um detalhe de
/// persistencia. Ela precisa valer igual nos dois backends, e o backend VINEXT
/// tem a sua traducao literal em <c>server/bff/failure-classifier.ts</c> - as
/// duas listas de codigos sao as mesmas de proposito, porque a UI e uma so.
///
/// <b>Por que por tipo e por texto.</b> O ideal seria classificar so pelo tipo
/// da excecao. Na pratica o Npgsql envelopa o <c>SqlState</c> do PostgreSQL e
/// varias bibliotecas so trazem a causa na mensagem; ignorar o texto deixaria
/// quase tudo em <see cref="FailureCategory.Desconhecida"/>. O tipo vem
/// primeiro, e o texto so decide o que o tipo nao resolveu.
///
/// <b>Por que o padrao e retentar.</b> Uma causa nao reconhecida cai em
/// <see cref="FailureCategory.Desconhecida"/>, que retenta. Errar retentando
/// custa uma espera; errar desistindo custa um pagamento que nunca consolidou.
/// </remarks>
public static class FailureClassifier
{
    /// <summary>Classifica a excecao, desembrulhando agregados e envelopes.</summary>
    public static FailureDiagnosis Classify(Exception excecao)
    {
        ArgumentNullException.ThrowIfNull(excecao);

        var raiz = Unwrap(excecao);

        // 1) O tipo, quando ele proprio ja diz o suficiente.
        //
        // OperationCanceledException vem antes das demais porque
        // TaskCanceledException herda dela E de nada mais relevante aqui; o
        // cancelamento de desligamento nao deve ser lido como timeout.
        if (raiz is OperationCanceledException)
        {
            return FailureCatalog.Describe("CANCELADO");
        }

        if (raiz is TimeoutException)
        {
            return FailureCatalog.Describe("TIMEOUT");
        }

        if (raiz is SocketException or HttpRequestException)
        {
            return FailureCatalog.Describe("REDE_INDISPONIVEL");
        }

        // Erros de programacao. Retentar apenas repete o mesmo caminho de codigo.
        if (raiz is ArgumentException or FormatException or InvalidCastException
                 or NotSupportedException or NullReferenceException or IndexOutOfRangeException)
        {
            return FailureCatalog.Describe("DADO_INVALIDO");
        }

        // 2) O texto, para o que o tipo nao resolveu - inclusive o SqlState que o
        //    Npgsql traz embrulhado na excecao interna.
        var texto = TextoCompleto(excecao);

        foreach (var (agulha, codigo) in PorTexto)
        {
            if (texto.Contains(agulha, StringComparison.OrdinalIgnoreCase))
            {
                return FailureCatalog.Describe(codigo);
            }
        }

        return FailureCatalog.Describe(FailureCatalog.NaoClassificado);
    }

    /// <summary>
    /// Agulhas de texto, da mais especifica para a mais generica. A ordem
    /// importa: "statement timeout" tambem casaria com uma regra generica de
    /// "timeout", e uma mensagem de deadlock costuma mencionar "connection".
    /// </summary>
    private static readonly (string Agulha, string Codigo)[] PorTexto =
    [
        // transitorias de banco
        ("deadlock", "DEADLOCK"),
        ("could not serialize", "CONFLITO_DE_CONCORRENCIA"),
        ("connection refused", "BANCO_INDISPONIVEL"),
        ("no connection could be made", "BANCO_INDISPONIVEL"),
        ("too many clients", "POOL_ESGOTADO"),
        ("timeout", "TIMEOUT"),

        // permanentes
        ("violates foreign key", "REFERENCIA_INEXISTENTE"),
        ("violates check constraint", "REGRA_DE_NEGOCIO_VIOLADA"),
        ("violates not-null", "CAMPO_OBRIGATORIO_AUSENTE"),
        ("numeric field overflow", "VALOR_FORA_DA_FAIXA"),
    ];

    /// <summary>
    /// Desembrulha ate a causa concreta. Um <see cref="AggregateException"/> de
    /// codigo assincrono, ou uma excecao de infraestrutura envelopando a real,
    /// esconderiam o tipo que interessa.
    /// </summary>
    private static Exception Unwrap(Exception excecao)
    {
        if (excecao is AggregateException agregada)
        {
            var achatada = agregada.Flatten();
            return achatada.InnerExceptions.Count > 0
                ? Unwrap(achatada.InnerExceptions[0])
                : achatada;
        }

        return excecao.InnerException is { } interna ? Unwrap(interna) : excecao;
    }

    /// <summary>
    /// Concatena as mensagens da cadeia inteira. O Npgsql poe o detalhe do
    /// PostgreSQL na excecao interna; olhar so a de fora perderia o SqlState.
    /// </summary>
    private static string TextoCompleto(Exception excecao)
    {
        var partes = new List<string>();

        for (var atual = excecao; atual is not null; atual = atual.InnerException)
        {
            partes.Add(atual.Message);

            if (atual is AggregateException agregada)
            {
                partes.AddRange(agregada.Flatten().InnerExceptions.Select(e => e.Message));
            }
        }

        return string.Join(" | ", partes);
    }
}
