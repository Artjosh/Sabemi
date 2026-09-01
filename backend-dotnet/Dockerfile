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
# POR QUE NAO AS IMAGENS `mcr.microsoft.com/dotnet/*`
# ---------------------------------------------------
# O caminho idiomatico seria partir de `mcr.microsoft.com/dotnet/sdk` e
# `.../aspnet`. Aqui a base vem do Docker Hub e o SDK e instalado pelo script
# oficial da Microsoft, por dois motivos:
#
#   1. O MCR e um registro unico e nem sempre alcancavel - redes corporativas o
#      bloqueiam com frequencia, e foi exatamente o que aconteceu na maquina
#      onde este projeto foi montado. Depender dele torna o build refem de uma
#      unica rota de rede.
#   2. O resultado e MELHOR: a publicacao e self-contained, entao a imagem final
#      nao precisa de runtime .NET instalado. Ela carrega apenas o binario e as
#      bibliotecas que ele de fato usa.
#
# O script `dotnet-install.sh` e o mecanismo oficial de instalacao e busca os
# artefatos em `builds.dotnet.microsoft.com` - a mesma origem que o instalador
# do site usa.
# =============================================================================

ARG DOTNET_CHANNEL=10.0
ARG DEBIAN_BASE=debian:13-slim

# ------------------------------------------------------------------ sdk base
# Estagio com o SDK instalado. Fica separado para que o download de ~200 MB
# venha do cache enquanto o canal do .NET nao mudar.
FROM ${DEBIAN_BASE} AS sdk
ARG DOTNET_CHANNEL

ENV DOTNET_ROOT=/usr/share/dotnet \
    PATH=/usr/share/dotnet:$PATH \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl libicu-dev \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && chmod +x /tmp/dotnet-install.sh \
 && /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir "${DOTNET_ROOT}" \
 && rm /tmp/dotnet-install.sh \
 && dotnet --info

# ------------------------------------------------------------------ restore
# Estagio separado so para o restore: enquanto os .csproj nao mudam, esta camada
# vem do cache e a compilacao pula o download dos pacotes. Copiar tudo de uma vez
# invalidaria o cache a cada alteracao de codigo.
FROM sdk AS restore
WORKDIR /src

COPY Sabemi.slnx ./
COPY src/Sabemi.Domain/Sabemi.Domain.csproj                 src/Sabemi.Domain/
COPY src/Sabemi.Application/Sabemi.Application.csproj       src/Sabemi.Application/
COPY src/Sabemi.Infrastructure/Sabemi.Infrastructure.csproj src/Sabemi.Infrastructure/
COPY src/Sabemi.Api/Sabemi.Api.csproj                       src/Sabemi.Api/
COPY src/Sabemi.Worker/Sabemi.Worker.csproj                 src/Sabemi.Worker/
COPY tests/Sabemi.UnitTests/Sabemi.UnitTests.csproj                 tests/Sabemi.UnitTests/
COPY tests/Sabemi.IntegrationTests/Sabemi.IntegrationTests.csproj   tests/Sabemi.IntegrationTests/

# `TARGETARCH` e preenchido pelo buildx. O restore precisa dele porque a
# publicacao self-contained resolve pacotes especificos da plataforma.
ARG TARGETARCH
RUN RID=$(case "${TARGETARCH:-amd64}" in \
              amd64) echo linux-x64 ;; \
              arm64) echo linux-arm64 ;; \
              *) echo "arquitetura nao suportada: ${TARGETARCH}" >&2; exit 1 ;; \
          esac) \
 && echo "$RID" > /tmp/rid \
 && dotnet restore Sabemi.slnx --runtime "$RID"

# -------------------------------------------------------------------- build
FROM restore AS build
ARG APP_PROJECT=Sabemi.Api
WORKDIR /src

COPY src/ src/

# Publicacao self-contained: o runtime .NET vai junto do binario, entao a imagem
# final nao precisa te-lo instalado.
#
# `PublishTrimmed` fica DESLIGADO de proposito. O EF Core e o System.Text.Json
# resolvem tipos por reflexao, e o trimmer nao consegue provar o que e usado -
# o resultado seria uma imagem menor que falha em execucao, no meio de uma
# consulta, com um erro de tipo ausente. Nao vale a economia.
RUN RID=$(cat /tmp/rid) \
 && dotnet publish "src/${APP_PROJECT}/${APP_PROJECT}.csproj" \
      --configuration Release \
      --runtime "$RID" \
      --self-contained true \
      --no-restore \
      --output /app/publish \
      /p:PublishTrimmed=false \
      /p:PublishSingleFile=false \
      /p:DebugType=none

# ------------------------------------------------------------------ runtime
# Base limpa do Docker Hub: sem SDK, sem runtime .NET, sem codigo-fonte.
# Apenas as bibliotecas de sistema que o binario self-contained precisa.
FROM ${DEBIAN_BASE} AS runtime
ARG APP_PROJECT=Sabemi.Api

# libicu   - globalizacao (formatacao de numero e data). Sem ela seria preciso
#            ligar InvariantGlobalization, o que mudaria o comportamento.
# libssl   - TLS para a conexao com o PostgreSQL.
# libkrb5  - o Npgsql tenta carregar GSSAPI ao abrir a conexao. Sem ela tudo
#            funciona, mas cada conexao imprime "Cannot load library
#            libgssapi_krb5.so.2" no log - ruido que esconderia um erro de
#            verdade.
# curl     - usado pelo HEALTHCHECK. A base slim nao traz curl nem wget, e sem
#            um deles o compose marca o container como unhealthy mesmo com a
#            aplicacao respondendo normalmente.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl libicu76 libssl3 libgssapi-krb5-2 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 1654 --create-home --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=build --chown=app:app /app/publish .

# Usuario sem privilegios: um processo comprometido nao ganha root no container.
USER app

ENV ASPNETCORE_URLS=http://+:8080 \
    DOTNET_RUNNING_IN_CONTAINER=true \
    # Desliga a coleta de diagnostico por arquivo mapeado, que nao tem uso num
    # container e evita escrita desnecessaria em /tmp.
    DOTNET_EnableDiagnostics=0

EXPOSE 8080

# `APP_PROJECT` e um argumento de build e nao existe em execucao; grava-lo numa
# variavel de ambiente permite que o ENTRYPOINT (que nao enxerga ARG) saiba qual
# executavel iniciar.
ENV APP_EXEC=${APP_PROJECT}

# A publicacao self-contained gera um executavel nativo - nao ha `dotnet` na
# imagem para invocar uma DLL.
ENTRYPOINT ["sh", "-c", "exec ./$APP_EXEC"]
