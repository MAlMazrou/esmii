# Requirements: generic SaaS identity core

**Status:** approved documentation baseline; Prompts 02–05 are implemented, Prompt 06's public application path is active, and its separately approved production-mail gate is active. Production Google OAuth, offsite-backup/restore acceptance, external monitoring acceptance, and final hardened-production acceptance remain separate unresolved gates.
**Scope:** passwordless identity, organizations, memberships, invitations, authorization, and the supporting application services.  
**Not defined here:** the application's eventual domain-specific product.

This document defines required behavior. Technology choices belong in [`decisions.md`](./decisions.md). Infrastructure, environments, host operations, and deployment belong in [`infrastructure.md`](./infrastructure.md), [`environments.md`](./environments.md), [`vps-setup.md`](./vps-setup.md), and [`deployment.md`](./deployment.md). Numbered prompts divide the work into separately approved increments; they may not weaken these requirements.

The document lifecycle and complete map are in [`README.md`](./README.md). Files under `docs/product/`, `docs/design/`, and `docs/engineering/` begin as intentionally incomplete `DRAFT` templates. They carry no implementation authority and do not block the generic core. Later `APPROVED` product specifications may extend separately authorized product work, but they cannot silently weaken this core's authentication, tenant-isolation, authorization, security, or recovery rules; reconcile and approve any conflict in the affected canonical documents first.

## 1. Objective and boundaries

Create a secure, understandable SaaS core on which separately specified business capabilities can later be built. A person must be able to authenticate without a password, create or join organizations, select an active organization, and operate only within organizations to which they currently belong.

The core must remain generic. It must not invent customers, vendors, bookings, orders, projects, subscriptions, billing, or any other product entity. A document that describes a future capability is not authorization to implement it.

## 2. Actors and vocabulary

| Term | Definition |
|---|---|
| User | One human account identity |
| Organization | The tenant/workspace and authorization boundary |
| Membership | The relationship between one user and one organization |
| Owner | Organization role that controls membership, ownership, and destructive organization actions |
| Editor | Organization role that may list members and create, resend, or revoke invitations for `editor` and `member`; it cannot grant ownership or manage existing memberships |
| Member | Organization role that may use organization features but cannot administer membership or invitations |
| Invitation | An expiring, revocable, single-use offer for one verified email to join one organization in one role |
| Platform operator | A deployment operator; not automatically an organization member and not a public product role |

A user may belong to multiple organizations. Every role is scoped to a single membership; a role in one organization grants no permission in another.

## 3. Requirement language

- **Must** is required for acceptance.
- **Should** is the approved default unless a reason to vary is documented and approved.
- **May** is optional and must not be implemented early merely because it is mentioned.
- `<SEMANTIC_NAME>` is an unresolved placeholder, never a literal production value. User responsibility is defined only by `REQUIRED INPUT` rows in `docs/decisions.md`; build/release/digest/evidence/DKIM placeholders are generated and verified by their named phase.

## 4. Authentication requirements

### AUTH-001 — Registration policy

Production permits open passwordless self-registration through the approved magic-link and Google login methods. A newly verified user may create an organization or remain without one until invited. Staging uses an explicit server-side access mode and currently permits only the two user-selected tester addresses through both email and Google sign-in. The tester list remains root-only outside Git. Google availability is still environment-configured, and hiding a button is never the enforcement layer.

### AUTH-002 — Initial login methods

The approved core is passwordless:

- short-lived email magic links;
- Google OAuth/OIDC.

Google enablement is environment-configured and must not appear usable when unconfigured. Microsoft and Apple were removed from the active provider scope by direct user instruction on 30 August 2026; their dormant compatibility paths must not be configured, exposed, or treated as deployment inputs. Passwords, password-reset flows, SMS login, and security questions are not part of the core.

### AUTH-003 — Magic-link request

- The public response must be indistinguishable for existing, non-existing, invited, disabled, and otherwise ineligible emails.
- Requests must be rate-limited by network and normalized email without enabling account enumeration.
- A valid token must be high entropy, stored only as a secure hash, bound to its intended email and purpose, expire after ten minutes, and become invalid when superseded or consumed.
- Async delivery uses a versioned issuance intent, never a plaintext-token outbox/job payload. The worker deterministically derives the high-entropy token in memory from a dedicated rotating key plus the current intent identity/purpose/email, atomically stores only its hash if that intent is still current, and can rederive the same value for a safe retry. The derivation key is never stored in PostgreSQL, the outbox, pg-boss, logs, or mail state.
- Creating an account from a magic link must obey AUTH-001.
- Request handlers must persist an outbox event and return without synchronously depending on SMTP.

