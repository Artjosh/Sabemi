using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Sabemi.Infrastructure.Persistence.Configurations;

/// <summary>
/// Converte um enum para texto MAIUSCULO no banco, e de volta.
/// </summary>
/// <remarks>
/// <b>Por que nao o `HasConversion&lt;string&gt;()` do EF Core.</b> Ele grava o
/// nome do membro como esta escrito no C# - <c>Sucesso</c>, <c>Pendente</c>. O
/// backend VINEXT, que escreve nas MESMAS tabelas, grava <c>SUCESSO</c>: em
/// TypeScript o valor vem do contrato da API, que e maiusculo. O resultado era
/// uma coluna com duas grafias do mesmo estado.
///
/// <b>Por que isso era um bug, e nao um detalhe estetico.</b> O painel filtra por
/// situacao. Um <c>WHERE status_processamento = 'Sucesso'</c> emitido pelo
/// backend .NET simplesmente NAO ENCONTRAVA os eventos que o VINEXT havia
/// processado - e vice-versa. Os contadores por status somavam cada grafia
/// separadamente, e o indice <c>ix_payment_events_status_recebido</c> ficava
/// dividido entre as duas. Nada disso aparecia como erro: as consultas
/// funcionavam e devolviam menos linhas do que deveriam, que e o pior tipo de
/// falha em um painel de conciliacao.
///
/// <b>Por que MAIUSCULO e nao PascalCase.</b> E a grafia que o contrato publico
/// ja usa (<c>status_processamento: "SUCESSO"</c> no OpenAPI). Escolhendo-a como
/// canonica, a leitura nao precisa traduzir nada e um <c>SELECT</c> feito a mao
/// mostra o mesmo valor que a API devolve.
///
/// A migration <c>NormalizaEnumsEmMaiusculas</c> converteu as linhas ja
/// existentes.
/// </remarks>
public static class EnumEmMaiusculas
{
    /// <summary>
    /// Conversor para <typeparamref name="T"/>. A leitura e
    /// <c>ignoreCase: true</c> de proposito: linhas gravadas antes da migration
    /// continuam sendo lidas corretamente, e um valor digitado a mao numa
    /// correcao pontual nao derruba a consulta.
    /// </summary>
    public static ValueConverter<T, string> Para<T>() where T : struct, Enum
        => new(
            valor => valor.ToString().ToUpperInvariant(),
            texto => Enum.Parse<T>(texto, ignoreCase: true));
}
