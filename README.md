# Esmii

This repository package defines how an implementation agent should start a small, self-hosted SaaS application on one Netcup server. The selected launch host is an x86 Netcup RS 1000 G12 with 4 dedicated cores, 8 GB ECC RAM, 256 GB NVMe, and IPv4 plus IPv6 connectivity. Staging is deployed from successful `dev` CI and production is deployed independently from successful `main` CI, with immutable image identity and isolated runtime state in both environments. The package contains the agreed requirements, architectural constraints, decisions, execution rules, and numbered implementation sequence.

> **Current status: Prompt 05, Prompt 06's initial public application gate, and the separately approved self-hosted mail gate are complete.** Successful `dev` CI runs automatically update the isolated staging application at `https://staging.esmii.app`; successful `main` CI runs automatically update the isolated public production application at `https://esmii.app`. Staging permits exactly the two user-selected tester addresses for both email and Google sign-in, retains `noindex`, and delivers account mail through its own Stalwart sender/credential; the exact tester list stays root-only outside Git. Production Google OAuth, offsite-backup/restore acceptance, external monitoring acceptance, and the final hardened-production acceptance remain disabled until their separate requirements are completed.

Tokens written as `<SEMANTIC_NAME>` are unresolved placeholders, not sample values, and must never be copied into production unchanged. Only rows marked `REQUIRED INPUT` in `docs/decisions.md` must be supplied or approved by the user. SHA/digest/release/evidence/DKIM and similar placeholders are generated, verified, and recorded by the prompt that names them; the agent must not ask the user to invent those values.

## What is in this package

- [`AGENTS.md`](./AGENTS.md) — mandatory operating rules for every implementation agent.
- [`docs/README.md`](./docs/README.md) — documentation map, lifecycle, status, and reading rules.
- [`docs/requirements.md`](./docs/requirements.md) — product and quality requirements for the generic SaaS core.
- [`docs/decisions.md`](./docs/decisions.md) — locked choices, defaults, deferred choices, and required user inputs.
- [`docs/infrastructure.md`](./docs/infrastructure.md) — the canonical infrastructure design and operating constraints.
- [`docs/environments.md`](./docs/environments.md) — development, staging, and production isolation and promotion policy.
- [`docs/vps-setup.md`](./docs/vps-setup.md) — proposed host-change procedure and approval gates.
- [`docs/deployment.md`](./docs/deployment.md) — immutable release, promotion, rollback, and recovery policy.
- [`docs/product/`](./docs/product/) — draft product-requirements, flows, domain, permission, roadmap, and terminology templates.
- [`docs/design/`](./docs/design/) — draft design-system, screen, responsive, accessibility, and content templates.
- [`docs/engineering/`](./docs/engineering/) — draft product data, API, realtime, storage, and testing specifications.
- [`docs/adr/README.md`](./docs/adr/README.md) — format for future architecture decision records.
- [`docs/prompts/README.md`](./docs/prompts/README.md) — numbered implementation sequence and stop rules.

## Source-of-truth order

When instructions disagree, use this order:

1. The user's latest explicit instruction for the current task.
2. [`docs/requirements.md`](./docs/requirements.md) for the approved generic core, together with relevant `APPROVED` files under [`docs/product/`](./docs/product/) for product-specific behavior. Neither may silently override the other; reconcile a conflict explicitly first.
3. [`docs/infrastructure.md`](./docs/infrastructure.md) for approved technology, topology, security, storage, and scaling constraints.
4. [`docs/environments.md`](./docs/environments.md), [`docs/vps-setup.md`](./docs/vps-setup.md), and [`docs/deployment.md`](./docs/deployment.md) for environment and operational procedure.
5. Relevant `APPROVED` design and engineering specifications, within their stated scope. They cannot weaken product, security, infrastructure, or operational requirements.
6. `DRAFT`/`SUPERSEDED` documents, examples, `TBD` entries, and semantic placeholders, which are never implementation authority.