### AUTH-004 — Magic-link consumption

- Consumption must be atomic and single-use; concurrent or replayed consumption must yield at most one session.
- Expired, superseded, malformed, and already-used links must fail safely.
- The email proven by the link becomes a verified identity only after successful consumption.
- Action links must not be retained by analytics, referrer leakage, application logs, or audit metadata.
- Every auth/OAuth/action callback response sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, performs the server-side exchange immediately, and redirects to a query/fragment-free clean URL. Token/code-bearing routes load no third-party resources and are excluded or query-redacted from edge/application analytics and access logs.

### AUTH-005 — Social provider validation

- Validate exact callback origin, state, nonce, issuer, audience, signature, and provider-specific requirements using supported Better Auth/provider interfaces.
- Accept an email identity only when the provider marks it verified under the provider's documented semantics.
- Provider errors must not disclose tokens, claims, or internal configuration.

### AUTH-006 — Identity linking

- Automatic linking is allowed only when the authenticated provider supplies a verified canonical email that exactly matches an existing verified identity and the selected provider policy permits it.
- Never auto-link an unverified email, a missing email, or a merely similar/provider-transformed email.
- All other linking requires an already authenticated user to initiate and complete a provider-specific linking flow.
- Linking, unlinking, and rejected-link attempts must be audited. A user must not remove their final usable login method.

### AUTH-007 — Email identity handling

- Email comparison must use one documented case-insensitive canonicalization rule and a database uniqueness constraint.
- Do not remove dots, plus tags, or apply provider-specific mailbox transformations.
- Invitation matching uses the same canonical form.
- Changing a primary email is deferred unless an approved flow preserves identity uniqueness, re-verifies the new address, protects pending invitations, and audits the change.

### AUTH-008 — Sessions and logout

- Better Auth sessions must be database-backed and represented by Secure, HttpOnly, host-only cookies in production.
- SameSite and lifetime values must be explicit per environment.
- Logout invalidates the current session server-side.
- Users must be able to inspect active sessions, revoke another session, and revoke all other sessions without seeing token material.
- Identity-link, email, ownership, and other security-sensitive changes require recent authentication and rotate or revoke affected sessions.

### AUTH-009 — Privileged access

- Organization ownership transfer and organization deletion require recent authentication.
- The core has no application-level platform-operator role, API, or dashboard. VPS/deployment operators remain out-of-band and never inherit organization permissions.
- Any future application-level operator surface requires separate requirements for private access, MFA, audit, authorization, emergency use, and revocation before it is implemented.

## 5. Organization and authorization requirements

### ORG-001 — Tenant boundary

Every organization-owned record must carry an organization identifier. Every server-side read, mutation, job, cache key, audit query, and realtime audience involving tenant data must be scoped to that organization.

Client-supplied identifiers, route parameters, hidden controls, and an “active organization” value are not authorization by themselves. The server must derive the authenticated user, resolve their current active organization, and verify current membership and permission for every organization-bound operation.

### ORG-002 — Organization creation

- Any verified user may create multiple organizations and becomes owner of each organization they create.
- Creation must atomically create the organization and the creator's owner membership.
- The organization has an immutable internal ID, a display name, and a stable normalized locator/slug.
- Locator uniqueness is enforced by the database.
- Accidental client retries must not create duplicate organizations.

### ORG-003 — Membership integrity

- A user may have at most one active membership in an organization.
- Removing a membership ends API, cache, job, and Socket.IO-room access immediately.
- Historical audit records remain intact when a membership changes.
- A person cannot alter their own role to gain privilege.
- Concurrent operations must preserve role and ownership invariants.

### ORG-004 — Role matrix

| Capability | Owner | Editor | Member |
|---|:---:|:---:|:---:|
| View organization | Yes | Yes | Yes |
| List organization members | Yes | Yes | No |
| Update own minimal profile | Yes | Yes | Yes |
| Update organization name/settings | Yes | No | No |
| Create, resend, or revoke invitations for `editor`/`member` | Yes | Yes | No |
| Add or remove a non-owner membership | Yes | No | No |
| Change member and editor roles | Yes | No | No |
| Add/remove/transfer owner authority | Yes | No | No |
| Request organization deletion | Yes | No | No |

