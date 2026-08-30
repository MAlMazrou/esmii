# Prompt 05 — Provision Netcup and deploy staging

## Objective

Provision the new 8 GB Netcup VPS and deploy the isolated staging environment first. Establish the outbound pull-based `dev` → staging release path, but keep all production application services, data, Stalwart, public mail, and production DNS inactive.

## Inputs

Prompt 05 may begin with local planning and read-only checks. Each mutation still requires its own approval.

- The Prompt 04 result and exact reviewed commit from protected `dev`.
- Netcup RS 1000 G12 contract/order identifier, server identifier, location, static IPv4, routed `/64` IPv6, target x86-64 platform, SCP/CCP access, and provider-console recovery confirmation.
- An ignored local `infra/ansible/inventories/netcup/hosts.yml` copied from the committed example (or an explicitly approved external inventory path), resolving exactly the reviewed server and not tracked by Git.
- Confirmation that the server is new/empty or an exact inventory of anything that must be preserved.
- Ubuntu 26.04 LTS source and checksum/signature. If it is not a stock Netcup image, an approved official ISO installation plan.
- Administrative SSH public key, non-root admin user, administrative source CIDR or approved VPN path, and emergency recovery owner.
- `<STAGING_APP_DOMAIN>` managed in Cloudflare, a staging-only Google OAuth application, tester-email allowlist, and a noindex requirement.
- After read-only Docker/VPN network discovery, an approved collision-free `<STAGING_EDGE_SUBNET>` and fixed `<STAGING_CADDY_IP>`; Fastify trusts only that peer address.
- Separate staging Better Auth, cookie, database, Valkey, action-link derivation keyring, operations-health token, signing, media, and Mailpit credentials/paths. The derivation keyring is worker-only and independent from production/session keys; the health token is API-only and paired with the reviewed administrator/VPN CIDRs.
- GitHub repository, GHCR package, protected `dev` branch, protected `main` branch, and GitHub staging Environment.
- A least-privilege GitHub App or equivalent deployment-status credential plus a separate read-only GHCR pull credential for the VPS reconciler. Neither credential may write repository contents.
- The exact proposed ongoing automatic-staging policy, if desired: protected `dev` only, unchanged reviewed workflow/reconciler, signed immutable artifacts, expected predecessor, a staging-only state transition that preserves `production: null` initially and the full production/shared state later, passing migration/isolation/resource/smoke gates, and automatic rollback/stop behavior.
- Immutable web/server digests and an attested immutable application payload for the exact `dev` SHA, plus the reviewed Prompt 04 shared-infrastructure commit, deterministic local SHA-256/inventory, intended GHCR OCI artifact identity, and retention policy.
- `<release-id>`, shared-infrastructure and staging-application payload digests/SHA-256/provenance identities, pre-activation CI evidence digest, all explicit staging/shared non-secret render inputs, expected `rendered_compose_digest`, plus a separately signed staging activation-manifest digest containing only base+staging with `production: null`.
- An approved initial deployment epoch/sequence and immutable checkpoint prefix/bucket outside Netcup with versioning/Object Lock/WORM, canonical signed/hash-chained record schema, a VPS conditional-create/list/read but no-overwrite/no-delete/no-unlock credential, and a separate recovery/policy identity. GitHub Deployment status is UI only, not the durable checkpoint.
- External staging monitoring destination, if used.

## Allowed actions

Only after the matching approval gate:

