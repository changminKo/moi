# syntax=docker/dockerfile:1.7
# Multi-stage build for the strategy runner (자동매매 봇, design §3, §8.1). The
# runtime stage carries only production dependencies and compiled output, runs
# as the unprivileged `node` user, and owns the state directory the compose
# volume mounts — a named volume inherits the image's ownership on first use,
# which is what lets a read-only root filesystem still write NDJSON there.

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
COPY apps/strategy-runner ./apps/strategy-runner
RUN pnpm install --offline --frozen-lockfile --filter @moi/strategy-runner...
RUN pnpm turbo run build --filter=@moi/strategy-runner...
RUN pnpm --filter @moi/strategy-runner deploy --prod --legacy /out/strategy-runner \
    && rm -rf /out/strategy-runner/src /out/strategy-runner/Dockerfile /out/strategy-runner/tsconfig.json /out/strategy-runner/tsconfig.test.json /out/strategy-runner/.turbo

FROM node:24.19.0-alpine3.23 AS runtime
# Pull in Alpine security updates (e.g. openssl) so the published image passes
# the Trivy gate in .github/workflows/publish.yml without waiting for a new
# upstream node tag.
RUN apk upgrade --no-cache
ENV NODE_ENV=production
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules \
    /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg /opt/yarn* \
    && mkdir -p /var/lib/moi-bot && chown node:node /var/lib/moi-bot
COPY --from=builder --chown=node:node /out/strategy-runner /app/apps/strategy-runner
USER node
# No EXPOSE: the runner serves nothing. It reaches paper-api over the compose
# network and posts to Discord; nothing reaches it.
CMD ["node", "apps/strategy-runner/dist/main.js"]
