using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Sabemi.Domain.Entities;
using Sabemi.Domain.Enums;
using Sabemi.Domain.Processing;

namespace Sabemi.Infrastructure.Persistence.Configurations;

/// <summary>
/// Mapeamento do log de eventos brutos.
/// </summary>
/// <remarks>
/// O indice unico sobre <c>id_transacao</c> declarado aqui e a garantia de
/// idempotencia exigida pela task. Ela vive no banco, nao no codigo: continua
/// valendo com varias replicas da API, com reentregas simultaneas e com
/// insercoes feitas por fora da aplicacao.
/// </remarks>
public sealed class PaymentEventConfiguration : IEntityTypeConfiguration<PaymentEvent>
{
    public void Configure(EntityTypeBuilder<PaymentEvent> b)
    {
        b.ToTable("payment_events");
        b.HasKey(e => e.Id);

        b.Property(e => e.Id).HasColumnName("id");

        b.Property(e => e.IdTransacao)
            .HasColumnName("id_transacao")
            .HasMaxLength(128)
            .IsRequired();

        // A restricao que sustenta toda a idempotencia do sistema.
        b.HasIndex(e => e.IdTransacao)
            .IsUnique()
            .HasDatabaseName("ux_payment_events_id_transacao");

        b.Property(e => e.IdContrato)
            .HasColumnName("id_contrato")
            .HasMaxLength(128);

        // Indice do filtro por contrato do dashboard.
        b.HasIndex(e => e.IdContrato).HasDatabaseName("ix_payment_events_id_contrato");

        b.Property(e => e.Valor)
            .HasColumnName("valor")
            .HasPrecision(18, 2);

        b.Property(e => e.DataPagamento).HasColumnName("data_pagamento");

        b.Property(e => e.StatusOrigem)
            .HasColumnName("status_origem")
            .HasMaxLength(32);

        // Enum gravado como texto: o valor fica legivel em consultas ad hoc e
        // reordenar os membros do enum deixa de corromper dados existentes.
        b.Property(e => e.StatusProcessamento)
            .HasColumnName("status_processamento")
            .HasMaxLength(16)
            .HasConversion(EnumEmMaiusculas.Para<ProcessingStatus>())
            .IsRequired();

        b.Property(e => e.Erro).HasColumnName("erro");

        // A leitura da falha, gravada ao lado da mensagem crua. Enum como texto
        // pelo mesmo motivo de status_processamento: legivel em consulta ad hoc.
        b.Property(e => e.ErroCategoria)
            .HasColumnName("erro_categoria")
            .HasMaxLength(16)
            .HasConversion(EnumEmMaiusculas.Para<FailureCategory>());

        // Codigo estavel da causa. So ele e persistido - a explicacao e a acao
        // sugerida derivam dele no FailureCatalog, entao melhorar um texto do
        // tooltip nao exige tocar em linha nenhuma da tabela.
        b.Property(e => e.ErroCodigo)
            .HasColumnName("erro_codigo")
            .HasMaxLength(48);

        // jsonb em vez de text: permite consultar dentro do payload depois, sem
        // migrar nada. O custo de parse na escrita e desprezivel neste volume.
        b.Property(e => e.PayloadBruto)
            .HasColumnName("payload_bruto")
            .HasColumnType("jsonb")
            .IsRequired();

        b.Property(e => e.AssinaturaVerificada)
            .HasColumnName("assinatura_verificada")
            .IsRequired();

        b.Property(e => e.RecebidoEm).HasColumnName("recebido_em").IsRequired();
        b.Property(e => e.ProcessadoEm).HasColumnName("processado_em");
        b.Property(e => e.Tentativas).HasColumnName("tentativas").IsRequired();

        // Indice composto que serve a consulta padrao do dashboard: filtra por
        // situacao e ordena por recebimento decrescente.
        b.HasIndex(e => new { e.StatusProcessamento, e.RecebidoEm })
            .HasDatabaseName("ix_payment_events_status_recebido");

        // Indice parcial: so as linhas com falha. O painel de erros filtra por
        // categoria, e o volume de eventos com erro e uma fracao pequena do
        // total - indexar a tabela inteira custaria escrita em todo evento de
        // sucesso sem servir a consulta alguma.
        b.HasIndex(e => e.ErroCategoria)
            .HasDatabaseName("ix_payment_events_erro_categoria")
            .HasFilter("erro_categoria IS NOT NULL");
    }
}

public sealed class ContractStatusConfiguration : IEntityTypeConfiguration<ContractStatus>
{
    public void Configure(EntityTypeBuilder<ContractStatus> b)
    {
        b.ToTable("contract_statuses");

        // O identificador de negocio ja e unico e estavel; uma chave sintetica
        // aqui so acrescentaria um join.
        b.HasKey(c => c.IdContrato);

        b.Property(c => c.IdContrato)
            .HasColumnName("id_contrato")
            .HasMaxLength(128);

        b.Property(c => c.ValorTotalLiquidado)
            .HasColumnName("valor_total_liquidado")
            .HasPrecision(18, 2)
            .IsRequired();

        b.Property(c => c.PagamentosConfirmados).HasColumnName("pagamentos_confirmados").IsRequired();
        b.Property(c => c.UltimoPagamentoEm).HasColumnName("ultimo_pagamento_em");

        b.Property(c => c.UltimaTransacao)
            .HasColumnName("ultima_transacao")
            .HasMaxLength(128);

        b.Property(c => c.Situacao)
            .HasColumnName("situacao")
            .HasMaxLength(16)
            .HasConversion(EnumEmMaiusculas.Para<ContractSituation>())
            .IsRequired();

        b.Property(c => c.AtualizadoEm).HasColumnName("atualizado_em").IsRequired();

        // Concorrencia otimista sobre a coluna de sistema xmin do PostgreSQL:
        // nao ocupa espaco proprio e o banco a mantem sozinho. Dois workers
        // atualizando o mesmo contrato: o segundo falha e o job volta para a
        // fila, em vez de sobrescrever o total do primeiro.
        b.Property(c => c.Version)
            .HasColumnName("xmin")
            .HasColumnType("xid")
            .ValueGeneratedOnAddOrUpdate()
            .IsConcurrencyToken();
    }
}

