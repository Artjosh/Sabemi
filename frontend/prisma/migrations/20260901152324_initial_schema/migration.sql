-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDENTE', 'PROCESSANDO', 'SUCESSO', 'ERRO', 'INVALIDO', 'DUPLICADO');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'FALHOU');

-- CreateEnum
CREATE TYPE "ContractSituation" AS ENUM ('ATIVO', 'LIQUIDADO', 'INADIMPLENTE');

-- CreateEnum
CREATE TYPE "LoginRequestStatus" AS ENUM ('PENDENTE', 'APROVADO');

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "id_transacao" VARCHAR(128) NOT NULL,
    "id_contrato" VARCHAR(128),
    "valor" DECIMAL(18,2),
    "data_pagamento" TIMESTAMPTZ,
    "status_origem" VARCHAR(32),
    "status_processamento" "ProcessingStatus" NOT NULL DEFAULT 'PENDENTE',
    "erro" TEXT,
    "payload_bruto" JSONB NOT NULL,
    "assinatura_verificada" BOOLEAN NOT NULL DEFAULT false,
    "recebido_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processado_em" TIMESTAMPTZ,
    "tentativas" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_statuses" (
    "id_contrato" VARCHAR(128) NOT NULL,
    "valor_total_liquidado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pagamentos_confirmados" INTEGER NOT NULL DEFAULT 0,
    "ultimo_pagamento_em" TIMESTAMPTZ,
    "ultima_transacao" VARCHAR(128),
    "situacao" "ContractSituation" NOT NULL DEFAULT 'ATIVO',
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contract_statuses_pkey" PRIMARY KEY ("id_contrato")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" TEXT NOT NULL,
    "payment_event_id" TEXT NOT NULL,
    "estado" "JobState" NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "max_tentativas" INTEGER NOT NULL DEFAULT 3,
    "disponivel_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reivindicado_em" TIMESTAMPTZ,
    "reivindicado_por" VARCHAR(128),
    "ultimo_erro" TEXT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_requests" (
    "id" TEXT NOT NULL,
    "selector" VARCHAR(64) NOT NULL,
    "magic_token_hash" VARCHAR(64),
    "otp_code_hash" VARCHAR(64),
    "otp_tentativas" INTEGER NOT NULL DEFAULT 0,
    "email" VARCHAR(255) NOT NULL,
    "status" "LoginRequestStatus" NOT NULL DEFAULT 'PENDENTE',
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "login_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_id_transacao_key" ON "payment_events"("id_transacao");

-- CreateIndex
CREATE INDEX "ix_payment_events_id_contrato" ON "payment_events"("id_contrato");

-- CreateIndex
CREATE INDEX "ix_payment_events_status_recebido" ON "payment_events"("status_processamento", "recebido_em");

-- CreateIndex
CREATE UNIQUE INDEX "processing_jobs_payment_event_id_key" ON "processing_jobs"("payment_event_id");

-- CreateIndex
CREATE INDEX "ix_processing_jobs_estado_disponivel" ON "processing_jobs"("estado", "disponivel_em");

-- CreateIndex
CREATE UNIQUE INDEX "login_requests_selector_key" ON "login_requests"("selector");

-- CreateIndex
CREATE UNIQUE INDEX "login_requests_magic_token_hash_key" ON "login_requests"("magic_token_hash");

-- CreateIndex
CREATE INDEX "ix_login_requests_email" ON "login_requests"("email");

-- CreateIndex
CREATE INDEX "ix_login_requests_expira_em" ON "login_requests"("expira_em");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_payment_event_id_fkey" FOREIGN KEY ("payment_event_id") REFERENCES "payment_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
