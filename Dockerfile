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
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm build

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
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
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
