# Prompt 04 — Prepare Netcup infrastructure code

## Objective

Create and validate all infrastructure-as-code needed for the Netcup VPS, isolated staging, and later production without connecting to or changing any remote system. Staging is the first remote environment; production remains defined but inactive until Prompt 06.

## Inputs

- Verified application images/builds from Prompts 02 and 03.
- The exact target: Netcup RS 1000 G12, x86-64/KVM, 4 dedicated AMD EPYC cores, 8 GB ECC RAM, 256 GB NVMe, static IPv4, and routed `/64` IPv6.
- Ubuntu 26.04 LTS. If it is absent from Netcup's stock images, an official Ubuntu ISO may be prepared for a later approved custom-ISO installation.
- Cloudflare remains the registrar/DNS authority. Netcup SCP/CCP provide server, console, firewall, PTR, image, snapshot, and account controls.
- Agreed staging, production, and mail hostnames plus the path layout in `docs/infrastructure.md`.
- Local Docker and Ansible validation capability. Real secret values are not required.
- The pull-based deployment contract: GitHub Actions publishes immutable images and an environment-neutral attested application payload for each candidate; Prompt 04 defines a separate immutable shared-infrastructure payload. Each complete-host transition has a signed activation manifest referencing the shared payload plus one application payload per active environment. A root-owned VPS reconciler polls outbound over HTTPS. GitHub-hosted runners never need public SSH access.

## Allowed actions

- Work only on the protected `dev` branch or a feature branch intended for `dev`.
- Create `infra/ansible/` roles, playbooks, and inventory examples for Ubuntu, Docker, SSH hardening, Netcup firewall intent, swap, directories, Docker logging, and systemd integration.
- Create explicit `infra/systemd/` service/timer pairs for the outbound deployment reconciler, six-hour database backup, daily state backup, weekly isolated restore check, host-only Docker/image/log prune, certificate/health checks, and maintenance. Encode the Prompt 05/06 enablement boundary, `Persistent` behavior, randomized catch-up staggering, an effective `TimeoutStartSec` bound for each `Type=oneshot` service, bounded lock wait, and external `OnFailure` alerting from `docs/vps-setup.md`.
- Create `infra/compose.yaml`, `infra/compose.development.yaml`, `infra/compose.staging.yaml`, and `infra/compose.production.yaml`.
- Put the one shared Caddy service in `infra/compose.yaml`. Define separately prefixed and isolated staging and production state/services in their respective overlays.
- Create Caddy configuration, staging Mailpit configuration, production Stalwart templates, Restic scripts, deployment scripts, and runbooks.
- Create and test root-owned installer/activation/mail/Compose/backup code, an unprivileged reconciler service, and a minimal root staging-policy controller. The reconciler accepts only approved GitHub Deployment requests with an immutable shared-infrastructure payload, all per-environment application payloads, signed activation manifest, explicit schema-valid non-secret render inputs, expected rendered-Compose digest, provenance, environment, predecessor, epoch/sequence, and branch/SHA evidence. The installer accepts the manifest path, resolves payloads only from fixed digest-addressed inbox paths, deterministically renders only allowlisted same-environment tokens, and rejects missing, extra, aliased, mismatched, cross-environment, or unresolved inputs. The controller may derive later staging-only records only under an immutable root-owned policy; it cannot authorize production or change that policy. Serialize each complete activation in one root-owned bounded `flock` transaction with the explicit lock order, persistent operation journal/recovery-inhibit marker, and off-VPS replay-checkpoint contract defined in `docs/infrastructure.md`.
- Use secret references or root-readable environment-file paths; never put values in templates.
- Validate Ansible locally and in check mode against a disposable local target. Render both initial host compositions: base+staging, then base+staging+production.
- Validate Caddy and Stalwart configuration locally where supported.
- Document the exact remote read-only discovery and Ansible `--check --diff` commands for Prompt 05 without running them.

## Prohibited actions

- Do not connect to the VPS by SSH, Ansible, Docker context, API, or provider console.
- Do not apply Ansible, firewall, SSH, package, user, directory, systemd, or Compose changes remotely.
- Do not change Cloudflare DNS, Netcup PTR/firewall/Mail block, OAuth clients, GitHub Environments, registry permissions, or mail reputation settings.
- Do not create real secrets, open ports, send internet email, advance `main`, or create `staging`/`production` branches.
- Do not define a second/competing Caddy service. The base file owns the shared service; environment overlays may only add their reviewed edge-network attachment, route configuration input, and read-only public-variants mount.
- Do not enable SeaweedFS, Kubernetes, Kong/APISIX, Prometheus/Grafana, ClamAV, replicas, marketing mail, bulk mail, or end-user mailboxes.
- Do not grant the deployment reconciler repository-content write, package write, shell command, arbitrary Compose-file, or unrestricted root execution capability.

## Deliverables