[`docs/decisions.md`](./docs/decisions.md) records the values and approvals supplied under those sources; it cannot override them. The currently authorized numbered prompt limits scope but cannot override a higher-priority source. `AGENTS.md` and this README define working procedure. Existing code and tests are evidence of the implementation, not permission to contradict the documents. If canonical documents genuinely conflict, stop and ask the user rather than guessing.

## How to use the package

1. Read this README, then `AGENTS.md` and `docs/README.md`. Follow that index to `docs/requirements.md`, `docs/infrastructure.md`, `docs/environments.md`, and `docs/decisions.md`. Read `docs/vps-setup.md` and `docs/deployment.md` before production-oriented work, plus every relevant `APPROVED` product/design/engineering document.
2. Resolve every required input marked as a blocker for the next prompt. Record the supplied value in `docs/decisions.md` without recording credentials.
3. Select only the next incomplete prompt in the exact sequence below.
4. Give that single prompt and the canonical documents to the implementation agent.
5. The agent implements only that prompt, runs its required validation, and returns a completion report with changed files, test evidence, assumptions, and remaining blockers.
6. Review the result. Correct or approve it before authorizing the next numbered prompt.
7. Repeat one prompt at a time.

Completing one numbered prompt does **not** authorize the agent to begin the next prompt. The user must explicitly continue the sequence.

The six numbered prompts implement only the generic core. Draft product/design/engineering templates are expected and do not block those prompts. Even an approved product document does not authorize a business module under a generic-core prompt; product implementation requires a later, separately approved prompt.

### Exact prompt sequence

1. [`docs/prompts/01-review-documents.md`](./docs/prompts/01-review-documents.md)
2. [`docs/prompts/02-create-monorepo.md`](./docs/prompts/02-create-monorepo.md)
3. [`docs/prompts/03-build-auth-and-organizations.md`](./docs/prompts/03-build-auth-and-organizations.md)
4. [`docs/prompts/04-prepare-vps.md`](./docs/prompts/04-prepare-vps.md)
5. [`docs/prompts/05-provision-vps-and-deploy-staging.md`](./docs/prompts/05-provision-vps-and-deploy-staging.md)
6. [`docs/prompts/06-promote-staging-to-production.md`](./docs/prompts/06-promote-staging-to-production.md)

For product definition, [`docs/prompts/product-discovery.md`](./docs/prompts/product-discovery.md) is an optional planning aid. It is not a seventh implementation prompt and grants no code or external-action authority. Use it before Prompt 02 if the initial application shell must already reflect product branding/navigation; otherwise complete the neutral core and approve product documents before the first business-module prompt.

### Branch and deployment model

- Normal development and feature pull requests land on the protected `dev` branch.
- A successful `dev` candidate is built once in GitHub Actions, pushed to GHCR by immutable digest, and deployed to the isolated staging environment.
- Under the active Prompt 05 staging exception, the VPS polls the current `dev` SHA and its successful CI run over outbound HTTPS, prefers GHCR digests, and can build that exact successful SHA locally while anonymous GHCR pull is unavailable. GitHub-hosted runners do not SSH to the host.
- A successful `main` CI run publishes immutable full-SHA images and advances only the `:main` convenience pointers.
- The VPS production timer polls outbound, resolves the main pointers to immutable digests, verifies source/revision labels, migrates and health-checks the isolated production runtime, and restores the preceding production overlay if activation fails.
- `main` is never force-moved backward. A failed activation leaves the prior runtime serving while a reviewed fix or forward revert is prepared.
- There are no long-lived `staging` or `production` branches. GitHub Environments, release manifests, credentials, data, domains, and Compose overlays provide environment separation.

### Copy-paste kickoff instruction

Give the first implementation agent this instruction exactly:

