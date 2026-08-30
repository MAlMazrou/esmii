FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS base

ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable

FROM base AS dependencies

WORKDIR /workspace

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts/enforce-toolchain.mjs scripts/enforce-toolchain.mjs
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/testing/package.json packages/testing/package.json

RUN --mount=type=cache,id=esmii-pnpm,target=/pnpm/store \
    corepack pnpm install --filter @esmii/web... --frozen-lockfile

FROM dependencies AS build

COPY apps/web apps/web

RUN corepack pnpm --filter @esmii/web build

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime

ARG ESMII_IMAGE_SOURCE=local://esmii/working-tree
ARG ESMII_IMAGE_REVISION=development-uncommitted

LABEL org.opencontainers.image.source="${ESMII_IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${ESMII_IMAGE_REVISION}"

ENV HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

RUN groupadd --system --gid 10001 esmii \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin esmii

COPY --from=build --chown=10001:10001 /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=10001:10001 /workspace/apps/web/.next/static ./apps/web/.next/static

USER 10001:10001

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
