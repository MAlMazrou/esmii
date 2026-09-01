# Environments

## 1. Purpose and host assumption

This project has three environments: disposable local development, always-on staging, and production. The first remote host is one Netcup RS 1000 G12 with 4 dedicated x86-64 cores, 8 GB ECC RAM, 256 GB NVMe, static IPv4, and a routed `/64` IPv6 network.

Staging and production share that machine and the one public Caddy instance, but they remain separate security and data domains. This is useful isolation, not high availability: a host, provider, disk, kernel, or Caddy failure can affect both environments.

Cloudflare remains the registrar and authoritative DNS provider. Netcup supplies compute, SCP/CCP recovery, network/firewall controls, PTR, images, snapshots, and the default mail restriction.

As of 31 August 2026, the separately approved mail gate has removed that default mail restriction and activated Stalwart. Staging submits account/auth mail only for its two allowlisted testers through a separate staging sender and SMTP credential; it does not receive the production worker credential. Its private Mailpit remains non-public but is no longer the staging worker's delivery route.

## 2. Environment matrix

| Concern | Development | Staging | Production |
|---|---|---|---|
| Where it runs | Developer machine | Netcup VPS | Same Netcup VPS |
| First activation | Prompt 02 | Prompt 05 | Prompt 06 |
| Compose | base + development | base + staging | base + staging + production on the host |
| Public edge | local port | shared Caddy, staging hostname | shared Caddy, production hostname |
| PostgreSQL | `development-postgres` | `staging-postgres` | `production-postgres` |
| Valkey | `development-valkey` | `staging-valkey` | `production-valkey` |
| Email | Mailpit | separate Stalwart sender/credential for allowlisted testers; private Mailpit retained | Stalwart after mail approval |
| Security tombstones | local capture/fault adapter | isolated capture/fault adapter | isolated capture initially; encrypted append-only off-Netcup journal after its gate |
| Auth secret/cookie | development-only | staging-only | production-only |
| OAuth clients | optional local Google | staging-only Google client | disabled initially; separate production-only Google client after its gate |
| Media roots | disposable local | `/srv/myapp/staging/media/{public,private}` | `/srv/myapp/production/media/{public,private}` |
| Data retention | disposable | disposable test data | durable customer data |
| Backup | none | excluded from production Restic dataset | Restic repository outside Netcup |
| Deployment source | working tree | successful protected `dev` candidate | successful tagged and versioned protected `main` candidate |
| User access | developer | exactly two user-selected tester addresses; `noindex` retained | public application; provider availability remains environment-configured |

## 3. Rules that apply everywhere

- Images are built in CI and deployed by immutable registry digest. The VPS never builds application images.
- Next.js runs as standalone SSR with ISR and built-in image optimization disabled initially.
- Each environment uses one origin for web, `/api/*`, `/socket.io/*`, and approved `/media/*` routes.
- `/api/health/live` and `/api/health/ready` are public and minimal. `/api/health/dependencies` requires operator authorization and must not disclose credentials or sensitive topology.
- Only prepared, public, content-hashed media variants may be served by Caddy. Private media always passes through Fastify authorization.
- Environment-prefixed containers, volumes, networks, credentials, cookies, OAuth clients, and filesystem roots are mandatory.
- Development cannot route through Stalwart. Staging may use only its separately scoped sender and credential for allowlisted tester account mail; it cannot read or mount the production worker SMTP credential.
- Development/staging cannot receive the production security-tombstone journal credential or route; only production API receives its create-only identity, while recovery/read/delete authority remains off-host.
- Runtime roles cannot perform database migrations. API and worker use separate database roles and separate Valkey ACL users.
- Workers have no public default route. APIs receive only the egress explicitly required by product behavior.
- No production data is copied to development or staging.
- No mutable `latest` tag is a release identity.

## 4. Development

Prepare and start the verified local-only Compose target through the repository wrappers:

```bash
corepack pnpm dev:prepare
corepack pnpm dev
```

The wrappers select only the `esmii-development` project, generated ignored environment file, base Compose file, and development overlay, and reject a remote Docker target. The development overlay contains local PostgreSQL, Valkey, Mailpit, migration job, worker, API, and Next.js services. Development state is disposable and must never reuse remote credentials.

Use `http://localhost:8080/sign-in` for the browser flow and `http://localhost:8025/` for the Mailpit inbox. A synthetic email magic-link request returns a generic accepted response; the worker later derives the link in memory and sends it only to Mailpit. The default Google button uses a local/test-only verified-provider mock when a real local client is absent. This mock is not a staging or production OAuth application.

