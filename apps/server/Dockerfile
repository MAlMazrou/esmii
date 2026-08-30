# syntax=docker/dockerfile:1.7
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

FROM base AS dependencies
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts/enforce-toolchain.mjs scripts/enforce-toolchain.mjs
COPY apps/server/package.json apps/server/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/testing/package.json packages/testing/package.json
RUN --mount=type=cache,id=esmii-pnpm,target=/pnpm/store \
    corepack pnpm install --frozen-lockfile

FROM dependencies AS build
COPY apps/server apps/server
COPY packages packages
RUN corepack pnpm --filter @esmii/server... build
RUN corepack pnpm --filter @esmii/server deploy --prod /opt/server

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
ARG ESMII_IMAGE_SOURCE=local://esmii/working-tree
ARG ESMII_IMAGE_REVISION=development-uncommitted
LABEL org.opencontainers.image.source="${ESMII_IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${ESMII_IMAGE_REVISION}"
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
RUN groupadd --gid 10001 esmii \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/esmii --shell /usr/sbin/nologin esmii \
    && install -d -o 10001 -g 10001 -m 0750 \
        /srv/media/private/incoming \
        /srv/media/private/originals \
        /srv/media/private/trash \
        /srv/media/private/variants \
    && install -d -o 0 -g 0 -m 0755 /srv/media/public/variants
COPY --from=build --chown=10001:10001 /opt/server/ ./
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/entrypoints/http.js"]