> Read `README.md`, `AGENTS.md`, `docs/README.md`, `docs/requirements.md`, `docs/infrastructure.md`, `docs/environments.md`, and `docs/decisions.md` in that order, then inspect every document indexed by `docs/README.md`. Treat the canonical core documents and relevant lifecycle documents marked `APPROVED` as constraints; draft templates are discussion material, not implementation authority. Execute only `docs/prompts/01-review-documents.md`. Do not edit files, access the VPS, create credentials, change DNS, configure mail, or deploy anything during this phase. Return the implementation plan, document-status inventory, unresolved external inputs, and any contradictions, then stop.

## Initial scope

The initial product scope is a reusable SaaS core:

- passwordless magic-link login and approved social login with safe account linking, logout, and session management;
- organizations/workspaces as the tenant boundary;
- owner, editor, and member roles;
- invitations, membership management, organization switching, and tenant isolation;
- the shared application and infrastructure required by those flows.

It deliberately contains no domain-specific business module. Billing, subscriptions, product-specific entities, arbitrary uploads, password authentication, a public developer API, and other business features require separate requirements and later authorization.

The files under `docs/product/`, `docs/design/`, and `docs/engineering/` are intentionally incomplete `DRAFT` templates. Their empty sections neither require nor prohibit features. A user must approve their content before it becomes a constraint, and a later prompt must explicitly authorize any resulting product implementation.

## Local development

Use Node.js `24.20.0`, Corepack with pnpm `11.21.0`, and Docker Compose `2.33.1` or later. From the repository root:

1. Install the exact dependency graph:

   ```bash
   corepack pnpm install --frozen-lockfile
   ```

2. Generate ignored, local-only development credentials and Compose values:

   ```bash
   corepack pnpm dev:prepare
   ```

   This creates `.local/development/secrets/` and `infra/.env.development.local`; do not copy a production or staging environment file into the repository.

3. Build and start disposable PostgreSQL, Valkey, Mailpit, web, API, worker, migration, and Caddy services:

   ```bash
   corepack pnpm dev
   ```

   `corepack pnpm infra:up` is the equivalent explicit infrastructure command. Both wait for the migration and health gates. Prompt 02 deliberately has no seed data or seed command.

4. When a migration-only rerun is needed, use:

   ```bash
   corepack pnpm db:migrate
   ```

   The command builds the shared server image if needed and is safe to repeat against the local development database.

5. Open the application at `http://localhost:8080/` and Mailpit at `http://localhost:8025/`. Use `localhost` for the application so it matches the generated development auth origin and action links. Public API health is available through the same origin at `/api/health/live` and `/api/health/ready`; detailed dependency health also requires the generated local operations token and is not a browser-admin endpoint.

6. Run the checks listed in the next section. Stop services while preserving generated configuration and named-volume data with:

   ```bash
   corepack pnpm infra:down
   ```

7. Deliberately delete only the verified `esmii-development` containers, networks, volumes, and generated local files with:

   ```bash
   corepack pnpm dev:reset
   ```

   This reset is destructive for disposable Esmii development state; it does not target other Docker projects.

### Exercise the local identity core

The default development composition is self-contained and uses only synthetic identities:

1. Open `http://localhost:8080/sign-in`, enter a synthetic address such as `person@example.invalid`, and request a sign-in link. The browser always receives the same accepted response.
2. Open `http://localhost:8025/`, select the latest Mailpit message, and follow its link within ten minutes. A magic link is single-use, and a newer request supersedes an older link.
3. When no real local OAuth client is configured, the Google button uses a local-only verified-provider mock. It does not contact Google, cannot run outside development/test, and uses a fixed synthetic identity.
4. After sign-in, create an organization, create another if desired, switch the active organization, and exercise the account, session, invitation, member, and organization-settings screens permitted by the signed-in role.