Editors can manage pending `editor`/`member` invitations but cannot create owners, transfer ownership, delete the organization, remove members, or change an existing member's role. Business-feature permissions do not exist until the corresponding business requirements are written.

### ORG-005 — Last-owner and ownership transfer

- Every active organization must have at least one active owner.
- The last owner cannot leave, be removed, or be demoted.
- Ownership transfer must identify the target verified member, require recent authentication, run transactionally, and create an audit event.
- If acceptance is required, the source remains owner until the target accepts.
- Concurrent transfer/removal requests must not leave the organization ownerless.

### ORG-006 — Active organization

- A multi-organization user can list and switch among current memberships.
- The server stores or derives the active organization for the authenticated session.
- Switching requires membership verification and atomically changes the server-side selection.
- Switching clears or partitions tenant-specific browser and server cache state and leaves the previous Socket.IO room.
- Direct requests for another organization remain forbidden unless the user explicitly switches through the authorized flow.

### ORG-007 — Deletion state

Prompt 03 must implement safe organization deletion behavior without inventing permanent legal retention:

- only an owner with recent authentication may initiate it;
- the user must explicitly confirm the organization identity;
- the operation atomically marks the organization deleted, revokes pending invitations, disables normal memberships/access, clears active-organization selections, leaves realtime rooms, and records an audit event;
- the organization disappears from normal lists immediately;
- the action is idempotent and concurrent requests cannot partially delete state;
- physical purge, backup expiry, and restoration are deferred until separate lifecycle requirements are approved.

No scheduled hard purge may be enabled in production before the retention and recovery policy exists.

## 6. Invitation requirements

### INV-001 — Create, resend, and expire

- Owners and editors may invite. Editors may target only `editor` or `member`; ownership is granted only through an owner-authorized role/ownership flow.
- An invitation names one organization, one canonical email, one target role (`editor` or `member`), creator, creation time, and expiry.
- Invitations expire after seven days.
- Secrets are high entropy, stored securely, single-use, and never shown in member-list responses.
- Create/resend is rate-limited and idempotent enough to prevent duplicate active invitations and email floods.
- Resend supersedes the prior usable secret without extending a consumed or revoked invitation.

### INV-002 — Accept

- The authenticated user's verified canonical email must match the invitation.
- Acceptance atomically validates state/expiry/email, creates or reactivates one membership in the invited role, consumes the invitation, records audit, and creates the required post-commit notification/invalidation.
- Expired, revoked, consumed, replayed, wrong-email, wrong-organization, and deleted-organization invitations fail closed.
- A user without an account may complete an allowed magic-link or social-registration flow first; an invitation never silently creates an unverified privileged account.

### INV-003 — Revoke and inspect

Owners and editors can list pending invitations without token material, distinguish pending/expired/accepted/revoked state, and safely handle revoke/resend/accept races. An editor may revoke or resend only invitations whose target role is `editor` or `member`; owner-only authority remains server-enforced.

## 7. Audit requirements

### AUDIT-001 — Required events

Append-only audit events are required for:

- successful/failed sensitive login and magic-link consumption events;
- session revocation;
- provider link/unlink and rejected unsafe linking;
- organization creation, ordinary setting changes, and deletion request;
- active-organization switch where operationally useful;
- invitation create, resend, acceptance, expiry, and revocation;
- membership add/remove, role changes, and ownership transfer;
- privileged operator action, if any.

### AUDIT-002 — Safe event shape

Events record time, actor ID, organization ID when applicable, action, target identifiers, result, request/correlation ID, and minimal safe metadata. They must not contain raw magic links, OAuth codes/tokens/claims, cookies, email bodies, secrets, credentials, or secret-bearing URLs.

Organization-bound audit reads obey the same tenant authorization as other organization data. Audit records are not rewritten when a user or membership changes.

API and worker database roles have only the exact audit INSERT and authorized tenant-scoped SELECT grants they need; neither may UPDATE or DELETE audit history. Migration-owner maintenance remains separately gated and audited. Permission tests must catch future schema-wide grant drift.

### AUDIT-003 — Recovery-safe security tombstones

