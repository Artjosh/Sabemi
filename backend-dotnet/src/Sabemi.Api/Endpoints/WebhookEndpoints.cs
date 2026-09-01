using System.Text.Json;
using Sabemi.Application.Contracts;
using Sabemi.Application.Payments;
using Sabemi.Infrastructure.Security;

namespace Sabemi.Api.Endpoints;

/// <summary>Endpoint de ingestao de notificacoes do banco parceiro.</summary>
public static class WebhookEndpoints
{
    public static IEndpointRouteBuilder MapWebhookEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/webhooks").WithTags("webhooks");

        group.MapPost("/pagamento", ReceberPagamento)
            .WithName("ReceberPagamento")
            .WithSummary("Recebe uma notificacao de pagamento do banco parceiro")
            .AllowAnonymous()  // autenticado por ApiKey/HMAC, nao pelo JWT do painel
            .Produces<WebhookAck>(StatusCodes.Status202Accepted)
            .Produces<WebhookAck>(StatusCodes.Status200OK)
            .Produces<ProblemDetailsDto>(StatusCodes.Status400BadRequest)
            .Produces<ProblemDetailsDto>(StatusCodes.Status401Unauthorized)
            .Produces<ProblemDetailsDto>(StatusCodes.Status403Forbidden);

        return app;
    }

    /// <summary>
    /// Recebe, valida, persiste, enfileira e responde.
    /// </summary>
    /// <remarks>
    /// <para><b>O corpo e lido como string, nao vinculado por parametro.</b> Isso
    /// e deliberado e tem tres motivos:</para>
    ///
    /// <list type="number">
    /// <item><description>A assinatura HMAC cobre os bytes exatos que chegaram.
    /// Reserializar o objeto vinculado produziria um JSON diferente - outra
    /// ordem de chaves, outros espacos - e a assinatura nunca conferiria.</description></item>
    /// <item><description>O payload bruto precisa ir para o banco exatamente como
    /// veio, para a auditoria ter valor.</description></item>
    /// <item><description>Um JSON malformado precisa virar uma resposta nossa,
    /// com o campo <c>detail</c> do contrato, e nao o 400 generico do model
    /// binder - que o frontend nao saberia exibir.</description></item>
    /// </list>
    ///
    /// <para>O codigo de resposta carrega significado: <c>202</c> aceito e
    /// enfileirado, <c>200</c> ja conhecido (nada reprocessado), <c>400</c>
    /// invalido mas registrado. O parceiro distingue os tres sem ler o corpo.</para>
    /// </remarks>
    private static async Task<IResult> ReceberPagamento(
        HttpContext http,
        WebhookAuthenticator authenticator,
        PaymentIngestionService ingestion,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var logger = loggerFactory.CreateLogger("Webhook");

        using var reader = new StreamReader(http.Request.Body);
        var rawBody = await reader.ReadToEndAsync(ct);

        var apiKey = http.Request.Headers["X-Api-Key"].FirstOrDefault();
        var signature = http.Request.Headers["X-Signature"].FirstOrDefault();

        var (authResult, signatureVerified) = authenticator.Authenticate(apiKey, signature, rawBody);

        // Autenticacao falha nao persiste nada: gravar o que chega de qualquer
        // origem nao autenticada transformaria a tabela de auditoria em um alvo
        // trivial de enchimento.
        if (authResult is not WebhookAuthResult.Ok)
        {
            logger.LogWarning("Webhook rejeitado na autenticacao: {Resultado}", authResult);

            return authResult switch
            {
                WebhookAuthResult.InvalidApiKey => Results.Json(
                    ProblemDetailsDto.Of("Credencial invalida.", "invalid_api_key"),
                    statusCode: StatusCodes.Status401Unauthorized),

                WebhookAuthResult.MissingSignature => Results.Json(
                    ProblemDetailsDto.Of("Header X-Signature obrigatorio.", "missing_signature"),
                    statusCode: StatusCodes.Status403Forbidden),

                _ => Results.Json(
                    ProblemDetailsDto.Of("Assinatura invalida para o corpo recebido.", "invalid_signature"),
                    statusCode: StatusCodes.Status403Forbidden)
            };
        }

        PaymentWebhookRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<PaymentWebhookRequest>(rawBody);
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "Webhook com JSON malformado.");
            return Results.Json(
                ProblemDetailsDto.Of("Corpo da requisicao nao e um JSON valido.", "malformed_json"),
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request is null)
        {
            return Results.Json(
                ProblemDetailsDto.Of("Corpo da requisicao vazio.", "empty_body"),
                statusCode: StatusCodes.Status400BadRequest);
        }

        var resultado = await ingestion.IngestAsync(request, rawBody, signatureVerified, ct);

        return resultado.Kind switch
        {
            IngestionResultKind.Accepted => Results.Json(resultado.Ack, statusCode: StatusCodes.Status202Accepted),

            // 200 e nao 202: nada novo foi aceito. O parceiro le "ja recebi isto"
            // e para de reenviar.
            IngestionResultKind.Duplicate => Results.Ok(resultado.Ack),

            _ => Results.Json(
                new ProblemDetailsDto
                {
                    Detail = resultado.Ack.Message ?? "Payload invalido.",
                    Code = "validation_failed",
                    Errors = resultado.Errors
                },
                statusCode: StatusCodes.Status400BadRequest)
        };
    }
}
