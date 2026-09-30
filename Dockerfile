# TopCam — imagem única da aplicação Node (api, worker, migrations e CLI).
# O serviço executado é escolhido pelo "command" no compose.yaml.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
RUN npm install -g pnpm@10.28.0 && npm cache clean --force
WORKDIR /app

# ---------------------------------------------------------------- dependências (com dev)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN pnpm -r --filter "!@topcam/web" --workspace-concurrency=1 run build

# ---------------------------------------------------------------- testes (perfil "test" do compose)
FROM build AS test
RUN apk add --no-cache ffmpeg
COPY vitest.config.ts eslint.config.js .prettierrc.json ./
CMD ["pnpm", "test"]

# ---------------------------------------------------------------- runtime
FROM base AS runtime
RUN apk add --no-cache ffmpeg tini
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
RUN pnpm install --prod --frozen-lockfile --filter "@topcam/api..." --filter "@topcam/worker..." && pnpm store prune
COPY packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
ARG TOPCAM_VERSION=0.1.0
ENV TOPCAM_VERSION=${TOPCAM_VERSION}
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]

# ---------------------------------------------------------------- backup (Fase 8)
# Mesma aplicação + ferramentas: pg_dump/pg_restore (PostgreSQL 16), gpg, lftp (SFTP/FTPS/FTP)
# e o cliente SSH. Só o serviço de backup usa esta imagem.
FROM runtime AS backup
USER root
RUN apk add --no-cache postgresql16-client gnupg lftp openssh-client tar
USER node
CMD ["node", "apps/worker/dist/backup-main.js"]

# ---------------------------------------------------------------- painel web (Next.js)
FROM deps AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web apps/web
RUN pnpm --filter @topcam/web run build

FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
USER node
CMD ["node", "apps/web/server.js"]