Production access-lowering changes must survive database point-in-time rollback. Account disable/deletion, provider unlink, membership removal/demotion, ownership transfer, organization deletion, and equivalent authorization reductions use a signed, encrypted, append-only off-VPS security-tombstone journal with a separate least-privilege create-only application credential and operator-only recovery/read authority.

Before the local mutation, the server appends a minimal opaque `prepared` record with a unique event ID and affected account/organization/membership scope. The database transaction applies the restriction and ordinary audit event with that same ID; afterward the server appends a `committed` marker. A prepared record without a committed/cancelled resolution is treated as fail-closed for the affected scope during recovery. Success is not reported before the committed marker is durable. Development and staging use a capture/fault-injection adapter and never write the production journal.

Recovery replays all journal records newer than the restored database's tombstone high-water mark before edge/writes open. A missing sequence, unreadable record, or ambiguous scope keeps that affected account/organization disabled; if scope cannot be proven, tenant access remains globally closed pending explicit reconciliation. Removed/demoted users must never regain restored privilege merely by reauthenticating.

## 8. API, cache, and data behavior

### API-001 — Contracts and errors

Every public endpoint declares request/response schemas, authentication, authorization, input limits, and a stable error shape. Public errors include a stable code, safe message, and request ID without stack traces, SQL, secrets, or another tenant's existence.

### API-002 — Lists and retries

Lists use bounded pagination and deterministic ordering. Race- and retry-sensitive operations use database constraints, transactions, and idempotency keys or equivalent protections.

### API-003 — Same-origin and proxy trust

Web, API, auth, and Socket.IO share one production origin. Credentialed CORS is never wildcard. Fastify trusts forwarded client data only from the defined Caddy boundary.

### API-004 — Active scope

Organization-bound handlers derive the active organization from authenticated server state. A body/header/query organization ID may identify a resource but cannot replace this check. Query helpers must make unscoped tenant reads difficult and tests must demonstrate direct-ID denial.

### API-005 — Health-route exposure

`/api/health/live` and `/api/health/ready` are public, minimal, and contain no dependency names, versions, addresses, credentials, or error detail. `/api/health/dependencies` is not a product-admin feature: Caddy accepts it only from the reviewed administrator/VPN CIDRs, then Fastify requires a separate environment-specific high-entropy operations-health token mounted only into the API. A disallowed source receives 404 even with a token; an allowed source without a valid token fails; the approved one-shot operator/monitor path succeeds. Host-local service health checks use direct minimal endpoints and do not need the external token.

### DATA-001 — Durable and disposable state

PostgreSQL is authoritative. Valkey may contain cache, rate-limit, and coordination state only. A Valkey flush must not lose an account, membership, invitation, audit event, active organization truth, or job.

Development, staging, and production use separate Valkey identities and key/channel prefixes. The API and worker use different ACL users.

### DATA-002 — Database roles and migrations

The migration role owns reviewed DDL and installs/updates the pinned pg-boss schema. API and worker runtime roles cannot run DDL. The API cannot directly publish/consume pg-boss jobs; it may insert ordinary transactional outbox rows. The worker dispatches outbox rows and owns only the pg-boss runtime capabilities it needs.

## 9. Jobs, mail, and realtime

### JOB-001 — Transactional outbox

Magic-link, invitation, and important notification requests are inserted into an application outbox in the same transaction as their source state. A worker dispatches them to pg-boss and performs delivery. Handlers require stable idempotency keys, bounded retry, timeout, failure classification, exhausted/dead visibility, correlation IDs, and graceful shutdown.

An unavailable SMTP service must not cause an otherwise valid API transaction to fail. The queued effect remains visible for retry.

For magic-link and invitation action links, the durable outbox/job payload contains only a versioned issuance-intent ID and safe routing metadata. It never contains a raw token, complete action URL, email body, or derivation key. The worker checks supersession/expiry before every send, derives the token only in memory, uses a stable message/event ID, and treats crash-after-commit or crash-after-SMTP-acceptance retries as duplicate delivery of the same single-use link. A later issuance supersedes the earlier link even if email delivery is reordered.

### MAIL-001 — Required templates

The generic core requires accessible text and HTML templates for:

- magic-link login;
- organization invitation;
- ownership/membership security notification where required by the flow.

