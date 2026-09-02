using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
// Microsoft.OpenApi 2.x achatou o namespace: OpenApiInfo, OpenApiSecurityScheme
// e ParameterLocation vivem agora em Microsoft.OpenApi, nao em .Models.
using Microsoft.OpenApi;
using Sabemi.Api.Endpoints;
using Sabemi.Api.Middleware;
using Sabemi.Application.Auth;
using Sabemi.Application.Contracts;
using Sabemi.Infrastructure;
using Sabemi.Infrastructure.Persistence;
using Serilog;
using Sabemi.Api.Observability;

var builder = WebApplication.CreateBuilder(args);

// Log estruturado desde o inicio: em container, stdout e a unica janela para
// dentro do processo.
builder.Host.UseSerilog((ctx, cfg) => cfg
    .ReadFrom.Configuration(ctx.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console());

builder.Services.AddSabemiInfrastructure(builder.Configuration);

// O ambiente decide se os codigos de login podem aparecer na resposta. A decisao
// e do servidor e falha fechada em producao - nenhuma configuracao do cliente a
// altera.
builder.Services.Configure<AuthOptions>(o =>
    o.IsProduction = builder.Environment.IsProduction());

// Metricas em /metrics (sempre) e tracing por OTLP (so com endpoint
// configurado). Ver Observability/ObservabilidadeSetup.cs.
builder.Services.AddObservabilidade(builder.Configuration, "sabemi-api");

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        var jwt = builder.Configuration.GetSection("Jwt");
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = jwt["Issuer"],
            ValidAudience = jwt["Audience"],
            IssuerSigningKey = new SymmetricSecurityKey(
                Encoding.UTF8.GetBytes(jwt["Secret"] ?? throw new InvalidOperationException("Jwt:Secret ausente."))),
            // Sem folga no relogio: a expiracao configurada e a que vale.
            ClockSkew = TimeSpan.Zero
        };

        // Sem esta troca, um token expirado devolveria o corpo HTML padrao do
        // ASP.NET, que o frontend nao sabe interpretar. O contrato exige o mesmo
        // ProblemDetails em toda falha.
        options.Events = new JwtBearerEvents
        {
            OnChallenge = async context =>
            {
                context.HandleResponse();
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync(JsonSerializer.Serialize(
                    ProblemDetailsDto.Of("Sessao ausente ou expirada.", "unauthorized")));
            }
        };
    });

builder.Services.AddAuthorization();

// Rate limit apenas no login: e o unico endpoint que um estranho pode martelar
// sem credencial. O webhook e protegido pela ApiKey, e o dashboard pela sessao.
//
// O limite e configuravel porque o valor correto depende do ambiente. Em
// producao, 10 pedidos por minuto por IP e folgado para uma pessoa e apertado
// para um script. Uma suite de testes ponta a ponta, que faz dezenas de logins
// do mesmo IP em segundos, precisa de um teto maior - e sem esta opcao a unica
// saida seria enfraquecer o limite para todo mundo.
var authPermitLimit = builder.Configuration.GetValue("RateLimit:AuthPermitLimit", 10);
var authWindow = builder.Configuration.GetValue("RateLimit:AuthWindow", TimeSpan.FromMinutes(1));

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddPolicy("auth", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "desconhecido",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = authPermitLimit,
                Window = authWindow,
                QueueLimit = 0
            }));

    options.OnRejected = async (context, ct) =>
    {
        context.HttpContext.Response.ContentType = "application/json";
        await context.HttpContext.Response.WriteAsync(JsonSerializer.Serialize(
            ProblemDetailsDto.Of("Muitas tentativas. Aguarde um minuto.", "rate_limited")), ct);
    };
});

// CORS existe para o desenvolvimento e para chamadas diretas a API. Em operacao
// normal o browser nunca fala com este servico: ele fala com o gateway do
// frontend, same-origin, que repassa a chamada pelo servidor.
builder.Services.AddCors(options =>
{
    var origens = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
        ?? ["http://localhost:3000"];

    options.AddDefaultPolicy(policy => policy
        .WithOrigins(origens)
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials());
});

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Sabemi Payment Webhooks API",
        Version = "v1",
        Description = "Backend .NET. Implementa o contrato compartilhado em contracts/openapi.yaml."
    });

    c.AddSecurityDefinition("ApiKey", new OpenApiSecurityScheme
    {
        Name = "X-Api-Key",
        In = ParameterLocation.Header,
        Type = SecuritySchemeType.ApiKey,
        Description = "Chave compartilhada com o banco parceiro (endpoint de webhook)."
    });

    c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Name = "Authorization",
        In = ParameterLocation.Header,
        Type = SecuritySchemeType.Http,
        Scheme = "bearer",
        BearerFormat = "JWT",
        Description = "Sessao do painel administrativo."
    });
});

