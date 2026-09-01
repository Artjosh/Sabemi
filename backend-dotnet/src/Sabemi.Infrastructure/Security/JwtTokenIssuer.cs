using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Sabemi.Application.Abstractions;
using Sabemi.Application.Auth;
using Sabemi.Domain.Entities;

namespace Sabemi.Infrastructure.Security;

/// <summary>Configuracao do JWT de sessao do painel.</summary>
public sealed class JwtOptions
{
    public const string SectionName = "Jwt";

    /// <summary>Segredo HS256. Obrigatorio; o host recusa subir com ele vazio.</summary>
    public string Secret { get; set; } = string.Empty;

    public string Issuer { get; set; } = "sabemi-webhooks";
    public string Audience { get; set; } = "sabemi-dashboard";
}

/// <summary>
/// Emite o JWT de sessao apos a aprovacao do login.
/// </summary>
/// <remarks>
/// <para>HS256 com segredo compartilhado: o mesmo processo emite e valida, entao
/// a assimetria de RS256 nao compraria nada aqui - so uma chave privada a mais
/// para administrar.</para>
///
/// <para>O token nao chega ao browser. O gateway do frontend o intercepta na
/// resposta do login e o grava em cookie <c>httpOnly</c>; a partir dai o
/// servidor do VINEXT o reinjeta como <c>Authorization: Bearer</c> a cada
/// chamada. Um XSS no dashboard nao encontra o token para roubar, porque ele
/// nunca esteve ao alcance do JavaScript.</para>
/// </remarks>
public sealed class JwtTokenIssuer(
    IOptions<JwtOptions> jwtOptions,
    IOptions<AuthOptions> authOptions,
    IClock clock) : ITokenIssuer
{
    private readonly JwtOptions _jwt = jwtOptions.Value;
    private readonly AuthOptions _auth = authOptions.Value;

    public (string Token, int ExpiresInSeconds) Issue(AppUser user)
    {
        var agora = clock.UtcNow;
        var expira = agora.Add(_auth.SessionTtl);

        var credentials = new SigningCredentials(
            new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_jwt.Secret)),
            SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(JwtRegisteredClaimNames.Email, user.Email),
            // jti unico permite revogar um token especifico no futuro, sem
            // invalidar todas as sessoes trocando o segredo.
            new(JwtRegisteredClaimNames.Jti, Guid.CreateVersion7().ToString())
        };

        var token = new JwtSecurityToken(
            issuer: _jwt.Issuer,
            audience: _jwt.Audience,
            claims: claims,
            notBefore: agora.UtcDateTime,
            expires: expira.UtcDateTime,
            signingCredentials: credentials);

        return (new JwtSecurityTokenHandler().WriteToken(token),
                (int)_auth.SessionTtl.TotalSeconds);
    }
}
