# =============================================================================
# Imagem do frontend VINEXT - serve a interface E o backend alternativo (BFF).
#
# UM CONTAINER, DOIS PAPEIS
# -------------------------
# Este container entrega as telas e, quando o backend VINEXT esta selecionado,
# tambem atende `/api/bff/*` com o proprio banco. Nao sao dois processos: o
# gateway chama o backend alternativo EM PROCESSO, o que e a vantagem estrutural
# de um BFF - o "salto de rede" vira uma chamada de funcao.
#
# O laco de processamento em background sobe junto, no mesmo processo. Do lado
# .NET o worker e um container proprio; aqui nao, e a diferenca esta explicada
# em docs/APRESENTACAO.md.
# =============================================================================

ARG NODE_VERSION=24-alpine

# ---------------------------------------------------------------- deps
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

RUN corepack enable

# Só os manifestos: enquanto eles não mudam, esta camada vem do cache e a
# instalação inteira é pulada.
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------- build
FROM node:${NODE_VERSION} AS build
WORKDIR /app

RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# O cliente do Prisma é gerado a partir do schema, e não versionado.
RUN pnpm prisma generate

# `output: "standalone"` (next.config.ts) emite um bundle autocontido.
RUN pnpm vinext build

# --------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

RUN corepack enable

ENV NODE_ENV=production \
    # O standalone do VINEXT lê HOST (e não HOSTNAME, como o Next.js) para o
    # endereço de bind. Sem 0.0.0.0 o processo só aceitaria conexões de dentro
    # do próprio container.
    HOST=0.0.0.0 \
    PORT=3000

# O bundle autocontido: sem node_modules de aplicação, sem código-fonte.
COPY --from=build /app/dist/standalone ./dist/standalone
COPY --from=build /app/public ./public

# O CLI do Prisma NAO vem: este container nao migra mais nada. Os dois backends
# compartilham o schema `sabemi` e quem e dono das migrations e o EF Core - a
# API as aplica na subida.
#
# O driver `pg` e instalado do zero, e nao copiado do estagio de build. Copiar
# `node_modules/pg` do pnpm traz o pacote mas nao as dependencias dele: o pnpm
# as guarda em `.pnpm` e liga por symlink, e os links nao sobrevivem ao COPY -
# o container subia e morria com MODULE_NOT_FOUND em `pg-connection-string`.
#
# Ele serve so ao entrypoint, para ESPERAR o schema ficar pronto antes de
# servir. A aplicacao usa o driver que ja esta no bundle autocontido.
RUN npm install --no-save --omit=dev pg@8

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Usuário sem privilégios (`node` já existe na imagem base).
USER node

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/standalone/server.js"]
