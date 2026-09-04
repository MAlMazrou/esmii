FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS base

ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable

FROM base AS dependencies

WORKDIR /workspace

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts/enforce-toolchain.mjs scripts/enforce-toolchain.mjs
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/testing/package.json packages/testing/package.json

RUN --mount=type=cache,id=esmii-pnpm,target=/pnpm/store \
    corepack pnpm install --filter @esmii/dashboard... --frozen-lockfile

FROM dependencies AS build

ARG ESMII_APP_VERSION
ARG NEXT_PUBLIC_APP_VERSION

COPY apps/dashboard apps/dashboard

RUN export NEXT_PUBLIC_APP_VERSION="${NEXT_PUBLIC_APP_VERSION:-${ESMII_APP_VERSION}}" \
    && export DASHBOARD_ENVIRONMENT=staging \
    && export DASHBOARD_ORIGIN=http://127.0.0.1:3000 \
    && export DASHBOARD_PEER_ORIGIN=http://127.0.0.1:3001 \
    && export MONITORING_FIXTURE_MODE=true \
    && corepack pnpm --filter @esmii/dashboard build

# The standalone Next.js trace contains only dependencies needed by the web
# server. Bundle the separate root-initiated operator CLI into one portable
# module so build tooling and optional peer dependencies never enter runtime.
RUN corepack pnpm --filter @esmii/dashboard build:operator-cli

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime

ARG ESMII_IMAGE_SOURCE=local://esmii/working-tree
ARG ESMII_IMAGE_REVISION=development-uncommitted
ARG ESMII_APP_VERSION

LABEL org.opencontainers.image.source="${ESMII_IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${ESMII_IMAGE_REVISION}" \
      org.opencontainers.image.version="${ESMII_APP_VERSION}"

ENV HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

RUN npm uninstall --global npm \
    && groupadd --system --gid 10003 esmii-dashboard \
    && useradd --system --uid 10003 --gid 10003 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin esmii-dashboard

COPY --from=build --chown=10003:10003 /workspace/apps/dashboard/.next/standalone ./
COPY --from=build --chown=10003:10003 /workspace/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build --chown=10003:10003 /workspace/apps/dashboard/lib/config ./apps/dashboard/lib/config
COPY --from=build --chown=10003:10003 /workspace/apps/dashboard/dist/operator-auth.cjs ./apps/dashboard/operator-auth.cjs

USER 10003:10003

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=4s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/dashboard/server.js"]
