using Sabemi.Application.Abstractions;

namespace Sabemi.UnitTests.Support;

/// <summary>
/// Relógio fixo para os testes de unidade.
/// </summary>
/// <remarks>
/// <b>Por que não reusar o <c>FakeClock</c> dos testes de integração.</b> Ele vive
/// em <c>Sabemi.IntegrationTests</c>, e um projeto de teste referenciar outro
/// projeto de teste inverteria a dependência: os testes de unidade passariam a
/// precisar do Testcontainers e do PostgreSQL para compilar - justamente o que
/// eles existem para evitar.
///
/// Extrair um projeto <c>Sabemi.TestSupport</c> resolveria a duplicação, mas
/// seria um projeto inteiro para carregar seis linhas. Quando o suporte
/// compartilhado crescer, o projeto se justifica; hoje, não.
/// </remarks>
internal sealed class RelogioParado(DateTimeOffset agora) : IClock
{
    public DateTimeOffset UtcNow { get; private set; } = agora;

    public void Avancar(TimeSpan quanto) => UtcNow = UtcNow.Add(quanto);
}
