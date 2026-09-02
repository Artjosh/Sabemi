-- =============================================================================
-- Papeis da plataforma Supabase.
--
-- POR QUE ESTE ARQUIVO EXISTE
-- ---------------------------
-- A imagem `supabase/postgres` NAO traz estes papeis prontos - ao contrario do
-- que a documentacao sugere. Quem os cria e um script de init montado pelo
-- docker-compose oficial da plataforma. Sem eles, o GoTrue e o PostgREST sobem
-- e falham na primeira conexao, com "role does not exist".
--
-- Roda antes de `01-papeis-da-aplicacao.sql` (a ordem alfabetica define a
-- execucao no initdb).
--
-- Referencia: supabase/docker/volumes/db/roles.sql do repositorio oficial.
-- =============================================================================

-- ------------------------------------------------------- supabase_admin
-- Precisa vir PRIMEIRO. A imagem `supabase/postgres` instala event triggers
-- que reatribuem o dono de toda extensao criada para `supabase_admin`; sem o
-- papel, um `CREATE EXTENSION` falha com "role supabase_admin does not exist"
-- e o initdb inteiro aborta.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS
      PASSWORD 'postgres';
  END IF;
END
$$;

-- ----------------------------------------------------------------- anon
-- A identidade publica: e o papel assumido por quem chega com a `anon key`.
-- NOINHERIT de proposito - nao deve acumular privilegios de outros papeis.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- -------------------------------------------------------- authenticated
-- Quem apresentou um JWT valido do GoTrue.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- --------------------------------------------------------- service_role
-- Ignora Row Level Security. E a chave que NUNCA deve chegar ao navegador.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- --------------------------------------------------------- authenticator
-- O papel com que o PostgREST conecta. Ele nao tem privilegio proprio: a cada
-- requisicao troca para `anon` ou `authenticated` conforme o token
-- apresentado. E o mecanismo que sustenta a autorizacao do PostgREST.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'postgres';
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;

-- --------------------------------------------------- supabase_auth_admin
-- Dono do schema `auth`. O GoTrue conecta com ele e cria as proprias tabelas
-- na primeira subida (usuarios, sessoes, tokens de recuperacao).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE PASSWORD 'postgres';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;

GRANT ALL PRIVILEGES ON SCHEMA auth TO supabase_auth_admin;

-- O GoTrue precisa de pgcrypto e uuid-ossp para gerar identificadores e hashes.
--
-- As extensoes vao para um schema `extensions` proprio, e nao para o `public`:
-- e a convencao do Supabase e evita que funcoes de extensao colidam com as da
-- aplicacao. O schema e criado aqui porque a imagem nao o traz - assim como nao
-- traz os papeis acima.
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- Os papeis da plataforma precisam enxergar as extensoes.
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role, supabase_auth_admin;

-- O `search_path` do GoTrue inclui `extensions` para ele encontrar `gen_salt` e
-- `uuid_generate_v4` sem qualificar cada chamada.
ALTER ROLE supabase_auth_admin SET search_path = auth, extensions;
