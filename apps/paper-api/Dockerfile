# syntax=docker/dockerfile:1.7
# Multi-stage build for the single paper-api process (public HTTP + fenced
# market-data leader). The runtime stage carries only production dependencies
# and compiled output, and runs as the unprivileged `node` user.

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
COPY apps/paper-api ./apps/paper-api
RUN pnpm install --offline --frozen-lockfile --filter @moi/paper-api...
RUN pnpm turbo run build --filter=@moi/paper-api...
RUN pnpm --filter @moi/paper-api deploy --prod --legacy /out/paper-api \
    && rm -rf /out/paper-api/src /out/paper-api/Dockerfile /out/paper-api/tsconfig.json /out/paper-api/.turbo

FROM node:24.19.0-alpine3.23 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules \
    /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg /opt/yarn*
COPY --from=builder --chown=node:node /out/paper-api /app/apps/paper-api
USER node
EXPOSE 3000
CMD ["node", "apps/paper-api/dist/main.js"]
