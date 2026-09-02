namespace Sabemi.Domain.Processing;

/// <summary>
/// Natureza de uma falha de processamento, e com ela a decisao de retentar.
/// </summary>
/// <remarks>
/// Antes, toda falha era tratada da mesma forma: reagendar ate esgotar as
/// tentativas. Isso e errado nas duas pontas. Um payload com contrato
/// inexistente jamais vai passar - retenta-lo tres vezes so atrasa em minutos a
/// unica coisa util, que e avisar o operador. E uma indisponibilidade de dois
/// segundos do banco nao deveria consumir tentativa alguma.
/// </remarks>
public enum FailureCategory
{
    /// <summary>
    /// A causa e externa e tende a desaparecer sozinha: timeout, conexao
    /// recusada, deadlock, indisponibilidade momentanea. Retenta com backoff.
    /// </summary>
    Transitoria,

    /// <summary>
    /// A causa esta no proprio evento e nao muda com o tempo: dado invalido,
    /// invariante de negocio violada. Retentar so adia o aviso ao operador, e o
    /// item vai direto para falha definitiva sem gastar as tentativas restantes.
    /// </summary>
    Permanente,

    /// <summary>
    /// Nao foi possivel classificar. Trata como transitoria - o custo de
    /// retentar algo permanente e uma espera; o de desistir de algo transitorio
    /// e um pagamento nao consolidado.
    /// </summary>
    Desconhecida
}
