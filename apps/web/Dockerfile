# syntax=docker/dockerfile:1.7
# Multi-stage build for the public web service. The runtime stage contains the
# built Vite bundle plus the dependency-free Node static server; no package
# manager, no node_modules, no secrets.

FROM node:24.19.0-alpine3.23 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /workspace

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile

FROM fetch AS builder
COPY package.json tsconfig.base.json turbo.json biome.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --offline --frozen-lockfile --filter @moi/web...
RUN pnpm turbo run build --filter=@moi/web...

FROM node:24.19.0-alpine3.23 AS runtime
# Pull in Alpine security updates (e.g. openssl) so the published image passes
# the Trivy gate in .github/workflows/publish.yml without waiting for a new
# upstream node tag.
RUN apk upgrade --no-cache
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules \
    /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg /opt/yarn*
COPY --from=builder --chown=node:node /workspace/apps/web/dist /app/apps/web/dist
COPY --from=builder --chown=node:node /workspace/apps/web/server.mjs /app/apps/web/server.mjs
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.mjs"]
