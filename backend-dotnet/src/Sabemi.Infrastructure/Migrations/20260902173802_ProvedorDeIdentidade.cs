using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Sabemi.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class ProvedorDeIdentidade : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "provedor",
                schema: "sabemi",
                table: "login_requests",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "LOCAL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "provedor",
                schema: "sabemi",
                table: "login_requests");
        }
    }
}