Mailpit is a capture sink, not an internet relay. The API transaction records an issuance intent and an application-outbox event without a bearer token or complete action URL. Only the worker mounts the development action-link derivation keyring, publishes/consumes pg-boss work, derives the raw token in memory, stores its hash while the intent remains current, and renders the message for Mailpit. The web, API, and migration processes cannot read that worker-only keyring, and the API has no pg-boss schema access.

Current Valkey-backed abuse limits use environment/bucket-separated HMAC identifiers rather than storing raw email or network subjects in counter keys:

| Operation                                   |    Starting limit |
| ------------------------------------------- | ----------------: |
| Magic-link requests by network              | 30 per 10 minutes |
| Magic-link requests by normalized email     |  5 per 10 minutes |
| Invitation creation by authenticated actor  |       20 per hour |
| Invitation creation by normalized recipient |        5 per hour |
| Invitation resend by authenticated actor    |        5 per hour |
| Invitation resend per invitation            |        5 per hour |

Magic-link throttling and temporary rate-limit-store failure preserve the generic accepted response. Authenticated invitation operations return a safe `429` when a limit is exceeded and a safe `503` when request protection is unavailable. The fixed starting values are recorded as `DEC-DEFAULT-018` in [`docs/decisions.md`](./docs/decisions.md).

## Local command contract

