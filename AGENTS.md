# Agent operating contract

This file applies to every agent working in this repository. It is a working contract, not a suggestion.

## Package status

The repository contains the **active branch-to-environment application paths** after the reviewed bootstrap, WireGuard/passwordless-sudo, rescue-recovery, SSH/UFW hardening, DNS, CI publication, staging/initial-production, and self-hosted-mail gates. Prompts 02–04 retain their recorded evidence. The saved ignored inventory uses the VPN operator and hardened flags; public root/operator SSH is denied, UFW is active, and management SSH is restricted to `10.77.0.2`. Successful protected-`dev` and protected-`main` CI runs publish immutable candidate images; separate root-owned outbound timers automatically migrate and activate the exact successful revision in isolated staging and production runtimes. `https://staging.esmii.app` and `https://esmii.app` serve the real Esmii application. On 31 August 2026 the user selected exactly two staging tester addresses for both email and Google sign-in while retaining `noindex`; the exact list stays root-only outside Git, and staging account mail uses its own Stalwart sender/credential without mounting the production worker SMTP credential. Production Google OAuth, offsite-backup/restore acceptance, external monitoring acceptance, and final production-hardening acceptance remain inactive until their own inputs exist. Do not claim those deferred capabilities merely because the public application and email-login paths are reachable.

The implementation is intentionally divided into numbered prompts. Execute exactly one authorized prompt at a time. Finishing a prompt is a stop point, not permission to continue.

## Read before acting

Before making changes:

1. Read `README.md`.
2. Read `docs/README.md` and use it to identify document status and scope.
3. Read `docs/requirements.md` completely.
4. Read `docs/infrastructure.md` completely.
5. Read `docs/environments.md` completely.
6. Read `docs/decisions.md` completely. Also read `docs/vps-setup.md` and `docs/deployment.md` before production-oriented work.
7. Read every relevant `APPROVED` product/design/engineering document and inspect related `DRAFT` documents only for unresolved questions.
8. Read the single numbered prompt authorized by the user.
9. Inspect the current repository and preserve unrelated user changes.
10. Identify unresolved required inputs and approval gates before implementation.

Do not infer the intended business product from the infrastructure. The initial requirements cover only a generic SaaS account and organization core.

## Source-of-truth priority

Use the following priority, highest first:

1. The user's latest explicit instruction for the current task.
2. `docs/requirements.md` for the approved generic core together with relevant `APPROVED` documents under `docs/product/` for product-specific behavior. A conflict between them requires explicit reconciliation; specificity is not permission to weaken core security.
3. `docs/infrastructure.md` for approved technology, topology, security, storage, and scaling constraints.
4. `docs/environments.md`, `docs/vps-setup.md`, and `docs/deployment.md` for environment and operational procedure.
5. Relevant `APPROVED` files under `docs/design/` and `docs/engineering/`, within their stated presentation or derived-contract scope.
6. `DRAFT`/`SUPERSEDED` documents, examples, `TBD` entries, and semantic placeholders, which are never production values or authority to act.

`docs/decisions.md` records resolved values and approvals under those sources; it cannot override them. The currently authorized numbered prompt limits current scope but cannot override a higher-priority source. `AGENTS.md` and `README.md` define process. Existing implementation and tests are evidence of current behavior. A lower-priority source cannot override a higher-priority source. If two canonical documents genuinely conflict, stop, describe the exact conflict, and request a decision. Do not resolve it by preference.

When a direct user instruction changes a recorded requirement or decision, update the relevant canonical document in the same authorized change so the repository does not retain two truths.

## Documentation lifecycle

- `DRAFT` means discussion material only. It cannot authorize implementation, expand a prompt, or block the generic core merely because a section is empty.
- `APPROVED` means the user explicitly reviewed the document. It constrains only its stated scope and only work authorized by the current prompt.
- `SUPERSEDED` is historical and must link to its replacement; it is not active guidance.
- `TBD` remains unresolved in every status. Never fill it with an assumption.
- An agent cannot approve its own proposal or infer approval from the file's existence.
- A product/design/engineering document cannot silently weaken authentication, tenant isolation, authorization, recovery, infrastructure, or deployment rules. Update the affected canonical documents and decision register under explicit approval first.

