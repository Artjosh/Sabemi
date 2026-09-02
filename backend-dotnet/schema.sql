DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'sabemi') THEN
        CREATE SCHEMA sabemi;
    END IF;
END $EF$;
CREATE TABLE IF NOT EXISTS sabemi."__EFMigrationsHistory" (
    "MigrationId" character varying(150) NOT NULL,
    "ProductVersion" character varying(32) NOT NULL,
    CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY ("MigrationId")
);

START TRANSACTION;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
        IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'sabemi') THEN
            CREATE SCHEMA sabemi;
        END IF;
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE TABLE sabemi.contract_statuses (
        id_contrato character varying(128) NOT NULL,
        valor_total_liquidado numeric(18,2) NOT NULL,
        pagamentos_confirmados integer NOT NULL,
        ultimo_pagamento_em timestamp with time zone,
        ultima_transacao character varying(128),
        situacao character varying(16) NOT NULL,
        atualizado_em timestamp with time zone NOT NULL,
        CONSTRAINT "PK_contract_statuses" PRIMARY KEY (id_contrato)
    );
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE TABLE sabemi.login_requests (
        id uuid NOT NULL,
        selector character varying(64) NOT NULL,
        magic_token_hash character varying(64),
        otp_code_hash character varying(64),
        otp_tentativas integer NOT NULL,
        email character varying(255) NOT NULL,
        status character varying(16) NOT NULL,
        criado_em timestamp with time zone NOT NULL,
        expira_em timestamp with time zone NOT NULL,
        CONSTRAINT "PK_login_requests" PRIMARY KEY (id)
    );
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE TABLE sabemi.payment_events (
        id uuid NOT NULL,
        id_transacao character varying(128) NOT NULL,
        id_contrato character varying(128),
        valor numeric(18,2),
        data_pagamento timestamp with time zone,
        status_origem character varying(32),
        status_processamento character varying(16) NOT NULL,
        erro text,
        payload_bruto jsonb NOT NULL,
        assinatura_verificada boolean NOT NULL,
        recebido_em timestamp with time zone NOT NULL,
        processado_em timestamp with time zone,
        tentativas integer NOT NULL,
        CONSTRAINT "PK_payment_events" PRIMARY KEY (id)
    );
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE TABLE sabemi.users (
        id uuid NOT NULL,
        email character varying(255) NOT NULL,
        criado_em timestamp with time zone NOT NULL,
        CONSTRAINT "PK_users" PRIMARY KEY (id)
    );
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE TABLE sabemi.processing_jobs (
        id uuid NOT NULL,
        payment_event_id uuid NOT NULL,
        estado character varying(16) NOT NULL,
        tentativas integer NOT NULL,
        max_tentativas integer NOT NULL,
        disponivel_em timestamp with time zone NOT NULL,
        reivindicado_em timestamp with time zone,
        reivindicado_por character varying(128),
        ultimo_erro text,
        criado_em timestamp with time zone NOT NULL,
        atualizado_em timestamp with time zone NOT NULL,
        CONSTRAINT "PK_processing_jobs" PRIMARY KEY (id),
        CONSTRAINT "FK_processing_jobs_payment_events_payment_event_id" FOREIGN KEY (payment_event_id) REFERENCES sabemi.payment_events (id) ON DELETE CASCADE
    );
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE INDEX ix_login_requests_email ON sabemi.login_requests (email);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE INDEX ix_login_requests_expira_em ON sabemi.login_requests (expira_em);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE UNIQUE INDEX ux_login_requests_magic_token_hash ON sabemi.login_requests (magic_token_hash);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE UNIQUE INDEX ux_login_requests_selector ON sabemi.login_requests (selector);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE INDEX ix_payment_events_id_contrato ON sabemi.payment_events (id_contrato);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE INDEX ix_payment_events_status_recebido ON sabemi.payment_events (status_processamento, recebido_em);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE UNIQUE INDEX ux_payment_events_id_transacao ON sabemi.payment_events (id_transacao);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE INDEX ix_processing_jobs_estado_disponivel ON sabemi.processing_jobs (estado, disponivel_em);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE UNIQUE INDEX ux_processing_jobs_payment_event_id ON sabemi.processing_jobs (payment_event_id);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    CREATE UNIQUE INDEX ux_users_email ON sabemi.users (email);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902012617_SchemaCompartilhado') THEN
    INSERT INTO sabemi."__EFMigrationsHistory" ("MigrationId", "ProductVersion")
    VALUES ('20260902012617_SchemaCompartilhado', '10.0.11');
    END IF;
END $EF$;
COMMIT;

START TRANSACTION;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902023944_DiagnosticoDeFalha') THEN
    ALTER TABLE sabemi.payment_events ADD erro_categoria character varying(16);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902023944_DiagnosticoDeFalha') THEN
    ALTER TABLE sabemi.payment_events ADD erro_codigo character varying(48);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902023944_DiagnosticoDeFalha') THEN
    CREATE INDEX ix_payment_events_erro_categoria ON sabemi.payment_events (erro_categoria) WHERE erro_categoria IS NOT NULL;
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902023944_DiagnosticoDeFalha') THEN
    INSERT INTO sabemi."__EFMigrationsHistory" ("MigrationId", "ProductVersion")
    VALUES ('20260902023944_DiagnosticoDeFalha', '10.0.11');
    END IF;
END $EF$;
COMMIT;

START TRANSACTION;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902024908_NormalizaEnumsEmMaiusculas') THEN
    UPDATE sabemi.payment_events
       SET status_processamento = upper(status_processamento)
     WHERE status_processamento IS NOT NULL
       AND status_processamento <> upper(status_processamento);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902024908_NormalizaEnumsEmMaiusculas') THEN
    UPDATE sabemi.payment_events
       SET erro_categoria = upper(erro_categoria)
     WHERE erro_categoria IS NOT NULL
       AND erro_categoria <> upper(erro_categoria);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902024908_NormalizaEnumsEmMaiusculas') THEN
    UPDATE sabemi.contract_statuses
       SET situacao = upper(situacao)
     WHERE situacao IS NOT NULL
       AND situacao <> upper(situacao);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902024908_NormalizaEnumsEmMaiusculas') THEN
    UPDATE sabemi.processing_jobs
       SET estado = upper(estado)
     WHERE estado IS NOT NULL
       AND estado <> upper(estado);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902024908_NormalizaEnumsEmMaiusculas') THEN
    UPDATE sabemi.login_requests
       SET status = upper(status)
     WHERE status IS NOT NULL
       AND status <> upper(status);
    END IF;
END $EF$;

DO $EF$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM sabemi."__EFMigrationsHistory" WHERE "MigrationId" = '20260902024908_NormalizaEnumsEmMaiusculas') THEN
    INSERT INTO sabemi."__EFMigrationsHistory" ("MigrationId", "ProductVersion")
    VALUES ('20260902024908_NormalizaEnumsEmMaiusculas', '10.0.11');
    END IF;
END $EF$;
COMMIT;

