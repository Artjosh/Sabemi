using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Sabemi.Infrastructure.Migrations
{
    /// <summary>
    /// Uniformiza em MAIUSCULAS os enums gravados como texto.
    /// </summary>
    /// <remarks>
    /// <para><b>O bug.</b> Os dois backends escrevem nas mesmas tabelas. O EF Core
    /// gravava o nome do membro do enum como esta no C# (<c>Sucesso</c>); o
    /// backend VINEXT gravava o valor do contrato da API (<c>SUCESSO</c>). A
    /// coluna passou a conter duas grafias do mesmo estado.</para>
    ///
    /// <para><b>Por que importava.</b> O painel filtra por situacao. Um
    /// <c>WHERE status_processamento = 'Sucesso'</c> emitido pelo .NET nao
    /// encontrava os eventos processados pelo VINEXT, e vice-versa; os contadores
    /// por status somavam cada grafia separadamente. As consultas nao davam erro -
    /// devolviam menos linhas do que deviam, que e o pior tipo de falha em um
    /// painel de conciliacao.</para>
    ///
    /// <para><b>Por que MAIUSCULO.</b> E a grafia que o contrato publico ja usa.
    /// Adotando-a, a leitura nao traduz nada e um SELECT feito a mao mostra o
    /// mesmo valor que a API devolve. Daqui em diante quem garante a escrita e o
    /// <c>EnumEmMaiusculas</c>, no mapeamento.</para>
    ///
    /// <para><b>Sem alteracao de schema.</b> So os dados mudam - por isso o EF
    /// gerou uma migration vazia e o corpo foi escrito a mao.</para>
    /// </remarks>
    public partial class NormalizaEnumsEmMaiusculas : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // `WHERE valor <> upper(valor)` para nao reescrever linha alguma que
            // ja esteja correta: em uma tabela grande, um UPDATE incondicional
            // criaria uma nova versao de cada tupla e um pico de I/O sem motivo.
            foreach (var (tabela, coluna) in new[]
            {
                ("payment_events", "status_processamento"),
                ("payment_events", "erro_categoria"),
                ("contract_statuses", "situacao"),
                ("processing_jobs", "estado"),
                ("login_requests", "status"),
            })
            {
                migrationBuilder.Sql(
                    $"""
                     UPDATE sabemi.{tabela}
                        SET {coluna} = upper({coluna})
                      WHERE {coluna} IS NOT NULL
                        AND {coluna} <> upper({coluna});
                     """);
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Sem reversao, deliberadamente. Voltar para PascalCase exigiria
            // saber a grafia exata de cada membro do enum (`Inadimplente`, nao
            // `INADIMPLENTE`), e um `initcap()` erraria em qualquer nome composto
            // que viesse a existir - `NaoClassificado` viraria `Naoclassificado`.
            //
            // Escrever uma reversao que corrompe dados e pior do que nao ter
            // reversao: quem precisar desfazer isto deve restaurar de backup, e o
            // caminho seguro e o `Up` ser idempotente (ele e).
        }
    }
}