## Numbered-prompt gate

- Execute the next prompt in the exact recorded sequence. An earlier prompt may be rerun for correction, but do not skip an incomplete prerequisite prompt unless the user first approves a documented sequence change.
- Work only within the selected prompt's deliverables and acceptance criteria.
- Approved product documents provide context but do not expand the current numbered prompt. Product implementation needs a separately authorized future prompt.
- Do not pre-build work assigned to later prompts.
- Do not add “helpful” business modules, services, dashboards, providers, or abstractions outside the current scope.
- At completion, stop and return the required evidence. Wait for explicit authorization before the next prompt.
- If the prompt depends on an unresolved `REQUIRED INPUT`, pause at that decision rather than embedding a guess in code.

An agent may make small reversible implementation choices within a locked architecture when they do not change product behavior, security posture, external state, cost, or a documented decision. Record material choices in `docs/decisions.md`; do not turn trivial code details into architecture decisions.

The exact order is:

1. `docs/prompts/01-review-documents.md`
2. `docs/prompts/02-create-monorepo.md`
3. `docs/prompts/03-build-auth-and-organizations.md`
4. `docs/prompts/04-prepare-vps.md`
5. `docs/prompts/05-provision-vps-and-deploy-staging.md`
6. `docs/prompts/06-promote-staging-to-production.md`

`docs/prompts/product-discovery.md` is an optional documentation-planning aid, not part of this numbered execution order. Running it does not authorize code, numbered-prompt progression, or external action.

## Branch and environment contract

- `dev` is the protected integration branch and the only normal destination for development work. Feature branches may merge into `dev`; do not make ordinary implementation commits directly on `main`.
- A successful `dev` candidate is built once, identified by its full Git SHA and OCI digests, and deployed to staging. A staging deployment never authorizes production.
- `main` is the production source branch. A successful `main` CI run publishes immutable full-SHA images and advances only the `:main` convenience pointers; the root-owned production timer resolves those pointers to digests, verifies image source/revision labels, migrates, health-checks, and rolls back on failure.
- Production and staging remain separate data, credential, media, network, and mail domains. A failed production activation keeps the preceding production runtime even though `main` may be newer; repair or revert forward rather than force-moving `main` backward.
- Do not create `staging` or `production` branches. Environment identity comes from the release manifest, isolated configuration/state, and GitHub Environments—not extra long-lived branches.
- Prompt 01 is read-only. Repository implementation work normally lands on `dev`. Prompt 06 owns the `main` production path; its initial public application gate was explicitly authorized on 30 August 2026.

## Change boundaries

### Allowed within an authorized implementation prompt

- Create or edit repository files explicitly required by that prompt.
- Add tests, fixtures using synthetic data, and documentation necessary to validate the prompt.
- Run read-only inspection and proportionate local checks.
- Start disposable local development services if the prompt calls for them and their targets are verified as local.
- Add a dependency only when it directly supports an approved decision and the current deliverable; pin it through the repository lockfile.

### Requires separate explicit user approval

- Any VPS login or change, including packages, users, SSH, firewall, swap, Docker daemon, directories, services, or resizing.
- DNS, reverse DNS/PTR, domain registrar, CDN, or provider-firewall changes.
- Publishing an image, package, release, branch, or deployment to an external environment, except future routine protected-`dev` staging candidates after Prompt 05 has explicitly activated the exact ongoing automatic-staging policy in `DEC-LOCK-037`.
- Installing a root-only release approval record, sealing a signed activation manifest plus every immutable shared/application payload it references on the VPS, pulling its images, or activating any service, except later staging-only records/transitions derived exactly by the already approved immutable `DEC-LOCK-037` policy; production and out-of-policy changes remain separate approvals.
- Creating or changing CI/CD secrets, registry credentials, production variables, or external backup repositories.
- Creating, rotating, revealing, or installing any staging or production secret, OAuth credential, signing key, or private key.
- Starting internet-facing Stalwart delivery, sending real mail, or creating production mailboxes.
- A production or shared-database migration, seed, restore, or destructive command.
- Destructive changes to user data, media, mail, backups, Docker volumes, or unknown files.
- Adding a provider dependency, paid service, or deferred infrastructure component.
- Moving to the next numbered prompt.

