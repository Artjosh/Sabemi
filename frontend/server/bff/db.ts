import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * Cliente Prisma do backend VINEXT.
 *
 * <b>Adapter explicito.</b> No Prisma 7 o cliente nao le mais a URL do schema:
 * a conexao chega por um driver adapter. Aqui e o `pg` nativo, que roda em
 * Node - o alvo de deploy escolhido para este projeto.
 *
 * <b>Campos explicitos, e a query string DESCARTADA.</b> A URL e desmontada
 * aqui e so os campos de conexao vao para o adapter. Isso nao e preciosismo -
 * custou horas de diagnostico:
 *
 * Com `?schema=sabemi` na URL, o driver tentava autenticar com o usuario
 * `sabemi` (o valor do parametro!) em vez de `sabemi_app`. O erro dizia
 * `password authentication failed for user "sabemi"` enquanto o ambiente trazia
 * `sabemi_app`, e a mensagem apontava para credenciais quando a causa era o
 * parser da URL. Trocando o schema por outro nome, o "usuario" do erro mudava
 * junto - foi assim que ficou visivel.
 *
 * <b>E o schema, entao?</b> Nao e necessario na conexao. O Prisma qualifica
 * toda tabela com o `@@schema` declarado no modelo, gerando
 * `"sabemi"."payment_events"`. Quem precisa de qualificacao explicita e apenas
 * o SQL bruto da fila, e ele ja traz a constante (ver processing-service.ts).
 *
 * <b>Singleton.</b> Em desenvolvimento o HMR reavalia modulos a cada alteracao.
 * Sem guardar a instancia em `globalThis`, cada recarga abriria um novo pool de
 * conexoes e o PostgreSQL rejeitaria novas conexoes depois de alguns minutos -
 * um erro que aparece como "too many clients" e parece nao ter causa.
 */

const globalForPrisma = globalThis as unknown as {
  __sabemiPrisma?: PrismaClient;
};

/** Configuracao de conexao, desmontada da `DATABASE_URL`. */
interface ConexaoPostgres {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  ssl: false | { rejectUnauthorized: boolean };
}

/** Hosts que sao o Postgres desta stack, e nao um banco gerenciado. */
const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

/**
 * Decide se a conexao usa TLS.
 *
 * <b>Por que nao basta descartar a query string.</b> O comentario do topo
 * explica por que os campos de IDENTIDADE (usuario, senha, host, porta, banco)
 * sao lidos um a um e o resto da URL e ignorado. Mas `sslmode` nao e um campo de
 * identidade: e a unica parte da query string que muda se a conexao funciona ou
 * nao. Ignorando-a, o adapter conecta em texto claro, e qualquer Postgres
 * gerenciado (Supabase, RDS, Neon) recusa - com uma mensagem sobre a conexao ter
 * sido encerrada, que nao menciona TLS.
 *
 * O padrao segue o host, e nao a ausencia do parametro: o Postgres desta stack
 * roda em rede interna do Docker e nao tem certificado, enquanto um host remoto
 * sempre precisa de TLS. Assim a mesma `DATABASE_URL` de sempre continua
 * funcionando local, e uma URL do Supabase funciona sem configuracao extra.
 *
 * O nivel de verificacao segue o libpq, nao o `pg` - ver o comentario dentro da
 * funcao.
 */
function lerSsl(url: URL): false | { rejectUnauthorized: boolean } {
  const modo = url.searchParams.get("sslmode");

  if (modo === "disable") return false;
  if (!modo && HOSTS_LOCAIS.has(url.hostname)) return false;

  // `require` CIFRA mas NAO valida a cadeia do certificado - e a semantica do
  // libpq, a mesma que o Npgsql aplica no backend .NET. Ela existe por um motivo
  // pratico: o pooler do Supabase apresenta um certificado assinado pela CA
  // deles, que nao esta no bundle do sistema.
  //
  // Isto NAO e detalhe de configuracao. O driver `pg` trata `require` como
  // `verify-full` (ele mesmo avisa no log), e o resultado e
  // `self-signed certificate in certificate chain` - um erro que fala de
  // certificado quando a URL pedia apenas conexao cifrada. Custou um deploy
  // inteiro: o entrypoint ficava repetindo "schema ainda nao pronto" porque a
  // sonda dele falhava na conexao, nao no schema.
  //
  // Quem quiser validacao real pede `verify-full` (ou `verify-ca`)
  // explicitamente na URL - e ai o comportamento e o do nome.
  const validar = modo === "verify-full" || modo === "verify-ca";
  return { rejectUnauthorized: validar };
}

function lerConexao(): ConexaoPostgres {
  const bruta = process.env.DATABASE_URL;

  if (!bruta) {
    throw new Error(
      "DATABASE_URL nao configurada. O backend VINEXT precisa dela para acessar o schema da aplicacao.",
    );
  }

  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    throw new Error("DATABASE_URL nao e uma URL valida.");
  }

  // `decodeURIComponent`: senha com caractere especial chega percent-encoded na
  // URL e precisa ser decodificada antes de ir para o driver.
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  if (!user) {
    throw new Error(
      "DATABASE_URL sem usuario. Use postgresql://usuario:senha@host:porta/banco",
    );
  }

  // A query string e ignorada, com uma excecao: `sslmode`. Ver `lerSsl`.
  return {
    user,
    password,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//, "") || "postgres",
    ssl: lerSsl(url),
  };
}

function createClient(): PrismaClient {
  const conexao = lerConexao();

  const adapter = new PrismaPg({
    user: conexao.user,
    password: conexao.password,
    host: conexao.host,
    port: conexao.port,
    database: conexao.database,
    ssl: conexao.ssl,

    // Identifica as conexoes deste backend em `pg_stat_activity`. Com dois
    // backends no mesmo banco, e o que permite saber de quem e cada conexao ao
    // investigar uma consulta lenta ou um lock.
    application_name: "sabemi-bff",
  });

  return new PrismaClient({
    adapter,
    // Em desenvolvimento, avisos e erros do banco no console poupam muito tempo
    // de diagnostico. Em producao, o log estruturado do host ja cobre isso.
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.__sabemiPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__sabemiPrisma = prisma;
}