- Inspect SCP/CCP and collect a read-only server/network/firewall/Mail-block baseline.
- Install Ubuntu 26.04 LTS from a verified official ISO only when the host is confirmed disposable and installation is explicitly approved.
- Connect to the verified VPS, record a read-only baseline, and run the reviewed Ansible `--check --diff` command.
- Apply only the separately approved Ansible diff; retain SCP/console/rescue access while changing SSH or firewall policy.
- Configure Docker, the admin account, swap, logging, `/srv/myapp`, systemd units, shared Caddy, root-owned reconciler code running as an unprivileged user, the minimal root staging-policy controller, and staging directories.
- Install the root-owned global host-operation/backup lock protocol. All release, migration, rollback, restore, Docker/network-maintenance, and destructive-prune helpers must use bounded waits and the documented lock order; the reconciler may defer but never bypass a lock.
- Keep inbound SSH limited to the approved admin CIDR/VPN. Let the reconciler use outbound HTTPS to GitHub/GHCR; do not expose SSH to GitHub-hosted runner address ranges.
- Configure the Netcup firewall for staging HTTPS and approved administration. Keep the default `netcup Mail block` enabled.
- Create the Cloudflare staging DNS record and exact staging OAuth callbacks.
- Configure the protected GitHub staging Environment and publish the exact reviewed `dev` candidate once as immutable images and an attested application payload. Under the same explicit registry gate, reproduce the exact Prompt 04 shared-infrastructure bytes from its reviewed commit, require the approved local SHA-256/inventory, independently attest and publish them as an immutable GHCR OCI artifact, and verify the downloaded registry digest before creating/signing the staging activation manifest.
- Install staging secrets through their approved root-readable channel.
- Seal and activate the base+staging release, run `staging-migrate`, and start Caddy, `staging-postgres`, `staging-valkey`, `staging-mailpit`, `staging-worker`, `staging-api`, and `staging-web`.
- Configure tester-email admission, host-only staging cookies, noindex headers, and private Mailpit access.
- Enable the `dev` workflow to create an approved staging Deployment request referencing exact artifact digests. Let the VPS reconciler poll, verify, deploy, run host-local smoke checks, and report deployment status.
- After the first staging release succeeds, install the immutable root-owned policy and activate its controller so later qualifying protected-`dev` candidates can derive exact staging-only approval records and deploy without human per-release approval. Before production exists they preserve `production: null`; after it exists they preserve the complete production block and shared-infrastructure digest while replacing only staging's application block. The reconciler cannot edit the policy; production, out-of-policy shared changes, and any workflow/credential/host/provider/secret/policy/environment-boundary change remain blocked.
- Run staging functionality, authorization, tenant isolation, cross-environment negative, resource, reboot, release rollback, and reconciler-failure tests.

## Prohibited actions

- Do not create or advance `main`; do not create `staging` or `production` branches.
- Do not start `production-*` services, allocate production database/cache/media state, install production secrets, or configure production OAuth clients.
- Do not start Stalwart, remove the Netcup Mail block, change mail PTR/MX/SPF/DKIM/DMARC, open SMTP ports, or send internet email.
- Do not transfer the domain away from Cloudflare or change unrelated Cloudflare settings.
- Do not rebuild images on the VPS or deploy mutable tags.
- Do not expose PostgreSQL, Valkey, Docker, Mailpit, private media, the reconciler, or management endpoints publicly.
- Do not give GitHub-hosted runners public SSH access or give the reconciler arbitrary shell/root/repository-write capability.
- Do not copy production or real customer data into staging.
- Do not initialize a production backup dataset, represent a Netcup snapshot as an offsite backup, or enable deferred services.

## Deliverables