Repository code that describes an external change is not authorization to perform that change.

The active branch automation is narrow: `dev` may update only staging and `main` may update only production through their installed root-owned outbound timers. Both require successful push-triggered CI, immutable image resolution, matching OCI source/revision labels, one shared host lock, migrations, health checks, and environment-local rollback. Workflow, credential, provider, mail, OAuth, backup, or environment-boundary changes still require a new explicit decision.

## Secrets and sensitive data

- Never commit real credentials, tokens, private keys, cookies, mail, production data, database dumps, or backups.
- Do not use plausible-looking fake secrets. Use named placeholders such as `<BETTER_AUTH_SECRET_FILE>` in documentation and inert local-only values generated by documented development tooling when code exists.
- Do not print secret-bearing environment variables or rendered secret files in logs or completion reports.
- Browser-visible configuration must never contain server, database, cache, SMTP, storage-admin, migration, deployment, or backup credentials.
- Production secrets belong outside Git in the locations defined by `docs/infrastructure.md`.
- Use only synthetic users, organizations, emails, and media in development tests.

## Product scope rules

The approved core is generic SaaS identity and organization functionality. It must not assume an industry or invent domain entities.

The shared tenant vocabulary is:

- **user** — an authenticated human identity;
- **organization** — the tenant/workspace boundary;
- **membership** — the relationship between one user and one organization;
- **role** — `owner`, `editor`, or `member` within an organization;
- **invitation** — an expiring, single-use offer to join an organization.

Use these names consistently unless the user records a different product vocabulary in `docs/decisions.md`.

Do not create billing, subscription, commerce, CRM, project-management, analytics, chat, or other business modules without explicit requirements. Do not create public upload features merely because a storage adapter is part of the architecture.

Files under `docs/product/`, `docs/design/`, and `docs/engineering/` begin as deliberately incomplete templates. Their presence or emptiness is not a requirement. Only approved content may inform an explicitly authorized product prompt.

## Implementation principles for future prompts

- Keep one pnpm monorepo and a modular-monolith backend.
- Use passwordless magic links and the approved social providers. Do not add password authentication unless the user first changes the canonical requirements and decisions.
- Keep browser-safe contracts separate from server-only database and credential code.
- Validate request and response boundaries with shared schemas.
- Enforce authorization server-side using both resource identity and organization scope.
- Deny cross-tenant access even when identifiers are guessed or supplied directly.
- Keep durable state in PostgreSQL; treat Valkey and realtime messages as disposable.
- Commit state before notifying clients; clients refetch authoritative data.
- Make jobs and external side effects idempotent and observable.
- Run schema migrations once through the migration entrypoint, not on API startup.
- Keep local media behind a storage interface; PostgreSQL stores metadata, not ordinary file bytes.
- Use same-origin web/API/auth/realtime routing.
- Prefer the smallest solution already approved; deferred technology requires a measured trigger and approval.

## Quality and evidence

Each implementation prompt must define its own acceptance criteria. At minimum, future code changes should be covered proportionately by:

- formatting, lint, and type checks;
- focused unit tests;
- integration tests against disposable local dependencies when persistence or queues are involved;
- end-to-end tests for user-visible flows;
- negative authorization tests, especially cross-organization access;
- migration validation from an empty schema and, when relevant, the previous schema;
- rendered Compose/config validation for infrastructure changes;
- documentation updates for new commands, inputs, or decisions.

Do not claim success from a plan, generated file, or passing build alone. Report the actual checks run and any validation that could not be completed.

## Completion report

End each authorized prompt with:

1. **Outcome** — completed, partially completed, or blocked.
2. **Scope** — the exact numbered prompt executed.
3. **Changes** — concise list of files and behavior changed.
4. **Evidence** — checks run and their results.
5. **Decisions** — recorded decisions and required inputs used.
6. **Deferred work** — explicitly excluded later-prompt items.
7. **External state** — confirmation that no external/production state changed, or exact approved changes if it did.
8. **Next gate** — stop and ask the user whether to authorize the next numbered prompt.

If blocked, provide the smallest concrete question needed to continue. Never disguise an unresolved product or production decision as an implementation detail.