- Idempotent Ansible code with pinned collections, a committed host-free `hosts.example.yml`, an ignore rule for local `hosts.yml`, control-node requirements, Ubuntu custom-ISO runbook, and Netcup SCP/CCP recovery notes.
- A shared base Compose file containing Caddy; staging with Next.js, Fastify, concurrency-1 worker, PostgreSQL, Valkey, and Mailpit; production with equivalent app/data services plus Stalwart.
- A documented combined 8 GB resource budget that leaves operating headroom and does not assume the optional systems are enabled.
- Docker Compose >=2.33.1 preflight and explicit default gateways: environment APIs through their edge networks, Stalwart through `production-mail-egress`, and workers without public egress.
- Separate migration/API/worker PostgreSQL roles and separate API/worker Valkey ACL users for each environment.
- Read-only application filesystems with explicit writable mounts only where required; no ISR or Next.js image cache dependency.
- Separate public/private media roots. Caddy mounts only each environment's public prepared-variants path; private media always passes through Fastify.
- The initial public tree is publisher/root-owned and read-only to API/worker/Caddy; no worker-writable path is statically served. Define the future no-network regular-file/hash-verifying publisher boundary and symlink/nonregular response tests without enabling a product upload flow.
- Caddy routes for each environment's `/api/*`, `/socket.io/*`, web application, and conditional `/media/*`, including `/api/health/live`, `/api/health/ready`, and protected `/api/health/dependencies`.
- Production Stalwart templates with private administration, internal `mail.<domain>` TLS/SNI, signed/idempotent delivery feedback, transactional-only quotas, and no marketing/bulk-mail capability.
- Netcup firewall and mail-readiness runbooks that keep the default `netcup Mail block` in place through Prompt 05.
- A root-owned-code/unprivileged outbound reconciler plus minimal root staging-policy controller, with distinct least-privilege GitHub App/deployment-status and GHCR pull credentials, signature/provenance verification, replay protection, environment allowlists, immutable/revocable staging policy, production denial, audit records, and no inbound CI SSH.
- An immutable shared-infrastructure payload schema plus an environment-neutral application-payload schema, with provenance/inventory rules and no secrets; shared-infrastructure changes are excluded from routine automatic staging after approval.
- A deterministic local command that builds the shared-infrastructure payload with normalized paths/order/modes/timestamps, records its SHA-256 and inventory in the Prompt 04 report, and proves rebuilding the reviewed commit yields identical bytes. It does not publish the payload.
- Root-sealed activation-manifest releases and tests rejecting missing/extra/mismatched referenced payloads, checksum drift, unsafe archives/Compose features, mutable tags, environment overrides, non-local Docker targets, cross-environment references, and unapproved overlay sets. Production reuses the currently active staging application payload/images in its own block and uses a new production activation-manifest digest.
- A global root-owned host-operation lock plus backup lock with bounded waits, one documented lock order, minimal consistent-snapshot hold time, reconciler deferral, and tests for contention, timeout, killed-process recovery, and active-predecessor revalidation while locked.
- A tmpfiles.d lock-directory rule, systemd ordering, exact ownership/mode/no-symlink checks, and reboot tests proving `/run` lock paths exist before any mutation while the inhibit marker persists under `/var/lib`.
- One `activate-release` transaction wrapper that holds the lock across pull, state start, migration, app/Caddy switch, checks, active-pointer/status commit, checkpoint update, and verified rollback; a separately gated mail-activation wrapper; an atomic/fsynced persistent phase journal and reboot-surviving recovery-inhibit marker; and a schema for the append-only off-VPS deployment epoch/high-water checkpoint.
- A root-owned deterministic renderer and schema: activation manifests carry every concrete non-secret render value; templates use allowlisted tokens; outputs live only under sealed `rendered/`; expected/canonical Compose digests are independently reproduced; secret contents and caller env files are never rendering inputs. Prompt 04 defines placeholders and collision tests for production-only network values but does not choose their live addresses.
- Fixed per-environment edge-subnet/Caddy-IP renderer fields and spoof tests proving Fastify trusts only the exact Caddy peer, never the whole edge subnet or forged headers from web/other containers.
- Host manifests whose initial form is base+staging with `production: null`, whose promotion form is base+staging+production while preserving active staging, and whose later staging form can change only the staging application block while preserving production and shared infrastructure.
- Non-circular evidence schema: activation manifests reference only pre-activation CI evidence; the immutable off-Netcup checkpoint written after host checks is the signed acceptance/outcome record, and production requires the exact successful staging checkpoint digest.
- Reviewed `production-restricted.caddy` and `production-public.caddy` fragments. The manifest selects exactly one, starts restricted with DNS-only source-CIDR enforcement, and requires a separately signed transition to public mode.
- Sharp/libvips pixel, memory, concurrency, and decompression-bomb limits.
- Off-Netcup Restic backup/restore scripts and timers designed for an append-only/non-deleting VPS credential, plus a separate operator-run retention/prune path and tests proving the VPS identity cannot delete history; Netcup snapshots remain supplemental short-lived recovery aids.
- Canonical atomic recovery-set manifests and completion markers covering release/epoch, database, media, Stalwart, configuration/key versions, security-tombstone high-water, and Restic IDs; restore rejects partial, mixed, drifted, or out-of-RPO sets. Add a measured restore-capacity preflight that refuses to breach the 70% action/80% critical thresholds or 20% free reserve and selects only an explicitly approved isolated external restore target when the local workspace is insufficient.
- Deployment, rollback, migration, mail/DNS, backup/restore, compromise, disk-pressure, OOM, and reconciler-failure runbooks.
- A generated-input checklist and reviewed Prompt 05 remote check plan.