Prompt 02 defines the commands below. The repository includes the exact `pnpm-lock.yaml`; the full local command path, including Docker-backed migration, full-stack, image, and end-to-end checks, was verified on 30 August 2026:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:runtime-config
corepack pnpm scan:secrets
corepack pnpm test:policy
corepack pnpm build
corepack pnpm db:migrate:test
corepack pnpm infra:config
corepack pnpm infra:up
corepack pnpm db:migrate
corepack pnpm image:build
corepack pnpm image:scan
corepack pnpm image:runtime-fixtures
corepack pnpm test:e2e
corepack pnpm infra:down
```

The Compose wrappers log the actual secret-free command before running it. From the repository root, their underlying form is:

```bash
docker --context <VERIFIED_LOCAL_CONTEXT> compose --project-name esmii-development --env-file infra/.env.development.local -f infra/compose.yaml -f infra/compose.development.yaml <OPERATION>
```

When `DOCKER_HOST` explicitly names a local Unix/named-pipe endpoint, the logged selector is `--host <VERIFIED_LOCAL_ENDPOINT>` instead. The wrappers reject remote Docker endpoints/contexts and external builder selection, clear caller Compose target overrides, and pin the exact project, env file, and Compose files shown above.

`db:migrate:test` uses a random disposable Compose project. It verifies empty and repeat migrations, runtime database-role grants and DDL denial, plus the API, worker, and health Valkey ACL boundaries, then removes that project and its volumes without printing credentials.

Prompt 03 adds these focused local test commands. Their presence is not a passing-result claim; report actual results from the current verification run:

```bash
corepack pnpm test:auth
corepack pnpm test:organizations
corepack pnpm test:authorization
corepack pnpm test:worker
```

Prompt 04 adds deterministic, local-only infrastructure validation commands:

```bash
corepack pnpm infra:validate-templates
corepack pnpm infra:test-render -- --fixture staging
corepack pnpm infra:test-render -- --fixture production-restricted
corepack pnpm infra:test-render -- --fixture production-public
corepack pnpm infra:test-caddy -- --fixture staging
corepack pnpm infra:test-caddy -- --fixture production-restricted
corepack pnpm infra:test-caddy -- --fixture production-public
corepack pnpm test:infra
corepack pnpm infra:build-shared-payload
corepack pnpm infra:verify-shared-payload
```

The remote plan and later operational procedures are indexed in [`docs/runbooks/README.md`](./docs/runbooks/README.md). These commands render only synthetic canonical fixtures and do not connect to Netcup, Cloudflare, GitHub, GHCR, or an offsite backup provider.

Do not treat a command definition as passing evidence; use the latest completion report for actual results. Run local/container workloads only in an environment the user has approved. The `dev:reset` command verifies the exact `esmii-development` target before deleting disposable local state.

## Approval boundaries

A numbered implementation prompt may authorize repository-local file changes and proportional local validation. Unless the user separately and explicitly approves it, an agent must not:

- connect to, provision, harden, resize, restart, or otherwise change a VPS;
- modify DNS, reverse DNS, firewall policy, mail reputation settings, or provider configuration;
- push images, change registry settings, configure CI/CD secrets, or deploy a release, except future routine protected-`dev` staging candidates after Prompt 05 explicitly activates the narrow ongoing policy in `docs/decisions.md`;
- send internet email or create production mailboxes;
- create, rotate, reveal, copy, or store production credentials;
- run a migration or destructive operation against any non-local database;
- write to an off-host backup destination;
- delete or reset user data, production state, or an unknown Docker volume;
- add a deferred service or business module merely because the architecture mentions its future path.

Local development must use synthetic data and a safe mail sink. Production data must never be copied into development or fixtures.

Prompt 04 does not authorize Prompt 05, a VPS connection/change, or any provider-console action. Staging OAuth applications/callbacks remain a separately approved Prompt 05 concern, and production OAuth applications/callbacks remain a separately approved Prompt 06 concern.

## Required inputs

The authoritative input register is in [`docs/decisions.md`](./docs/decisions.md). Before the phase that needs each value, the user supplies:

- the existing repository path, GitHub repository name, application name, and stable slug;
- production, staging, and mail domains;
- fixed production prelaunch tester/VPN egress CIDRs so Caddy can restrict the DNS-only production hostname while browser OAuth callbacks are tested;
- the Netcup RS 1000 G12 server ID/location, static IPv4, IPv6 subnet, SSH identity, SCP/CCP recovery confirmation, and administrative source IP or VPN;
- confirmation that the order uses `IPv4 + IPv6 Connectivity`, that Ubuntu 26.04 is available as an SCP image or will be installed from the official ISO, and that the server identity/onboarding checks are complete;
- confirmation that Netcup's removable `netcup Mail block` remains enabled until production mail approval, followed by a recorded exact removal; confirmation that PTR control works in SCP, that low-volume transactional mail is permitted under Netcup's bulk-mail restriction, and that the assigned IP passes reputation checks;
- Cloudflare DNS authority and a scoped DNS-01 credential reference for the mail certificate; the domain does not need to move to Netcup;
- separate Google applications/credentials for production and staging through an approved secret channel;
- the offsite Restic repository/recovery credential references, the immutable off-Netcup deployment-checkpoint prefix needed before staging activation, and the separate encrypted security-tombstone journal needed before production access-lowering operations;
- the external monitoring destination;
- the least-privilege GitHub App deployment-status credential (status/UI only), separate read-only GHCR credential, provenance identity, and protected production-promotion identity references;
- the Netcup abuse-notice response owner and decision on obtaining Netcup's DPA;
- production sender identities and operational mailboxes;
- the phase-specific approvals for remote access, host changes, environment activation, provider changes, backup writes, test mail, and final production acceptance. The initial public `main` application automation is recorded in `DEC-INPUT-024`, and the completed production-mail activation is recorded in `DEC-INPUT-025`; OAuth, backup/restore, monitoring, and final acceptance remain separate.

Semantic placeholders may remain during documentation work. A prompt must stop if an unresolved value would materially change what it builds.

## Definition of a good handoff

At the end of every numbered prompt, the agent should report:

- the prompt completed and whether every acceptance criterion passed;
- files created or changed;
- commands/checks run and their results;
- decisions used and unresolved inputs encountered;
- deviations, if any, with user approval evidence;
- anything intentionally left for a later numbered prompt;
- confirmation that no production or external state was changed unless specifically authorized.

The final production launch is a separate approval gate. Passing local tests or creating Compose files does not mean the application is deployed, recoverable, or ready to accept users.
