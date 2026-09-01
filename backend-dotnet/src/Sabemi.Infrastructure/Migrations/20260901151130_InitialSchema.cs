using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Sabemi.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class InitialSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "dotnet");

            migrationBuilder.CreateTable(
                name: "contract_statuses",
                schema: "dotnet",
                columns: table => new
                {
                    id_contrato = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    valor_total_liquidado = table.Column<decimal>(type: "numeric(18,2)", precision: 18, scale: 2, nullable: false),
                    pagamentos_confirmados = table.Column<int>(type: "integer", nullable: false),
                    ultimo_pagamento_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ultima_transacao = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    situacao = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    atualizado_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_contract_statuses", x => x.id_contrato);
                });

            migrationBuilder.CreateTable(
                name: "login_requests",
                schema: "dotnet",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    selector = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    magic_token_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    otp_code_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    otp_tentativas = table.Column<int>(type: "integer", nullable: false),
                    email = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    criado_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    expira_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_login_requests", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "payment_events",
                schema: "dotnet",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    id_transacao = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    id_contrato = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    valor = table.Column<decimal>(type: "numeric(18,2)", precision: 18, scale: 2, nullable: true),
                    data_pagamento = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    status_origem = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    status_processamento = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    erro = table.Column<string>(type: "text", nullable: true),
                    payload_bruto = table.Column<string>(type: "jsonb", nullable: false),
                    assinatura_verificada = table.Column<bool>(type: "boolean", nullable: false),
                    recebido_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    processado_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    tentativas = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_payment_events", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "users",
                schema: "dotnet",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    email = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    criado_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_users", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "processing_jobs",
                schema: "dotnet",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    payment_event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    estado = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    tentativas = table.Column<int>(type: "integer", nullable: false),
                    max_tentativas = table.Column<int>(type: "integer", nullable: false),
                    disponivel_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    reivindicado_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    reivindicado_por = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    ultimo_erro = table.Column<string>(type: "text", nullable: true),
                    criado_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    atualizado_em = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_processing_jobs", x => x.id);
                    table.ForeignKey(
                        name: "FK_processing_jobs_payment_events_payment_event_id",
                        column: x => x.payment_event_id,
                        principalSchema: "dotnet",
                        principalTable: "payment_events",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_login_requests_email",
                schema: "dotnet",
                table: "login_requests",
                column: "email");

            migrationBuilder.CreateIndex(
                name: "ix_login_requests_expira_em",
                schema: "dotnet",
                table: "login_requests",
                column: "expira_em");

            migrationBuilder.CreateIndex(
                name: "ux_login_requests_magic_token_hash",
                schema: "dotnet",
                table: "login_requests",
                column: "magic_token_hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_login_requests_selector",
                schema: "dotnet",
                table: "login_requests",
                column: "selector",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_payment_events_id_contrato",
                schema: "dotnet",
                table: "payment_events",
                column: "id_contrato");

            migrationBuilder.CreateIndex(
                name: "ix_payment_events_status_recebido",
                schema: "dotnet",
                table: "payment_events",
                columns: new[] { "status_processamento", "recebido_em" });

            migrationBuilder.CreateIndex(
                name: "ux_payment_events_id_transacao",
                schema: "dotnet",
                table: "payment_events",
                column: "id_transacao",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_processing_jobs_estado_disponivel",
                schema: "dotnet",
                table: "processing_jobs",
                columns: new[] { "estado", "disponivel_em" });

            migrationBuilder.CreateIndex(
                name: "ux_processing_jobs_payment_event_id",
                schema: "dotnet",
                table: "processing_jobs",
                column: "payment_event_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ux_users_email",
                schema: "dotnet",
                table: "users",
                column: "email",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "contract_statuses",
                schema: "dotnet");

            migrationBuilder.DropTable(
                name: "login_requests",
                schema: "dotnet");

            migrationBuilder.DropTable(
                name: "processing_jobs",
                schema: "dotnet");

            migrationBuilder.DropTable(
                name: "users",
                schema: "dotnet");

            migrationBuilder.DropTable(
                name: "payment_events",
                schema: "dotnet");
        }
    }
}