## Verification commands

Use repository commands or pinned equivalents and report exact results:

```bash
ansible-playbook --syntax-check infra/ansible/playbooks/vps.yaml
ansible-lint infra/ansible
ansible-playbook --check --diff -i <local-disposable-inventory> infra/ansible/playbooks/vps.yaml
corepack pnpm infra:validate-templates
corepack pnpm infra:test-render -- --fixture staging
corepack pnpm infra:test-render -- --fixture production-restricted
corepack pnpm infra:test-render -- --fixture production-public
corepack pnpm infra:test-caddy -- --fixture staging
corepack pnpm infra:test-caddy -- --fixture production-restricted
corepack pnpm infra:test-caddy -- --fixture production-public
corepack pnpm test:infra
corepack pnpm test:security
corepack pnpm test:host-compose
corepack pnpm test:release-installer
corepack pnpm test:deployment-reconciler
```

The renderer tests must lint source templates as non-runnable inputs, build each fixture through the independent manifest renderer, verify the fixture's canonical `rendered_compose_digest`, and invoke Compose/Caddy validation only on the disposable sealed rendered outputs under a sanitized environment. Also prove that rendered Compose contains no unresolved `@@...@@`, `${...}`, semantic placeholder, or unintended public private-service port; development Caddy is loopback-only with exactly its development site and no remote paths; base+staging has exactly the staging site and no production hostname/upstream/site fragment/media mount/certificate request; the full host has staging plus exactly one selected production fragment; staging cannot access production state or SMTP; production cannot reference staging secrets; the initial manifest cannot activate production; the promotion manifest cannot drop staging; a later staging manifest cannot mutate production/shared infrastructure; the installer rejects missing/extra payloads, digest mismatch, caller env injection, and cross-environment token substitution; workers lack public egress; and the reconciler rejects unsigned, replayed, wrong-epoch/sequence, mutable-tag, wrong-branch, wrong-environment, or unapproved requests. Send unique sentinel magic-link/OAuth/query/cookie/authorization values and prove neither Caddy nor application logs retain them. Exercise concurrent release/backup/restore/maintenance fixtures and prove bounded lock timeout, no reverse lock acquisition, predecessor recheck while locked, and no interleaving across the complete activation transaction. Inject SIGKILL/power-loss at every phase and prove the reboot-surviving inhibit marker blocks reconciliation until a verified commit/rollback recovery; prove a restored local high-water mark cannot override the newer append-only off-VPS checkpoint.

If the pinned Stalwart version has no safe offline validator, document the exact restricted validation procedure for Prompt 06.

## Approval gates

- Any remote connection, including discovery and remote Ansible check mode, belongs to Prompt 05 and requires explicit approval.
- The user must review proposed SSH/firewall changes while provider-console recovery remains available.
- Creating GitHub App credentials, GitHub Environments, GHCR credentials, DNS records, OAuth clients, or secrets requires the corresponding later prompt approval.
- Removing the Netcup Mail block, changing PTR/MX/SPF/DKIM/DMARC, installing production mail secrets, and sending external mail are Prompt 06 gates.
- Restic activation requires an approved repository outside Netcup and recovery credentials.

## Stop conditions

- Stop if the code could remove the only SCP/console/rescue recovery path.
- Stop if either rendered composition contains real secrets, mutable `latest` tags, unresolved placeholders, public private-service ports, unsafe mounts/capabilities, or cross-environment references.
- Stop if the initial manifest contains active production state, if Caddy is duplicated, or if the 8 GB combined budget leaves no safe headroom.
- Stop if deployment requires GitHub-hosted runner SSH access through an admin-only firewall.
- Stop after local validation. Do not connect, provision, deploy, or change any external system.

## Final report format

```text
Outcome: READY FOR NETCUP CHECK | CHANGES REQUIRED | BLOCKED
Infrastructure code created:
Staging-first host composition:
Reserved production composition:
Security and isolation controls:
Pull-based deployment controls:
Local validation commands and results:
Combined 8 GB resource budget:
Proposed Prompt 05 remote checks (not run):
Proposed Netcup/Cloudflare changes:
Secrets still required (names only):
Risks and rollback preparation:
Remote/external actions performed: none
Approval needed for next action: explicit Prompt 05 authorization
```