- Verified Netcup server identity, IP/architecture/resources, SCP/console/rescue recovery, firewall baseline, and Mail-block status.
- Ubuntu 26.04 LTS, fully patched host, hardened admin access, Docker, logging, swap, systemd, and idempotent Ansible result.
- Shared Caddy plus isolated, resource-limited staging services and state using immutable digests.
- A root-sealed release whose manifest references the exact shared-infrastructure and staging-application payloads, has `active_compose_files: [infra/compose.yaml, infra/compose.staging.yaml]`, carries the concrete non-secret render inputs, matches its independently computed `rendered_compose_digest`, has a complete staging block, and has `production: null`.
- A durable initial epoch/high-water acceptance record in the immutable off-Netcup checkpoint store containing the post-activation outcome-evidence digest plus the matching local root-owned floor and reboot-surviving operation-inhibit/journal state; duplicate sequence, overwrite, delete, retention-reduction, and predecessor-fork attempts are denied.
- Successful one-shot staging migration and proof that API/worker runtime roles cannot migrate or perform DDL.
- Separate staging database, Valkey ACL users, media roots, auth/session secret/cookie, OAuth clients, networks, and Mailpit.
- Cloudflare staging DNS, valid HTTPS, exact OAuth callbacks, tester allowlist, and noindex behavior.
- Private Mailpit access and proof that staging has no Stalwart/production SMTP credential or route.
- Protected `dev` branch and GitHub staging Environment with an outbound, least-privilege, signed/attested deployment flow.
- An immutable shared-infrastructure OCI artifact whose source commit, local expected SHA-256, GHCR digest, independent provenance, inventory, retention/protection, and VPS-downloaded digest all match the reviewed Prompt 04 result.
- A human-readable and machine-enforced record of whether the ongoing automatic-staging policy is enabled, its exact limits, and its emergency disable procedure.
- Reconciler/controller evidence for unprivileged runtime, immutable policy digest, branch/SHA/environment allowlisting, replay/predecessor protection, staging-only approval derivation, explicit production denial, root-sealed activation, host-local smoke tests, deployment-status reporting, audit log, kill switch, and rejection of malicious requests.
- Host-operation lock evidence covering contention, bounded timeout, killed-process recovery, lock ordering, and active-predecessor revalidation under lock.
- Combined 8 GB memory/disk/CPU evidence with safe headroom for later production activation.
- Tested staging rollback to the preceding compatible staging block or restricted no-app state without modifying `main` or inventing a production release. After production exists, any automatic staging rollback must use a new signed manifest that preserves the complete production block and shared-infrastructure payload.

## Verification commands

Report exact sanitized commands and results. Commands below run only after their named approvals.

Read-only controller checks:

```bash
git check-ignore infra/ansible/inventories/netcup/hosts.yml
test -z "$(git ls-files -- infra/ansible/inventories/netcup/hosts.yml)"
ansible-playbook --check --diff -i infra/ansible/inventories/netcup/hosts.yml infra/ansible/playbooks/vps.yaml --limit <NETCUP_INVENTORY_HOST>
```

After separate apply approval:

```bash
ansible-playbook -i infra/ansible/inventories/netcup/hosts.yml infra/ansible/playbooks/vps.yaml --limit <NETCUP_INVENTORY_HOST>
ansible-playbook --check --diff -i infra/ansible/inventories/netcup/hosts.yml infra/ansible/playbooks/vps.yaml --limit <NETCUP_INVENTORY_HOST>
```

On the verified VPS after secret and complete payload-set plus activation-manifest install approvals:

```bash
hostnamectl --static
uname -m
free -h
df -h
sudo /usr/local/sbin/<app-slug>-install-release <release-id> /srv/myapp/release-inbox/<activation-manifest-digest>.yaml
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> verify
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> config --quiet
```

After separate staging activation approval:

```bash
sudo /usr/local/sbin/<app-slug>-activate-release <release-id> --target staging
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> verify
sudo /usr/local/sbin/<app-slug>-host-compose <release-id> ps
```

From an approved test path:

```bash
curl --fail --silent --show-error https://<STAGING_APP_DOMAIN>/api/health/live
curl --fail --silent --show-error https://<STAGING_APP_DOMAIN>/api/health/ready
corepack pnpm test:environment-isolation
corepack pnpm test:e2e:staging
```

Also prove: `/api/health/dependencies` returns 404 outside the administrator/VPN CIDRs, fails from an allowed CIDR without the staging operations token, and succeeds only with both controls; staging cookies are host-only; Caddy cannot access private media; Mailpit is not public; workers lack internet egress; no production volume, credential, service, or network exists; no SMTP port is open; the Netcup Mail block remains active; the initial host manifest cannot activate production; SSH remains admin-only; a hosted runner never connects inbound; the reconciler rejects unsigned, replayed, wrong-epoch/sequence, mutable, wrong-branch, wrong-SHA, wrong-environment, or unsafe-Compose requests; the single activation transaction cannot interleave with backup/maintenance, persists its phases, and cannot skip predecessor revalidation; the off-VPS checkpoint is newer/equal to local state; reboot recovery works; and resource usage stays below the documented thresholds.

