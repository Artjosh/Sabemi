using Microsoft.Extensions.Configuration;
using Npgsql;

namespace Sabemi.Infrastructure.Persistence;

/// <summary>
/// Resolve a conexão do PostgreSQL a partir de UMA variável de ambiente,
/// aceitando tanto o formato URL quanto o formato chave=valor do Npgsql.
/// </summary>
/// <remarks>
/// <b>O problema que isto resolve.</b> Os dois backends compartilham o mesmo
/// banco, mas liam a conexão de variáveis diferentes e em formatos diferentes: o
/// VINEXT usava <c>DATABASE_URL</c> (uma URL <c>postgresql://…</c>, que é o que o
/// Supabase entrega ao copiar as credenciais), e o .NET usava
/// <c>ConnectionStrings__Postgres</c> (<c>Host=…;Port=…;Username=…</c>). Apontar
/// a stack para um Supabase remoto exigia editar duas variáveis, transcrevendo à
/// mão a mesma informação em duas sintaxes - e um erro de transcrição só
/// apareceria como falha de autenticação em um dos backends.
///
/// Agora <c>DATABASE_URL</c> serve aos dois, e trocar de local para remoto é
/// trocar uma linha.
///
/// <b>Ordem de precedência: <c>DATABASE_URL</c> VENCE.</b> E isso importa. O
/// <c>appsettings.json</c> é versionado e traz uma <c>ConnectionStrings:Postgres</c>
/// apontando para o Postgres de desenvolvimento; o <c>IConfiguration</c> não
/// distingue "veio do arquivo" de "veio do ambiente", então dar precedência à
/// forma nativa faria o valor do ARQUIVO vencer a variável do container - foi
/// exatamente o que aconteceu: a API subiu tentando <c>localhost:5432</c> dentro
/// do container e morreu com "Connection refused", ignorando a
/// <c>DATABASE_URL</c> que o Compose havia passado.
///
/// <c>ConnectionStrings:Postgres</c> continua servindo a quem precisa de um
/// parâmetro do Npgsql que não cabe numa URL (um <c>Timeout</c> específico, um
/// certificado de cliente): basta NÃO definir <c>DATABASE_URL</c>.
///
/// <b>SSL.</b> Um Supabase remoto exige TLS. Como a URL que ele fornece traz
/// <c>?sslmode=require</c>, o parâmetro é traduzido; e quando o host NÃO é local,
/// o SSL é exigido mesmo sem o parâmetro - é mais seguro falhar pedindo TLS do
/// que conectar em claro pela internet por causa de uma URL incompleta.
/// </remarks>
public static class PostgresConnectionString
{
    /// <summary>Nome da variável única, igual nos dois backends.</summary>
    public const string VariavelDeAmbiente = "DATABASE_URL";

    /// <summary>
    /// Devolve a connection string do Npgsql, ou <c>null</c> se nada foi
    /// configurado - quem chama decide a mensagem de erro.
    /// </summary>
    public static string? Resolver(IConfiguration configuracao)
    {
        var bruta = configuracao[VariavelDeAmbiente];

        if (!string.IsNullOrWhiteSpace(bruta))
        {
            // Aceita os dois formatos na MESMA variável. Sem isto, quem já tinha
            // uma connection string nativa exportada como DATABASE_URL veria um
            // erro de "URL inválida" sem entender por quê.
            return ParecerUrl(bruta) ? DeUrl(bruta) : bruta;
        }

        // Só quando não há DATABASE_URL - ver a nota de precedência acima.
        var nativa = configuracao.GetConnectionString("Postgres");
        return string.IsNullOrWhiteSpace(nativa) ? null : nativa;
    }

    /// <summary>
    /// A string parece uma URL de conexão? Os dois esquemas são aceitos pelo
    /// PostgreSQL e ambos aparecem no painel do Supabase.
    /// </summary>
    private static bool ParecerUrl(string valor)
        => valor.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase)
        || valor.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase);

    /// <summary>Traduz <c>postgresql://usuario:senha@host:porta/banco?params</c>.</summary>
    private static string DeUrl(string bruta)
    {
        Uri url;
        try
        {
            url = new Uri(bruta);
        }
        catch (UriFormatException ex)
        {
            throw new InvalidOperationException(
                $"{VariavelDeAmbiente} não é uma URL válida. "
                + "Use postgresql://usuario:senha@host:porta/banco", ex);
        }

        var partes = url.UserInfo.Split(':', 2);

        // `Uri.UnescapeDataString`: uma senha com caractere especial chega
        // percent-encoded na URL, e o Supabase gera senhas assim. Passá-la sem
        // decodificar produz uma falha de autenticação que parece credencial
        // errada.
        var usuario = Uri.UnescapeDataString(partes[0]);
        var senha = partes.Length > 1 ? Uri.UnescapeDataString(partes[1]) : string.Empty;

        if (string.IsNullOrWhiteSpace(usuario))
        {
            throw new InvalidOperationException(
                $"{VariavelDeAmbiente} sem usuário. "
                + "Use postgresql://usuario:senha@host:porta/banco");
        }

        var construtor = new NpgsqlConnectionStringBuilder
        {
            Host = url.Host,
            Port = url.IsDefaultPort ? 5432 : url.Port,
            Database = url.AbsolutePath.Trim('/') is { Length: > 0 } db ? db : "postgres",
            Username = usuario,
            Password = senha,

            // Identifica as conexões deste backend em `pg_stat_activity`. Com dois
            // backends no mesmo banco, é o que permite saber de quem é cada
            // conexão ao investigar uma consulta lenta ou um lock.
            ApplicationName = "sabemi-dotnet",
        };

        var parametros = System.Web.HttpUtility.ParseQueryString(url.Query);

        // `search_path` NÃO é lido da URL de propósito. O EF Core qualifica toda
        // tabela com o schema do modelo, e o único lugar que precisa de
        // qualificação explícita (o SQL bruto da fila) já traz a constante. Ler o
        // parâmetro daqui daria a impressão de que trocá-lo muda o schema usado -
        // não muda.
        var sslmode = parametros["sslmode"];
        var hostLocal = url.Host is "localhost" or "127.0.0.1" or "::1"
            // Nomes de serviço do Compose: dentro da rede do Docker o tráfego não
            // sai da máquina, e exigir TLS de um Postgres local sem certificado
            // impediria a stack de subir.
            || url.Host is "postgres" or "db" or "supabase-db";

        construtor.SslMode = sslmode?.ToLowerInvariant() switch
        {
            "disable" => SslMode.Disable,
            "allow" => SslMode.Allow,
            "prefer" => SslMode.Prefer,
            "require" => SslMode.Require,
            "verify-ca" => SslMode.VerifyCA,
            "verify-full" => SslMode.VerifyFull,

            // Sem `sslmode` na URL: exige TLS fora da máquina local. Falhar
            // pedindo TLS é melhor do que trafegar credenciais em claro pela
            // internet por causa de uma URL incompleta.
            _ => hostLocal ? SslMode.Prefer : SslMode.Require,
        };

        // `Require` sem `verify-*` significa "criptografe, mas não valide a
        // cadeia". O Supabase usa um certificado assinado por uma CA que não está
        // no trust store padrão da imagem, e sem isto a conexão falha com
        // "remote certificate is invalid". Para validar de verdade, use
        // `sslmode=verify-full` e monte o certificado da CA no container.
        if (construtor.SslMode == SslMode.Require)
        {
            construtor.TrustServerCertificate = true;
        }

        return construtor.ToString();
    }
}