Development and automated tests use Mailpit/captured delivery only. After the approved self-hosted-mail gate, production submits through Stalwart. Staging may submit account/auth messages for its allowlisted testers through the same Stalwart service only with its own sender and credential; it may not mount the production worker credential or send marketing/bulk mail.

An SMTP server necessarily receives the rendered message and may persist it in its delivery queue until success, expiry, or bounce handling; the recipient mailbox also retains its copy. Therefore the application hash-only rule applies to PostgreSQL application tables, outbox rows, pg-boss payloads, logs, audit events, traces, and test fixtures—not to the minimum transient mail-queue/message state required for delivery. Stalwart data and backups require strict host permissions and encryption, bounded queue/message retention, and no message-body journaling. Magic-login links remain single-use for ten minutes; invitation acceptance remains single-use through the invitation's seven-day expiry and additionally requires an authenticated verified account with the exact normalized email.

### MAIL-002 — Delivery state and safety

SMTP acceptance means queued, not delivered. Persist stable message/event IDs and enough state to distinguish pending, attempted, accepted, bounced, suppressed, and exhausted outcomes where applicable. Signed delivery/bounce feedback binds the current recovery epoch, is replay-safe/idempotent, and uses an explicit per-message/recipient transition state machine that cannot regress a terminal state after database restore. Email bodies, action tokens, and provider credentials are redacted from logs.

### RT-001 — Organization rooms

- Socket.IO authenticates the handshake from the same session model as HTTP.
- Room membership is server-authorized from the current active membership.
- Switching organization, losing membership, logout, or deletion leaves the previous room.
- Events are emitted only after commit and contain identifiers/version hints, not the sole copy of state.
- Clients refetch authoritative data.
- Prompt 03 implements only the organization-room core; no product event, chat, or presence feature is invented.

## 10. Storage and media boundary

Prompt 03 may define and test a filesystem/S3 storage interface but must not add an upload screen, public upload API, or product media model without separate media requirements and explicit authorization.

When media is later approved:

- PostgreSQL stores metadata, ownership, status, checksums, and storage keys—not ordinary file bytes;
- local development, production, and staging have separate public/private roots;
- private delivery always reauthorizes; public media uses only explicitly public processed variants;
- types, sizes, pixel limits, quotas, retention, and deletion must be approved first.

## 11. User-interface requirements

Prompt 03 must provide coherent, responsive interfaces for:

- requesting and consuming magic links, including expired/replayed/failure states;
- enabled social provider login and safe provider errors;
- logout and session inspection/revocation;
- first-organization onboarding when policy allows;
- organization list and active-organization switch;
- invitation acceptance and invalid/expired/wrong-email states;
- owner membership/role/ownership/deletion controls and owner invitation controls;
- editor member-list and editor/member invitation controls;
- editor/member views that omit unavailable actions while the API independently denies them;
- minimal account and organization settings;
- clear forbidden, not-found, empty, loading, and recoverable failure states.

Keyboard operation, visible focus, correct labels, associated errors, and semantic structure are required. WCAG 2.2 AA is the target. Representative mobile and desktop widths must be tested. Use restrained generic English copy and semantic application-name configuration for this core; localization, RTL, and product branding wait for separate product requirements.

## 12. Security and privacy requirements

- Deny by default and test positive and negative permission paths.
- Apply network- and identity-aware rate limits to login, invitations, linking, and other abuse-sensitive paths.
- Redact authorization headers, cookies, magic links, OAuth values, secrets, email bodies, and defined personal fields.
- Collect only minimal account/organization fields required here.
- Do not put provider credentials or any server-only value into browser-visible variables.
- Use synthetic users, organizations, email addresses, and media in development/CI.
- Permanent account/organization purge, export, audit-retention changes, and backup-expiry behavior require separate lifecycle requirements before implementation.

## 13. Development and quality requirements

### DEV-001 — Deterministic local onboarding

After Prompt 02, one documented path must let a contributor install the pinned toolchain, create ignored local configuration, start disposable PostgreSQL/Valkey/Mailpit, run migrations/seeds, start web/API/worker, run checks, stop without deleting data, and deliberately reset only verified local state.

### DEV-002 — Configuration contract

Configuration is typed, validated at startup, and split into browser-safe and server-only fields. Provider enablement and environment identity are explicit. A missing value fails clearly without printing other values.

### DEV-003 — Required test evidence

Prompt 03 tests must cover:

