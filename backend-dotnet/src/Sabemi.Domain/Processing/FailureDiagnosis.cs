namespace Sabemi.Domain.Processing;

/// <summary>
/// Leitura de uma falha: o que aconteceu, se vale retentar, e o que dizer a
/// quem opera o painel.
/// </summary>
/// <param name="Category">Decide o retry - ver <see cref="FailureCategory"/>.</param>
/// <param name="Code">
/// Identificador estavel da causa (<c>BANCO_INDISPONIVEL</c>,
/// <c>CONTRATO_INVALIDO</c>...). E o que a UI usa para escolher o texto e o
/// icone, e o que permite agrupar falhas em uma metrica sem depender da
/// mensagem crua da excecao, que muda entre versoes de biblioteca.
/// </param>
/// <param name="Explanation">
/// Uma frase, em portugues, dizendo ao operador o que deu errado - sem stack
/// trace e sem jargao de exececao. Vai para o tooltip do dashboard.
/// </param>
/// <param name="SuggestedAction">
/// O que a pessoa pode fazer. Tambem no tooltip, logo abaixo da explicacao.
/// </param>
public readonly record struct FailureDiagnosis(
    FailureCategory Category,
    string Code,
    string Explanation,
    string SuggestedAction)
{
    /// <summary>
    /// Retentar automaticamente faz sentido para esta falha? Uma causa
    /// permanente nao melhora com a repeticao.
    /// </summary>
    public bool IsRetryable => Category != FailureCategory.Permanente;
}