The development API mounts neither the action-link derivation keyring nor pg-boss runtime access. It writes only the issuance intent and application outbox. The development worker alone mounts the environment/purpose/version-separated keyring, derives the raw token, persists only its hash, dispatches/consumes pg-boss work, and submits to Mailpit. Development Valkey holds only disposable HMAC-keyed abuse counters using the fixed starting thresholds in `DEC-DEFAULT-018`.

The Google callback is optional locally. Providers outside the active Google-only scope remain disabled and unconfigured.

Prompts 03 and 04 are completed and locally verified on `dev`. Prompt 05 is complete and its `dev` timer automatically updates staging after successful CI. Management SSH is key-only for `esmii-administrator` through `10.77.0.1`; UFW permits only VPN-scoped SSH plus public WireGuard and web traffic, and the Netcup provider firewall is unchanged. On 30 August 2026 the user authorized a separate public `main` application timer and public `esmii.app` DNS. Production Google OAuth, external mail, real-user onboarding, backup acceptance, and final hardened-production acceptance remain inactive.

## 5. Initial remote state: staging first

Prompt 05 activates only:

- shared `caddy` from `infra/compose.yaml`;
- `staging-postgres`;
- `staging-valkey`;
- one-shot `staging-migrate`;
- `staging-worker` with concurrency 1;
- `staging-api`;
- `staging-web`;
- private `staging-mailpit`, retained as an operator-only capture service but not used by the staging worker;
- an isolated staging SMTP credential mounted only in `staging-worker` for account/auth delivery through Stalwart.
- a staging-owned copy of Stalwart's public TLS trust certificate mounted read-only in `staging-worker`; no mail private key is shared.

The first root-sealed host manifest uses the complete schema in `docs/deployment.md`. Its environment/overlay state includes this abbreviated shape:

```yaml
active_compose_files:
  - infra/compose.yaml
  - infra/compose.staging.yaml
rendered_compose_digest: sha256:<BASE_STAGING_RENDER_DIGEST>
shared_infrastructure_payload_digest: sha256:<SHARED_INFRASTRUCTURE_PAYLOAD_DIGEST>

environments:
  staging:
    application_payload_digest: sha256:<STAGING_APPLICATION_PAYLOAD_DIGEST>
    source_sha: <DEV_SOURCE_SHA>
    app_domain: <STAGING_APP_DOMAIN>
    web_digest: sha256:<STAGING_TESTED_WEB_DIGEST>
    server_digest: sha256:<STAGING_TESTED_SERVER_DIGEST>
  production: null
```

Production secrets, volumes, databases, cache, media roots, OAuth clients, Stalwart, and application services must not be initialized during Prompt 05.

### Staging access

The staging application is reachable by HTTPS for the Google callback and permits only the two user-selected tester addresses. It remains bounded by:

- an explicit server-side `allowlist` mode with a non-empty root-only tester set applied to both email and Google sign-in;
- host-only staging cookies with a unique name and signing secret;
- `X-Robots-Tag: noindex, nofollow, noarchive` and an appropriate `robots.txt`;
- no production data;
- an optional Cloudflare Access layer only if it is proven not to break OAuth callbacks or automated tests.

Mailpit, database/cache ports, deployment controls, dependency health, Stalwart management, and administration remain private through their existing network/VPN boundaries.

GitHub-hosted runners do not SSH to the host. Post-deployment smoke tests run locally on the VPS through the root-owned reconciler and report GitHub Deployment status outbound over HTTPS. Browser E2E from CI may target the public HTTPS staging hostname with synthetic data; it receives no administrative network access.

## 6. Production activation

For the current initial application gate, an accepted `main` change is first converted into a bot-owned semantic release commit and immutable `vX.Y.Z` tag. Only that tagged revision is dispatched to CI; successful CI publishes immutable full-SHA images and advances `:main`. The separate production timer resolves the pointers to digests, verifies source/revision/version labels, and activates only production. It starts publicly at `esmii.app` with Google OAuth disabled. This is the user's 30 August 2026 branch-automation decision plus the 1 September 2026 pre-build versioning requirement; the sealed sequence remains the target for final backup, recovery, and hardened-production acceptance.

Prompt 06 promotes the exact currently active staging-tested application-payload and image digests. It does not rebuild them. It creates a new signed production activation manifest because the host transition adds `infra/compose.production.yaml` while keeping staging active. The manifest references one unchanged shared-infrastructure payload plus a separate application payload in each environment block; its digest/signature live in the external deployment/sealed-release envelope to avoid a self-hash. Its abbreviated environment/overlay state is:

```yaml
active_compose_files:
  - infra/compose.yaml
  - infra/compose.staging.yaml
  - infra/compose.production.yaml
rendered_compose_digest: sha256:<FULL_HOST_RENDER_DIGEST>
shared_infrastructure_payload_digest: sha256:<SHARED_INFRASTRUCTURE_PAYLOAD_DIGEST>

environments:
  staging:
    application_payload_digest: sha256:<CURRENT_STAGING_APPLICATION_PAYLOAD_DIGEST>
    source_sha: <CURRENT_STAGING_SOURCE_SHA>
    app_domain: <CURRENT_STAGING_APP_DOMAIN>
    web_digest: sha256:<CURRENT_STAGING_WEB_DIGEST>
    server_digest: sha256:<CURRENT_STAGING_SERVER_DIGEST>
  production:
    application_payload_digest: sha256:<SAME_CURRENT_STAGING_APPLICATION_PAYLOAD_DIGEST>
    source_sha: <SAME_STAGING_TESTED_SOURCE_SHA>
    app_domain: <PRODUCTION_APP_DOMAIN>
    web_digest: sha256:<SAME_STAGING_TESTED_WEB_DIGEST>
    server_digest: sha256:<SAME_STAGING_TESTED_SERVER_DIGEST>
    edge_mode: restricted
    prelaunch_test_cidrs:
      - <REVIEWED_TESTER_OR_VPN_CIDR>
```

The full staging block and shared-infrastructure digest must be preserved. After production exists, a later qualifying staging-only activation may replace only the staging application block while preserving production. A shared-Caddy/Compose change must be declared and reviewed explicitly as a host-wide transition.

Production uses separate PostgreSQL, Valkey, media, secrets, cookies, OAuth clients, networks, and Stalwart credentials. It starts with `production_edge_mode: restricted`, a DNS-only Cloudflare application record, and the reviewed `<PRELAUNCH_TEST_CIDRS>` Caddy allowlist. A tester completes OAuth through a fixed/VPN egress address in that list; an external disallowed source must receive 403. After all OAuth, mail, backup/restore, monitoring, security, smoke, resource, and rollback gates pass, a new signed activation manifest may select the already reviewed public production fragment only under the separate public-launch approval. It is based on the currently active predecessor, preserving whatever staging block is current and the verified restricted production non-edge block; a staging advance never authorizes rolling staging backward for launch.

The actual public-launch gate was later approved directly, and the production-mail gate is now active in `external` mode. Only IPv4 TCP 25 is publicly published for mail transfer; operational IMAPS remains loopback-only, and Stalwart management remains bound only to the private production mail-admin network. The production worker submits as `noreply@esmii.app` over certificate-verified STARTTLS. This operational status does not waive the still-unresolved backup/restore, monitoring, production Google OAuth, mail-feedback, or final acceptance gates.

## 7. Branch and promotion model

- Feature branches merge by pull request into protected `dev`.
- A successful `dev` candidate is built once, tested, published to GHCR by digest, and deployed to staging.
- After Prompt 05 explicitly activates the narrow ongoing policy, later qualifying protected-`dev` candidates may deploy automatically through the unchanged signed/reconciled path; workflow, credential, provider, secret, or policy changes require new approval.
- The staging release record stores source SHA, immutable shared-infrastructure and staging-application payload digests, staging activation-manifest digest, image digests, test results, and deployment status.
- Every accepted `main` change first produces the bot release commit, `CHANGELOG.md` update, and immutable `vX.Y.Z` tag; only then does the release workflow dispatch CI for that exact protected-main SHA.
- Successful versioned `main` CI publishes a separate immutable production candidate and advances only the `:main` convenience pointers.
- The VPS production timer resolves those pointers to digests, verifies the exact main SHA plus repository/version labels, and updates only production.
- A failed production activation leaves the preceding production runtime serving even though `main` may be newer; repair or revert forward rather than force-moving `main` backward.
- A later runtime rollback creates a new signed activation manifest that preserves current staging/shared infrastructure and restores only the previous compatible production block. It never reactivates an old whole-host manifest. Then a reviewed forward rollback/revert commit records the restored live code tree; `main` is never force-pushed backward.
- Merge that forward rollback/revert record back into `dev` before another production promotion so `main` remains an ancestor of the candidate.
- The root-sealed host release manifest is authoritative for the exact runtime image/configuration digests. Git branches are development and audit history, not a substitute for the manifest.
- Do not create long-lived `staging` or `production` branches.

## 8. Pull-based deployment transport

GitHub Actions and the VPS communicate without inbound CI SSH:

