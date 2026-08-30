# Prompt 02 — Create the monorepo

## Objective

Create a reproducible pnpm monorepo that runs locally, establishes the web/server/worker/package boundaries, and passes local and CI verification. Do not implement authentication or organization behavior beyond typed seams and test scaffolding reserved for Prompt 03.

## Inputs

- Approved final report from Prompt 01, including resolved version choices.
- The repository checkout on protected `dev` (or explicit permission to create local `dev` from the current repository baseline) and permission to edit it. Pushing or changing GitHub branch protection is not authorized here.
- Resolved `DEC-INPUT-001`: repository path/name, application name/slug, package scope, and GHCR namespace. This records names only and does not authorize a push.
- Supported local Node.js, Corepack/pnpm, Docker Engine, and Docker Compose.
- No VPS access or production secrets.
- `DRAFT` product/design/engineering templates are not implementation inputs. Even `APPROVED` product content does not authorize a business module under this generic account-and-organization prompt.

## Allowed actions

- Create the pnpm workspace, package manifests, exact-version lockfile, TypeScript configuration, linting, formatting, tests, and GitHub Actions CI.
- Create `apps/web` and `apps/server`, with HTTP, worker, and one-shot migration entrypoints inside `apps/server`, plus shared configuration, database, contracts, authentication seam, storage seam, observability, and testing packages named consistently with `docs/infrastructure.md`.
- Create multi-stage Dockerfiles with non-root runtime users and pinned base-image digests. Both images must be environment-neutral: no staging/production build arguments or `NEXT_PUBLIC_*` values, browser calls use same-origin relative paths, and any required public environment metadata uses one typed allowlisted runtime SSR/API seam.
- Keep web navigation, copy, styling hooks, contracts, and package seams product-neutral. Do not convert empty draft templates into invented product structure.
- Create `infra/compose.yaml` and `infra/compose.development.yaml` for shared Caddy plus local PostgreSQL, Valkey, Mailpit, API, worker, and Next.js. Base Caddy has no ports/environment mounts; the development overlay uses `!override` for loopback-only unprivileged ports and a disposable development media path.
- Add configuration validation that fails safely without printing secret values.
- Implement `/api/health/live`, `/api/health/ready`, and `/api/health/dependencies` in Fastify.
- Make dependency health require a separate operations token in Fastify; development Caddy accepts it only from loopback. It is infrastructure authorization, not a product admin role.
- Add empty-database migrations and a migration test harness owned by the migration role.
- Add deterministic development setup/reset commands and repository documentation updates.
- Add CI definitions and branch guards for the documented `dev` candidate and `main` production-record model, but keep registry publication and every deployment job disabled until its later prompt.
- Pin every third-party GitHub Action to a reviewed full commit SHA, set top-level `permissions: {}` with job-minimal grants, forbid secret-bearing `pull_request_target` execution of untrusted code, and keep environment secrets behind protected checks/approvals.

## Prohibited actions

- Do not access or change a VPS, DNS, provider firewall, OAuth console, mail server, registry environment, or backup repository.
- Do not create or use production/staging credentials.
- Do not deploy or push images.
- Do not implement business modules, product-specific APIs, uploads, realtime product events, Stalwart, production Compose, or staging services.
- Do not treat an approved product document as permission to expand Prompt 02; product implementation requires a later separately authorized prompt.
- Do not implement authentication or organization flows reserved for Prompt 03.
- Do not commit directly to, merge, push, or otherwise advance `main`; do not create `staging` or `production` branches.
- Do not weaken tests, type safety, health behavior, container isolation, or secret handling to obtain a passing build.

## Deliverables

- A pnpm workspace with a committed lockfile and documented supported tool versions.
- Runnable Next.js standalone SSR, Fastify API, and separate worker processes.
- Shared packages and import boundaries matching the architecture.
- Drizzle/PostgreSQL migration framework with distinct migration and runtime roles in development.
- Valkey configuration with separate API and worker ACL users in development.
- Local Mailpit only; no production SMTP dependency.
- Base and development Compose files that render and start from a clean clone, publish only loopback development ports, and contain no `/srv/myapp/staging` or `/srv/myapp/production` reference.
- Health endpoints with tests for live, ready, and dependency-degraded states.
- CI for lockfile integrity, lint, type checks, unit/integration tests, migrations, Compose rendering, secret scanning, dependency review, image build/scan, and an initial end-to-end smoke test.
- Bundle/image scans plus dual-runtime fixtures proving the same web/server digests contain no staging/production domain, OAuth ID, cookie, mail-host, or secret sentinel and operate with separate runtime configuration.
- Updated `README.md` commands without changing locked architecture decisions.
- Repository-local checks that reject deployment workflows which rebuild during promotion or treat an environment branch as the environment boundary.

## Verification commands

Use the repository's pinned commands. The final report must include the exact commands and results for at least:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm db:migrate:test
docker compose --project-name <app-slug>-development -f infra/compose.yaml -f infra/compose.development.yaml config --quiet
docker compose --project-name <app-slug>-development -f infra/compose.yaml -f infra/compose.development.yaml up -d --build
corepack pnpm test:e2e
docker compose --project-name <app-slug>-development -f infra/compose.yaml -f infra/compose.development.yaml down
```

Also inspect the rendered config and verify containers use expected non-root users; every published development port binds `127.0.0.1`; no staging/production host path, domain, secret, or remote state appears; health checks converge; and no secret-like value is committed. If a documented command name changes, update the documentation and explain why.

## Approval gates

- Obtain approval before adding a dependency that materially changes a locked architecture decision.
- Obtain approval before modifying or deleting pre-existing user files whose purpose is unrelated to this milestone.
- No approval in this prompt can authorize external infrastructure access.

## Stop conditions

- Stop if Prompt 01 has unresolved high-impact contradictions.
- Stop if existing user changes would be overwritten and cannot be safely preserved.
- Stop if the working branch is `main` and the work cannot be moved safely to `dev` without changing remote state.
- Stop if a required dependency conflicts with the locked Node.js, Next.js, Fastify, PostgreSQL, or Compose model; report options rather than silently substituting technology.
- Stop after local and CI-equivalent verification. Do not proceed to Prompt 03.

## Final report format

```text
Outcome: PASS | PASS WITH LIMITATIONS | BLOCKED
Implemented:
Architecture boundaries established:
Files added/changed:
Migrations created:
Tests and commands actually run:
Results:
Known limitations:
Decisions requested:
External actions performed: none
Approval needed for next action: yes — Prompt 03
```