builder.Services.AddHealthChecks()
    .AddDbContextCheck<SabemiDbContext>("postgres");

var app = builder.Build();

// Expor link e OTP na resposta e legitimo para uma stack de demonstracao sem
// provedor de e-mail, mas nunca deve passar despercebido: se esta configuracao
// for promovida a um ambiente real, o aviso esta no log de inicializacao. Aqui e
// nao antes do Build(): so a partir deste ponto o logger do host esta de pe.
// Qual provedor de e-mail esta ativo. Sem esta linha, a diferenca entre "o
// e-mail falhou" e "nunca houve provedor configurado" so apareceria depois de
// alguem pedir acesso e nao receber nada.
app.Logger.LogInformation(
    string.IsNullOrWhiteSpace(app.Configuration["Brevo:ApiKey"])
        ? "E-mail de acesso: SEM provedor configurado (o link vai para o log). Defina BREVO_API_KEY para enviar de verdade."
        : "E-mail de acesso: Brevo, remetente {Remetente}.",
    app.Configuration["Brevo:SenderEmail"] ?? "(nao configurado)");

if (app.Environment.IsProduction()
    && app.Configuration.GetValue<bool?>("Auth:ExposeLoginCodesInDevelopment") == true)
{
    app.Logger.LogWarning(
        "AVISO: Auth:ExposeLoginCodesInDevelopment=true em producao. O link e o "
        + "codigo de acesso vao no CORPO da resposta de login - qualquer um que "
        + "chame /auth/acesso com um e-mail entra como aquele e-mail. Use apenas "
        + "em ambiente de demonstracao.");
}

// Traduz qualquer excecao nao tratada para o mesmo ProblemDetails do contrato,
// para o frontend ter um unico caminho de erro.
app.UseMiddleware<ExceptionHandlingMiddleware>();

app.UseSerilogRequestLogging();
app.UseCors();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

if (!app.Environment.IsProduction())
{
    app.UseSwagger();
    app.UseSwaggerUI(c => c.SwaggerEndpoint("/swagger/v1/swagger.json", "Sabemi API v1"));
}

app.MapWebhookEndpoints();
app.MapAuthEndpoints();
app.MapPaymentEndpoints();

app.MapGet("/health", (IHostEnvironment env) => Results.Ok(new
{
    status = "healthy",
    // O frontend usa este campo para confirmar, na tela, qual implementacao
    // esta de fato respondendo depois de uma troca de backend.
    backend = "dotnet",
    version = typeof(Program).Assembly.GetName().Version?.ToString() ?? "1.0.0",
    environment = env.EnvironmentName
})).AllowAnonymous().WithTags("health");

app.MapHealthChecks("/health/ready").AllowAnonymous();

// Exposicao das metricas no formato Prometheus.
//
// `AllowAnonymous` porque quem raspa e o Prometheus, que nao tem sessao. Em uma
// rede publica isto ficaria atras do gateway ou numa porta interna: as metricas
// nao trazem dado de pagamento, mas revelam volume e taxa de erro, que sao
// informacao de negocio.
app.MapPrometheusScrapingEndpoint("/metrics").AllowAnonymous();

// Aplica as migrations na subida.
//
// E aceitavel aqui porque ha um unico servico dono deste schema e o teste
// tecnico precisa subir com um comando so. Em um ambiente com varias replicas,
// isto viraria um job de deploy separado - varias instancias migrando em
// paralelo disputam o lock de migration. O worker nao faz isto de proposito:
// so a API migra, e o worker espera.
if (app.Configuration.GetValue("Database:MigrateOnStartup", true))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<SabemiDbContext>();
    await db.Database.MigrateAsync();
    app.Logger.LogInformation("Migrations aplicadas ao schema '{Schema}'.", SabemiDbContext.Schema);
}

app.Run();

/// <summary>
/// Exposto para os testes de integracao.
/// </summary>
/// <remarks>
/// <c>WebApplicationFactory&lt;T&gt;</c> precisa de um tipo publico do assembly
/// da aplicacao para localizar o host. Com top-level statements a classe
/// <c>Program</c> e gerada como internal, entao esta declaracao parcial a torna
/// publica - e o que permite testar a API pela borda HTTP real, sem mocks.
/// </remarks>
public partial class Program;