public sealed class ProcessingJobConfiguration : IEntityTypeConfiguration<ProcessingJob>
{
    public void Configure(EntityTypeBuilder<ProcessingJob> b)
    {
        b.ToTable("processing_jobs");
        b.HasKey(j => j.Id);

        b.Property(j => j.Id).HasColumnName("id");
        b.Property(j => j.PaymentEventId).HasColumnName("payment_event_id").IsRequired();

        // Um job por evento. Junto com a unicidade de id_transacao, isto fecha a
        // porta para o mesmo pagamento ser processado duas vezes.
        b.HasIndex(j => j.PaymentEventId)
            .IsUnique()
            .HasDatabaseName("ux_processing_jobs_payment_event_id");

        b.HasOne(j => j.PaymentEvent)
            .WithMany()
            .HasForeignKey(j => j.PaymentEventId)
            .OnDelete(DeleteBehavior.Cascade);

        b.Property(j => j.Estado)
            .HasColumnName("estado")
            .HasMaxLength(16)
            .HasConversion(EnumEmMaiusculas.Para<JobState>())
            .IsRequired();

        b.Property(j => j.Tentativas).HasColumnName("tentativas").IsRequired();
        b.Property(j => j.MaxTentativas).HasColumnName("max_tentativas").IsRequired();
        b.Property(j => j.DisponivelEm).HasColumnName("disponivel_em").IsRequired();
        b.Property(j => j.ReivindicadoEm).HasColumnName("reivindicado_em");

        b.Property(j => j.ReivindicadoPor)
            .HasColumnName("reivindicado_por")
            .HasMaxLength(128);

        b.Property(j => j.UltimoErro).HasColumnName("ultimo_erro");
        b.Property(j => j.CriadoEm).HasColumnName("criado_em").IsRequired();
        b.Property(j => j.AtualizadoEm).HasColumnName("atualizado_em").IsRequired();

        // Indice que a reivindicacao percorre a cada ciclo do worker
        // (WHERE estado = 'Pendente' AND disponivel_em <= now ORDER BY disponivel_em).
        b.HasIndex(j => new { j.Estado, j.DisponivelEm })
            .HasDatabaseName("ix_processing_jobs_estado_disponivel");
    }
}

public sealed class LoginRequestConfiguration : IEntityTypeConfiguration<LoginRequest>
{
    public void Configure(EntityTypeBuilder<LoginRequest> b)
    {
        b.ToTable("login_requests");
        b.HasKey(r => r.Id);

        b.Property(r => r.Id).HasColumnName("id");

        b.Property(r => r.Selector)
            .HasColumnName("selector")
            .HasMaxLength(64)
            .IsRequired();

        // O polling busca por selector a cada 2,5s: precisa ser indexado.
        b.HasIndex(r => r.Selector).IsUnique().HasDatabaseName("ux_login_requests_selector");

        b.Property(r => r.MagicTokenHash)
            .HasColumnName("magic_token_hash")
            .HasMaxLength(64);

        b.HasIndex(r => r.MagicTokenHash).IsUnique().HasDatabaseName("ux_login_requests_magic_token_hash");

        b.Property(r => r.OtpCodeHash)
            .HasColumnName("otp_code_hash")
            .HasMaxLength(64);

        b.Property(r => r.OtpTentativas).HasColumnName("otp_tentativas").IsRequired();

        b.Property(r => r.Email)
            .HasColumnName("email")
            .HasMaxLength(255)
            .IsRequired();

        b.HasIndex(r => r.Email).HasDatabaseName("ix_login_requests_email");

        b.Property(r => r.Status)
            .HasColumnName("status")
            .HasMaxLength(16)
            .HasConversion(EnumEmMaiusculas.Para<LoginRequestStatus>())
            .IsRequired();

        b.Property(r => r.CriadoEm).HasColumnName("criado_em").IsRequired();
        b.Property(r => r.ExpiraEm).HasColumnName("expira_em").IsRequired();

        // Suporta a limpeza periodica de pedidos vencidos.
        b.HasIndex(r => r.ExpiraEm).HasDatabaseName("ix_login_requests_expira_em");
    }
}

public sealed class AppUserConfiguration : IEntityTypeConfiguration<AppUser>
{
    public void Configure(EntityTypeBuilder<AppUser> b)
    {
        b.ToTable("users");
        b.HasKey(u => u.Id);

        b.Property(u => u.Id).HasColumnName("id");

        b.Property(u => u.Email)
            .HasColumnName("email")
            .HasMaxLength(255)
            .IsRequired();

        b.HasIndex(u => u.Email).IsUnique().HasDatabaseName("ux_users_email");

        b.Property(u => u.CriadoEm).HasColumnName("criado_em").IsRequired();
    }
}
