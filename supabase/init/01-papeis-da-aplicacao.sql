-- =============================================================================
-- Papeis e schema da aplicacao, sobre o PostgreSQL do Supabase.
--
-- A imagem `supabase/postgres` ja traz os papeis da PLATAFORMA (anon,
-- authenticated, service_role, authenticator, supabase_admin,
-- supabase_auth_admin). O que falta e o que a NOSSA aplicacao precisa:
--
--   1. um papel proprio para os backends, em vez de usarem `postgres`;
--   2. o schema `sabemi`, compartilhado pelos dois backends;
--   3. permissao para o PostgREST enxergar esse schema (o Studio depende).
--
-- Roda uma unica vez, na primeira criacao do volume.
-- =============================================================================

-- ---------------------------------------------------------------- papel
-- Os backends nao usam `postgres` nem `supabase_admin`: um papel proprio
-- permite revogar ou auditar o acesso da aplicacao sem tocar na plataforma.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sabemi_app') THEN
    -- A senha vem do ambiente na criacao do container; aqui fica o padrao de
    -- desenvolvimento, que o compose de producao sobrescreve.
    CREATE ROLE sabemi_app WITH LOGIN PASSWORD 'sabemi' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- ---------------------------------------------------------------- schema
-- UM schema para os DOIS backends.
--
-- Esta e a decisao que permite trocar de backend sem perder os dados nem
-- refazer o login: os dois enxergam as mesmas tabelas e os mesmos usuarios.
-- O EF Core e dono das migrations; o Prisma introspecta o resultado. Ver
-- docs/APRESENTACAO.md.
CREATE SCHEMA IF NOT EXISTS sabemi AUTHORIZATION sabemi_app;

GRANT USAGE ON SCHEMA sabemi TO sabemi_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA sabemi TO sabemi_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA sabemi TO sabemi_app;

-- Tabelas criadas depois (pelas migrations) herdam as permissoes.
ALTER DEFAULT PRIVILEGES IN SCHEMA sabemi
  GRANT ALL PRIVILEGES ON TABLES TO sabemi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA sabemi
  GRANT ALL PRIVILEGES ON SEQUENCES TO sabemi_app;

-- ------------------------------------------------------------ plataforma
-- O PostgREST (e portanto o Studio) precisa enxergar o schema para listar as
-- tabelas. Somente leitura: a aplicacao escreve pelos seus proprios backends,
-- nunca pela API REST.
GRANT USAGE ON SCHEMA sabemi TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA sabemi
  GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA sabemi
  GRANT ALL ON TABLES TO service_role;

-- O papel da aplicacao tambem cria o proprio banco de teste em
-- desenvolvimento (ver frontend/scripts/setup-test-db.mjs).
ALTER ROLE sabemi_app CREATEDB;