1. CI tests the protected source and publishes digest-pinned images plus an attested immutable application payload; Prompt 04 separately owns the reviewed shared-infrastructure payload.
2. The approved GitHub Environment signs a complete-host activation manifest and creates a GitHub Deployment request containing the environment, source SHA, shared-infrastructure digest, every active environment's application-payload digest, all explicit non-secret render inputs, expected rendered-Compose digest, activation-manifest digest, and image digests.
3. A root-owned systemd reconciler on the VPS polls outbound over HTTPS.
4. It accepts only expected branches/environments, verifies provenance/signatures and replay state, downloads with a read-only GHCR credential, and invokes fixed root-owned validation/activation wrappers.
5. Host-local health/smoke checks run after activation.
6. A least-privilege GitHub App credential reports deployment status. It cannot write repository contents; branch updates remain a protected GitHub workflow/manual approval action.

Administrative SSH remains limited to the approved admin CIDR/VPN. Never open SSH broadly to dynamic GitHub-hosted runner ranges.

## 9. Isolation requirements

Before production activation, prove all of the following:

- staging database credentials fail against production PostgreSQL and vice versa;
- staging Valkey credentials fail against production ACLs and vice versa;
- neither environment can mount the other's media roots;
- cookies differ in hostname, name, and signature and are rejected cross-environment;
- OAuth applications and callback origins are separate;
- staging has no production SMTP credential, `production-mail-submit` access, Restic credential, security-tombstone journal, or production signing credential; its separate SMTP identity reaches Stalwart only through `staging-mail-submit`;
- staging Mailpit is not public;
- production backups exclude staging;
- production activation does not recreate or alter staging containers/state/digests; shared Caddy may reload, but its staging fragment/digest and behavior remain unchanged;
- both workers lack public internet egress;
- Caddy reads only each environment's public prepared-variants directory.

## 10. Resource budget for the 8 GB host

Initial Compose limits are conservative caps to be tuned from measurements:

| Component | Suggested cap |
|---|---:|
| Shared Caddy | 96 MB |
| Staging PostgreSQL | 384 MB |
| Staging Valkey | 128 MB |
| Staging web | 256 MB |
| Staging API | 256 MB |
| Staging worker | 192 MB |
| Staging Mailpit | 128 MB |
| Production PostgreSQL | 768 MB |
| Production Valkey | 256 MB |
| Production web | 384 MB |
| Production API | 384 MB |
| Production worker | 256 MB |
| Production Stalwart | 512 MB |

These caps total roughly 3.9 GB. The remainder is reserved for Ubuntu, Docker, page cache, migrations, media-processing bursts, backup/restore work, and safety headroom. Configure PostgreSQL/Valkey internal memory settings consistently with the container caps; limits alone are insufficient.

Render distinct database/cache configurations. The starting PostgreSQL values are staging `shared_buffers=64MB`, `max_connections=20` and production `shared_buffers=128MB`, `max_connections=40`, with pool/worst-case tests. Valkey starts at `maxmemory=72MB` under the 128 MB staging cap and `160MB` under the 256 MB production cap. Runtime/cgroup tests must prove allocator/process/query headroom before acceptance.

Operating rules:

- investigate sustained total RAM above 70%;
- treat sustained 75%+, active swap during normal load, or any OOM kill as an immediate capacity incident;
- keep worker concurrency at 1 until measured evidence supports a change;
- never enable optional monitoring stacks, replicas, SeaweedFS, ClamAV, or search clusters merely because RAM is 8 GB;
- serialize migrations, heavy image processing, restore tests, and other bursty maintenance when necessary;
- alert on disk at 60%, act at 70%, and treat 80% as critical;
- keep at least 20% of the 256 GB disk free and maintain off-provider backups.

If normal operation cannot retain headroom, optimize first, then use a compatible vertical upgrade when Netcup supports it or migrate to a larger host through the documented recovery path. Scaling to multiple hosts later still requires externalizing state, shared object storage, connection pooling, a multi-instance realtime adapter, and tested orchestration; it is not automatic.

## 11. Acceptance checklist

- A clean clone starts development with the documented command.
- Prompt 05 brings up base+staging only.
- Prompt 06 adds production without dropping or silently changing staging.
- `dev` deploys an exact immutable candidate to staging.
- Production promotion reuses the same tested digests with manual approval.
- `main` production CI runs only after the semantic release commit/tag and follows the documented forward-repair rollback rule.
- GitHub-hosted runners never require inbound host SSH.
- Cross-environment access tests fail in every forbidden direction.
- Development captures mail in Mailpit. Staging and production submit through Stalwart only with separate senders, credentials, and internal submission networks; staging remains limited to its two allowlisted testers.
- Netcup's Mail block remains in place until the Prompt 06 mail gate.
- Production Restic data leaves Netcup and passes an isolated restore test.
- The combined host remains within memory, disk, CPU, and rollback headroom thresholds.