- magic-link deterministic worker derivation, hash-only persistence, ten-minute expiry, single use, supersession, retry/crash/reordered-delivery behavior, replay/concurrency rejection, and identical request responses;
- unique token/OAuth-code sentinels proving no Referer, cache artifact, edge/application log, analytics event, subrequest, or third-party resource receives the action URL before the clean redirect;
- invitation-link deterministic derivation, hash-only application persistence, seven-day expiry, authenticated exact-email acceptance, supersession, and replay rejection;
- worker-only keyring access, environment/purpose/key-version separation, allowed overlap, and retired/cross-environment key rejection;
- application database, outbox, pg-boss, log, audit, trace, and application-backup fixtures contain no plaintext magic-link/invitation token or complete action URL; mail-capture assertions instead prove bounded retention, protected storage, and no message-body logging because SMTP delivery necessarily handles the rendered link;
- provider verification and safe/unsafe identity linking;
- multi-organization creation/switching and server-derived active scope;
- owner/editor/member allow and deny cases;
- last-owner and ownership-transfer races;
- prepared/commit/cancel security-tombstone behavior, offsite failure handling, monotonic sequence/gap detection, and restore fixtures proving disabled/deleted/unlinked/removed/demoted/transferred privileges cannot reappear;
- invitation email matching, seven-day expiry, resend/revoke/accept races, and replay rejection;
- deletion-state authorization, idempotency, access revocation, and no physical purge;
- cross-organization denial in API/query/cache/job/audit/Socket.IO boundaries;
- API inability to use worker-only pg-boss/Valkey capabilities;
- API/worker inability to update/delete audit history while required inserts and authorized tenant reads work;
- API success during SMTP outage followed by worker retry;
- principal flows at browser level plus mobile/desktop accessibility checks.

### DEV-004 — Environment safety

Local development and CI do not connect to or mutate production/staging VPSs, DNS, OAuth applications, mail, databases, media, registries, or backup repositories. Prompt 04 creates and validates infrastructure code locally; it also performs no remote action.

## 14. Core acceptance criteria

The generic core is complete only when its numbered prompts supply evidence for every applicable item. This checklist does not authorize executing multiple prompts together.

- [x] Prompt 02 produces the documented monorepo, local environment, migrations, health behavior, CI-equivalent checks, and no external state changes.
- [ ] Magic-link and enabled social login behavior meets AUTH-001 through AUTH-009 without password authentication.
- [ ] Organization, active-scope, role, membership, ownership, invitation, and deletion-state behavior meets ORG-001 through INV-003.
- [ ] Owner/editor/member and cross-tenant negative tests fail closed at every listed boundary.
- [ ] Audit events meet AUDIT-001/AUDIT-002 and contain no prohibited values.
- [ ] Outbox/worker behavior remains durable and request handling tolerates SMTP outage.
- [ ] Mailpit captures required local messages; no internet mail is sent in Prompts 02–04.
- [ ] Socket.IO rooms authenticate, authorize, leave on scope loss, and refetch after post-commit events.
- [ ] The UI passes focused accessibility and responsive checks for implemented flows.
- [ ] No production credential, live data, runtime state, mail material, dump, or backup is committed.
- [x] Prompt 04 produces locally validated, approval-ready infrastructure code without connecting to the VPS.
- [ ] Prompts 05 and 06 remain separately gated external operations.

## 15. Out of scope until separately required

- Password authentication, password reset, SMS login, and security questions
- Any domain-specific business entity or workflow
- Billing, subscriptions, invoicing, and payments
- SAML, SCIM, enterprise directory provisioning, or authentication providers beyond Google
- Public API keys, developer portal, or API monetization
- End-user uploads, media library UI, video processing, and antivirus scanning
- Physical account/organization purge and data-export workflow
- Public platform-administration dashboards
- Chat, presence, collaborative editing, and speculative realtime events
- Marketing, newsletters, campaigns, broadcasts, bulk email, and general end-user mailbox hosting on this Netcup server
- SeaweedFS/S3 without a separately approved need and resource budget, Kubernetes, Kong/APISIX, dedicated brokers/identity/realtime servers, and heavyweight observability
- Any VPS, DNS, provider, registry, backup, or production action before its numbered prompt and explicit approval

An out-of-scope item requires its own behavior, acceptance criteria, resource impact, and user authorization before implementation.
