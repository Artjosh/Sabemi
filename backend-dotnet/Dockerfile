# =============================================================================
# Imagem do backend .NET - serve tanto a API quanto o Worker.
#
# UM DOCKERFILE, DOIS SERVICOS
# ----------------------------
# API e Worker sao processos separados que compartilham Domain, Application e
# Infrastructure. Compilar os dois na mesma passagem aproveita o cache de
# restore e de build; o estagio final escolhe o executavel pelo argumento
# `APP_PROJECT`. Dois Dockerfiles quase identicos so criariam a chance de eles
# divergirem.
#
# O QUE A IMAGEM FINAL CONTEM
# ---------------------------
# Apenas o runtime ASP.NET e os binarios publicados. Sem SDK, sem codigo-fonte,
# sem pacotes NuGet - a diferenca e de mais de 1 GB, e reduz tanto o tempo de
# deploy quanto a superficie exposta.
# =============================================================================

ARG DOTNET_VERSION=10.0

# ------------------------------------------------------------------ restore
# Estagio separado so para o restore: enquanto os .csproj nao mudam, esta camada
# vem do cache e a compilacao pula o download dos pacotes. Copiar tudo de uma vez
# invalidaria o cache a cada alteracao de codigo.
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS restore
WORKDIR /src

COPY Sabemi.slnx ./
COPY src/Sabemi.Domain/Sabemi.Domain.csproj                 src/Sabemi.Domain/
COPY src/Sabemi.Application/Sabemi.Application.csproj       src/Sabemi.Application/
COPY src/Sabemi.Infrastructure/Sabemi.Infrastructure.csproj src/Sabemi.Infrastructure/
COPY src/Sabemi.Api/Sabemi.Api.csproj                       src/Sabemi.Api/
COPY src/Sabemi.Worker/Sabemi.Worker.csproj                 src/Sabemi.Worker/
COPY tests/Sabemi.UnitTests/Sabemi.UnitTests.csproj                 tests/Sabemi.UnitTests/
COPY tests/Sabemi.IntegrationTests/Sabemi.IntegrationTests.csproj   tests/Sabemi.IntegrationTests/

RUN dotnet restore Sabemi.slnx

# -------------------------------------------------------------------- build
FROM restore AS build
ARG APP_PROJECT=Sabemi.Api
WORKDIR /src

COPY src/ src/

RUN dotnet publish "src/${APP_PROJECT}/${APP_PROJECT}.csproj" \
      --configuration Release \
      --no-restore \
      --output /app/publish \
      /p:UseAppHost=false

# ------------------------------------------------------------------ runtime
FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_VERSION} AS runtime
ARG APP_PROJECT=Sabemi.Api

WORKDIR /app
COPY --from=build /app/publish .

# Usuario sem privilegios. A imagem base ja traz `app` (uid 1654); um processo
# comprometido nao ganha root no container.
USER app

ENV ASPNETCORE_URLS=http://+:8080 \
    DOTNET_RUNNING_IN_CONTAINER=true \
    # Desliga a coleta de diagnostico por arquivo mapeado, que nao tem uso num
    # container e evita escrita desnecessaria em /tmp.
    DOTNET_EnableDiagnostics=0

EXPOSE 8080

# `APP_PROJECT` e um argumento de build e nao existe em execucao; grava-lo numa
# variavel de ambiente permite que o ENTRYPOINT (que nao enxerga ARG) saiba qual
# DLL iniciar.
ENV APP_DLL=${APP_PROJECT}.dll

ENTRYPOINT ["sh", "-c", "exec dotnet $APP_DLL"]
