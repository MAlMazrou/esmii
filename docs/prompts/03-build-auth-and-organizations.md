# Prompt 03 — Build authentication and organizations

## Objective

Implement the generic multi-tenant identity core: passwordless and social authentication, multiple organizations per user, active-organization selection, invitations, roles, audit events, asynchronous email, and authenticated Socket.IO organization rooms.

## Inputs

- A verified Prompt 02 core.
- Local development secrets stored outside Git.
- Mailpit connection details from development Compose.
- Optional pre-existing, development-only Google test OAuth client supplied by the user; otherwise use the mocked Google provider seam.
- The exact authorization rules in `docs/requirements.md`.
- `DRAFT` product/design/engineering templates are not inputs. Even approved product content cannot expand this prompt beyond the generic identity/organization slice.

## Allowed actions

- Integrate Better Auth at `/api/auth/*` using the selected official plugins and approved extension points.
- Implement hashed, single-use, 10-minute magic links with non-enumerating responses.
- Add Google provider configuration with provider enablement driven by validated environment configuration.
- Implement safe identity linking only for verified matching provider email addresses; otherwise require an authenticated linking flow.
- Implement users, organizations, memberships, active-organization selection, invitations, organization roles, audit records, and ownership transfer protections.
- Implement the recovery-safe security-tombstone interface/state machine for access-lowering changes with a development capture/fault-injection adapter; make no external journal connection in this prompt.
- Implement a transactional application outbox. Action-link rows/jobs carry only a versioned issuance-intent ID and safe routing metadata. The worker alone derives a deterministic HMAC-SHA-256 token in memory with an environment/purpose/version-separated worker-only key, atomically stores only its hash while the intent remains current, and reuses a stable message/event ID for retries. The API may insert ordinary outbox rows; only the worker may publish/consume pg-boss jobs.
- Add Mailpit-backed magic-link, invitation, and notification email templates for development.
- Authenticate Socket.IO handshakes and authorize joins to organization rooms without inventing product events.
- Implement the filesystem/S3 storage interface contract without adding product upload screens or storing media bytes in PostgreSQL.
- Keep UI copy and navigation generic; do not infer product entities, screens, permissions, or realtime events from draft templates.
- Add migrations, fixtures, tests, and documentation needed for these behaviors.

## Prohibited actions

- Do not deploy, access the VPS, configure production OAuth, send internet email, or touch DNS.
- Work on `dev`; do not advance `main` or create `staging`/`production` branches.
- Do not add password authentication unless requirements are explicitly changed.
- Do not add business entities, product workflows, speculative realtime events, billing, or an admin dashboard.
- Do not implement product-specific behavior from any product/design/engineering document under Prompt 03; it requires a later separately authorized prompt.
- Do not allow the API runtime role to install/migrate pg-boss, directly enqueue pg-boss jobs, or use the worker's Valkey credentials.
- Do not auto-link an unverified provider email.
- Do not bypass organization scope in tests, maintenance paths, websocket rooms, caches, jobs, audit queries, or invitations.

## Deliverables

- Better Auth routes and schema integrated with the application database model.
- Magic-link request/consume flows that are hashed at rest, single-use, expire in 10 minutes, and give generic request responses.
- Versioned magic-link/invitation issuance intents, worker-only derivation keys, hash-only application persistence, supersession checks, stable delivery IDs, and no plaintext token or complete action URL in the application database, outbox, pg-boss payloads, logs, audits, traces, or application-backup fixtures.
- Independent development/staging/production action-link keyring schema with purpose/version separation; only the worker may mount it, and rotation overlap/retirement behavior is documented and tested.
- Google provider configuration with exact-origin validation and environment separation.
- Organization creation, switching, membership, invitation, acceptance, resend, revoke, role authorization, removal, ownership transfer, and deletion behavior.
- Server-derived active organization scope for every organization-bound operation.
- Audit events for all events required by `docs/requirements.md`.
- Prepared/committed/cancelled security-tombstone behavior with fail-closed recovery replay/gap handling tests for account/provider/organization/membership/ownership reductions.
- Outbox dispatcher and worker with retry, idempotency, failure classification, and dead-letter/failed-job visibility.
- Development Mailpit messages and no synchronous SMTP dependency in request handlers.
- Authenticated Socket.IO organization-room join/leave core.
- Positive, forbidden-path, concurrency, replay, and cross-tenant tests.

## Verification commands

Run and report the exact repository commands corresponding to:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:auth
corepack pnpm test:organizations
corepack pnpm test:authorization
corepack pnpm test:worker
corepack pnpm test:e2e
```

The test evidence must cover:

- Magic-link deterministic worker derivation, hash-only application persistence, expiration, single use, replay rejection, and identical public responses for existing/non-existing email addresses.
- Auth/OAuth/invitation callbacks emit no-referrer/no-store, exchange immediately to a clean URL, load no third-party resource, and leak no unique token/code sentinel to Referer, browser cache, Caddy/application logs, analytics, or subrequests.
- Crash before hash commit, crash after hash commit, crash after SMTP acceptance, duplicate job delivery, delayed/reordered email, consumed-before-retry, superseded intent, expired intent, and derivation-key overlap/retirement fixtures. Retries must reproduce only the same still-valid link and stable delivery identity; no application fixture may persist a raw token or complete action URL. Prove ten-minute magic-link versus seven-day invitation expiry and reject cross-environment, cross-purpose, retired-version, API, web, and migrate key access.
- Verified-email social linking and rejection of unsafe linking.
- A user creating and switching among multiple organizations.
- Invitation email match, seven-day expiry, replay rejection, resend/revoke races, and authenticated acceptance.
- Owner/editor/member positive and negative cases, including last-owner protection.
- Cross-organization denial at API, database query, cache key, job payload, audit, and Socket.IO room boundaries.
- Append-only audit grants: API/worker required inserts and tenant-scoped reads succeed, but UPDATE/DELETE and schema-wide grant drift fail.
- API rejection when using worker-only pg-boss or Valkey capabilities.
- Request success while SMTP is unavailable, followed by worker retry.

## Approval gates

- Approval is required before changing any role capability or invitation rule in `docs/requirements.md`.
- Approval is required before introducing a new auth provider or login method.
- Creating or changing any OAuth application/callback is deferred to Prompt 05 for staging and Prompt 06 for production and requires its own approval. Prompt 03 may use an already-supplied development-only Google test client without changing provider state; otherwise it uses the mocked Google seam. Production and staging credentials are never used here.

## Stop conditions

- Stop if Better Auth's current supported interfaces cannot satisfy a locked security behavior without a documented custom extension.
- Stop if the Better Auth integration would require plaintext action tokens/complete URLs in application database, outbox, pg-boss, logs, audits, traces, or application backups; do not silently fall back to that design.
- Stop if an authorization rule is ambiguous enough to permit cross-tenant access.
- Stop if tests reveal account-linking, invitation, session, outbox, or tenant-isolation races that remain unresolved.
- Stop after local verification. Do not deploy and do not start Prompt 04.

## Final report format

```text
Outcome: PASS | PASS WITH LIMITATIONS | BLOCKED
Auth behaviors implemented:
Organization behaviors implemented:
Authorization matrix evidence:
Outbox/worker behavior:
Socket.IO core:
Migrations and files changed:
Tests and commands actually run:
Security assumptions and limitations:
External actions performed: none
Approval needed for next action: yes — Prompt 04
```