## Approval gates

1. Approval to inspect the named Netcup server/SCP/CCP baseline.
2. If needed, destructive approval to install Ubuntu on the exact confirmed-empty server from the verified ISO.
3. Approval to connect for a read-only host baseline.
4. Separate approval to run the first-host bootstrap Ansible `--check --diff`, with SSH lock-down and host-firewall activation disabled.
5. Separate approval to apply only that reviewed bootstrap diff.
6. Proof of a second keyed named-operator session, its reviewed sudo method, console recovery, and a stable administrator CIDR or approved VPN; then separate approvals for the hardening/firewall `--check --diff` and its exact apply.
7. Approval for Cloudflare staging DNS and staging OAuth-console changes.
8. Approval to configure GitHub branch protection, staging Environment, GitHub App/deployment permissions, and GHCR permissions; publish the exact `dev` application candidate and the exact checksum-matching Prompt 04 shared-infrastructure OCI artifact with independent attestations and recorded retention.
9. Approval to create/install staging secrets and reconciler credentials.
10. Narrow release-install approval naming host, release ID, epoch/sequence, shared-infrastructure and staging-application payload digests/checksums, staging activation-manifest digest/checksum, expected rendered-Compose digest, source SHA, active overlays, concrete non-secret render inputs, exact image digests, and off-VPS checkpoint target; this permits sealing only.
11. Separate staging-activation approval naming the migration, services, smoke plan, resource budget, and rollback target.
12. Optional explicit approval to activate the exact ongoing automatic-staging policy after the first successful staging release. This does not authorize workflow/credential/provider/secret/policy changes or any production action.
13. Approval for any external monitoring mutation.

An approval applies only to its named target and reviewed change set.

## Stop conditions

- Stop if server identity, IP, architecture, storage, recovery access, or confirmed-empty status differs from the input.
- Stop if the Ansible diff risks lockout, removes recovery, exposes private services, discloses a secret, or changes an unrelated resource.
- Stop if a release is unsigned/unattested, uses mutable tags, does not originate from protected `dev`, contains production activation/state, has a missing/extra/mismatched referenced payload, if the reproduced/published/downloaded shared-infrastructure checksum or inventory differs from the approved Prompt 04 result, or if root-sealing checks fail.
- Stop on migration, health, authorization, isolation, TLS, reboot, rollback, or reconciler verification failure.
- Stop on lock bypass, reverse lock order, unbounded wait, stale predecessor after lock acquisition, or concurrent host mutations.
- Stop on OOM kill, sustained swap, unsafe disk pressure, or insufficient headroom for the documented dual-environment plan.
- Stop if the Netcup Mail block is absent or SMTP becomes reachable; restore the safe restriction and report it.
- Stop after staging is healthy and the `dev` → staging path is proven. Do not deploy production.

## Final report format

```text
Outcome: STAGING DEPLOYED | STAGING ROLLED BACK | BLOCKED
Approvals received:
Netcup host and recovery evidence:
Ubuntu/Ansible result:
Staging release ID, source SHA, and image digests:
Active host manifest:
Migration and runtime-role evidence:
Auth/OAuth/mail-capture evidence:
Security and environment-isolation evidence:
Pull-deployment/reconciler evidence:
Ongoing automatic-staging policy: enabled with recorded scope | disabled
Cloudflare and other external changes:
Resource and reboot evidence:
Rollback evidence:
Production status: inactive; production state/secrets absent
Netcup Mail block status: enabled
Commands actually run:
Open risks or manual follow-ups:
Next approval required: Prompt 06 production promotion
```
