using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Sabemi.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class DiagnosticoDeFalha : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "erro_categoria",
                schema: "sabemi",
                table: "payment_events",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "erro_codigo",
                schema: "sabemi",
                table: "payment_events",
                type: "character varying(48)",
                maxLength: 48,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_payment_events_erro_categoria",
                schema: "sabemi",
                table: "payment_events",
                column: "erro_categoria",
                filter: "erro_categoria IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_payment_events_erro_categoria",
                schema: "sabemi",
                table: "payment_events");

            migrationBuilder.DropColumn(
                name: "erro_categoria",
                schema: "sabemi",
                table: "payment_events");

            migrationBuilder.DropColumn(
                name: "erro_codigo",
                schema: "sabemi",
                table: "payment_events");
        }
    }
}
