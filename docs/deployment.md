# Deployment, promotion, rollback, backup, and monitoring

## 1. Deployment contract

### Current branch-triggered application policy

On 30 August 2026 the user replaced the planned manual application-promotion trigger with direct environment branch automation:

- successful `dev` CI publishes immutable full-SHA images, advances only `:dev`, and the VPS staging timer activates them;
- successful `main` CI publishes immutable full-SHA images, advances only `:main`, and the VPS production timer activates them;
- both timers resolve mutable convenience pointers to immutable digests, verify OCI source/revision labels, serialize through one host lock, run migrations and health checks, and restore the preceding environment overlay on failure;
- staging and production keep separate databases, Valkey instances, media roots, credentials, networks, cookies, and captured-mail state;
- the initial public production application gate does not activate external SMTP, production Google OAuth, real-user onboarding, offsite-backup acceptance, or final hardened-production acceptance.

This current policy controls application delivery where older sections below describe manual exact-staging-digest promotion. The sealed manifest design remains the target for later mail, backup, recovery, and fully accepted production transitions.

The target is one Netcup RS 1000 G12 running Ubuntu 26.04 LTS with 4 dedicated x86-64 cores, 8 GB ECC RAM, 256 GB NVMe, static IPv4, and routed IPv6. Cloudflare remains authoritative DNS.

The release flow is:

```text
feature branch -> PR -> protected dev
                         |
                         v
               CI builds/tests once
                         |
                         v
        immutable GHCR images + attested application payload
                         |
                         v
             automatic staging Deployment
                         |
                         v
          host pull + staging verification/status
                         |
                 manual production approval
                         |
                         v
       same staging-tested application payload/images in production
       unchanged shared-infrastructure payload
          new signed production activation manifest
                         |
                         v
            production verification/status
                         |
                         v
             fast-forward protected main
```

There are no long-lived `staging` or `production` branches. `dev` is the integration/staging source. `main` records the code tree verified live in production. The root-sealed release manifest, not a branch name or mutable tag, is authoritative for exact runtime digests.

### 1.1 Active Prompt 05 staging automation

The user authorized a smaller staging-only delivery path on 30 August 2026 so ordinary `dev` changes can reach the VPS without GitHub receiving SSH access. The active path is deliberately limited:

1. `ci.yaml` runs the complete repository checks for a `dev` push and publishes full-SHA web/server images. Only after every required job succeeds does it advance the two `:dev` staging pointers.
2. The root-owned `esmii-staging-pull.timer` polls outbound every two minutes. It accepts only the current `dev` head with a successful push-triggered `ci.yaml` run and requires matching source/revision OCI labels.
3. The host prefers immutable GHCR digest references. While anonymous GHCR pull is unavailable, it downloads and builds only that exact successful public `dev` SHA on the VPS, tags the result with the full SHA, and verifies the same OCI source/revision labels before activation.
4. The host renders only the staging overlay, runs the one-shot migration, starts the isolated staging services, checks public HTTPS health, and restores the preceding Compose overlay or the temporary demo if activation fails.
5. The timer has no repository-write permission or public listener. GitHub-hosted runners never receive VPS SSH, Docker, WireGuard, database, OAuth, or application-secret access.

This exception automates staging only. It does not deploy from `main`, create production services, promote to production, open mail, or authorize a later workflow/credential/host/policy change. Prompt 06 must review the active staging evidence and choose the production promotion mechanism explicitly; `main` remains CI-only until then.

## 2. Repository automation

Expected workflows:

```text
.github/workflows/
├── ci.yaml
├── build-release.yaml
├── deploy-staging.yaml
├── promote-production.yaml
└── rollback-production.yaml
```

Security scanning is part of `ci.yaml`. Real backup/restore execution belongs to the root-owned host systemd units; GitHub Actions never receives VPS/Restic credentials and never connects to the host for a restore. CI may test backup scripts against disposable local fixtures only.

During the active Prompt 05 exception, `ci.yaml` also publishes the verified dev candidate and the VPS timer performs the staging-only pull described above. The additional workflow files in the expected final layout remain future production/promotion work, not evidence that they already exist.

### 2.1 Pull requests and `dev`

Pull requests run:

- frozen-lockfile install;
- formatting/lint/type checks;
- unit and integration tests;
- empty-database and upgrade migration tests;
- authorization and cross-tenant tests;
- Compose rendering for development, staging-first, and full host compositions;
- secret scanning;
- dependency and container scanning;
- application E2E tests where practical.

Workflow supply-chain policy is day-one: set top-level `permissions: {}` and grant each job only its required scopes; pin every third-party action to a reviewed full commit SHA; let Dependabot/Renovate propose reviewed pin updates; never run untrusted code with secrets through `pull_request_target`; and release environment secrets only after protected checks/approvals. Reusable workflows inherit no broader token permission than their caller needs.

Protect `dev` with required reviews/checks and disallow direct or force pushes. Feature work merges into `dev`.

### 2.2 Build once

After a protected `dev` merge, CI:

1. repeats required checks;
2. builds the web and server images for the verified VPS platform;
3. publishes immutable Git-SHA tags to GHCR;
4. resolves registry-reported image digests;
5. generates an immutable, environment-neutral application payload containing the exact image references, migration inventory, SBOM/provenance, and test-evidence references, but no Compose files, shared infrastructure, activation manifest, or secrets;
6. signs or attests images and the application payload with GitHub OIDC-based provenance;
7. records source SHA, digests, dependency locks, and test results.

No later environment rebuild is allowed. A source, lockfile, image, or application-payload change creates a new candidate and must pass staging again. Prompt 04 locally and deterministically produces the reviewed shared-infrastructure payload containing Compose/Caddy/non-secret host configuration and records its expected checksum without publishing it. Under Prompt 05's separate registry approval, CI reproduces the exact bytes from the reviewed commit, requires the approved checksum, independently attests them, and publishes an immutable GHCR OCI artifact. The VPS then verifies the downloaded registry digest/checksum. Each host transition gets a signed activation manifest that references that shared-infrastructure payload plus one application payload for each active environment. This lets staging advance while production safely remains on its older tested application payload. Changing shared infrastructure is never a routine automatic staging update.

Build-once also means environment-neutral client/server images. Do not pass environment-specific build arguments or `NEXT_PUBLIC_*` values. Client code uses same-origin relative routes; any required browser-safe environment metadata comes from a typed allowlisted runtime SSR/API payload. CI searches the built standalone output/client chunks for staging/production domains, OAuth IDs, cookie names, mail hosts, and sentinel secrets, then runs the same image digests under separate staging and production runtime fixtures.

### 2.3 GitHub Environments

- `staging`: protected enough to accept only the `deploy-staging.yaml` workflow from protected `dev`; secret access is least privilege.
- `production`: manual approval is mandatory and the workflow accepts only a successful recorded staging candidate. Because deployment precedes `main` advancement, its deployment-branch policy must allow the exact protected-`dev` candidate SHA with staging evidence; it must not require the SHA to be on `main` first.
- Separate environment secrets and OAuth values are mandatory.
- Environment approvals do not grant permission for Netcup, Cloudflare, mail, backup, or public-launch mutations unless those are expressly included in the reviewed action.

## 3. Secure transport: host pulls, CI does not SSH

GitHub-hosted runner IPs are dynamic and incompatible with an admin-CIDR-only SSH firewall. Therefore deployment uses no inbound CI SSH.

### 3.1 Deployment request

The environment workflow creates a GitHub Deployment request containing:

- environment (`staging` or `production`);
- source SHA and allowed source branch;
- immutable shared-infrastructure-payload digest;
- immutable application-payload digest for every active environment;
- signed environment-specific activation-manifest digest;
- immutable web/server image digests;
- release ID and monotonic/replay-prevention identifier;
- deployment epoch plus monotonic sequence within that epoch;
- expected previous release ID;
- required check/approval evidence.

### 3.2 VPS reconciler

A root-owned systemd timer/service polls outbound over HTTPS. It:

- uses a dedicated least-privilege GitHub App credential to read approved Deployment requests and write deployment status only;
- uses a separate read-only GHCR credential;
- cannot write repository contents, approve its own deployment, publish packages, accept arbitrary shell, or choose arbitrary Compose paths;
- reads but cannot modify the root-owned automatic-staging policy installed by Prompt 05; for a request matching that policy exactly, it may derive/install the exact staging-only per-release approval record;
- cannot derive a production approval record, authorize a shared change outside the staging policy, or weaken predecessor/resource/migration/isolation/rollback gates;
- accepts only allowlisted repositories, environments, source branches, workflow identities, and overlay combinations;
- verifies every referenced payload/image provenance plus the activation-manifest signature and digest pins;
- rejects replay, skipped predecessor, mutable tag, checksum drift, unsafe archive, unsafe Compose feature, unexpected bind mount, privilege/capability escalation, cross-environment reference, or wrong host/platform;
- invokes fixed root-owned install/verify/activate wrappers with a sanitized environment and explicit local Unix Docker socket;
- runs host-local health/smoke checks and reports success/failure to GitHub.

Administrative SSH stays restricted to the approved administrator CIDR/VPN. The reconciler has no public listener.

Replay protection must survive loss or rollback of the VPS. Before Prompt 05 activation, provision a tiny checkpoint prefix/bucket outside Netcup with versioning plus Object Lock/WORM or equivalent immutable retention. There is exactly one canonical key per sequence, `<epoch>/<zero-padded-sequence>.json`; the record digest/signature and previous-record hash live in the canonical body/metadata, not the key. The VPS credential may conditionally create (`If-None-Match: *`), list, and read checkpoint records but cannot overwrite, shorten retention, unlock, or delete; a separate recovery identity owns policy/retention. Bucket policy/object immutability rejects duplicate-key overwrite/delete/retention reduction. The trusted wrapper and recovery verifier fail closed on a missing/duplicate/unexpected key, noncanonical body, bad signature, sequence gap, epoch mismatch, or predecessor hash that is not the current high-water record; Object Lock alone is not treated as hash-chain validation.

After every accepted transition the record contains epoch/sequence, target environment/change, active release and activation-manifest digests, predecessor checkpoint hash, staging-policy digest, Deployment ID, and a canonical host-local outcome-evidence digest covering smoke/isolation/resource/rollback checks. The host accepts only the exact current epoch and a sequence above both its local and immutable-store high-water marks, then writes and re-reads the new record before committing activation success. This post-activation checkpoint is the acceptance record; the activation manifest contains only evidence available before activation, avoiding a circular self-claim. GitHub Deployment statuses remain useful UI/status signals only: GitHub documents limited status retention, and `Deployments: write` is not a non-delete trust boundary. During disaster recovery, automatic reconciliation remains disabled until an operator retrieves the immutable checkpoint through the separate recovery identity, creates/approves a new recovery epoch, invalidates outstanding requests/approval records from prior epochs, and installs the new root-owned floor. Restored local release state or GitHub status history alone is never sufficient replay evidence. See GitHub's [deployment-status retention/permissions](https://docs.github.com/en/rest/deployments/statuses) and [deployment deletion permission](https://docs.github.com/en/rest/deployments/deployments#delete-a-deployment).

Retain every record in the current epoch for the full replay/recovery lifetime. An epoch may be compacted only after a separately approved recovery identity writes a signed immutable closure containing the final sequence/hash, ordered-record Merkle root, policy/version, next-epoch link, and proof that no unexpired recovery set still depends on individual records. Test recovery from that closure before any expiry. The VPS identity can never shorten retention or delete records/closures; the closure anchor remains for the defined audit/recovery retention.

### 3.3 Host-operation serialization

Use the root-owned kernel lock `/run/lock/<app-slug>/host-operation.lock` for every release install/activation/rollback, migration, public-edge switch, restore, Docker daemon/network mutation, and destructive prune. Acquisition has an operation-specific bounded timeout; timeout means defer/fail safely, never proceed unlocked. After acquiring it, the helper re-reads the active release/predecessor and approval record before changing state, so a request validated before waiting cannot overwrite a newer staging or production transition.

Because `/run` is ephemeral, Ansible installs `/etc/tmpfiles.d/<app-slug>-locks.conf` to create `/run/lock/<app-slug>` as `root:root` mode `0700` at every boot and runs `systemd-tmpfiles --create` during provisioning. Every mutating unit orders after `systemd-tmpfiles-setup.service`, verifies exact path ownership/mode/no-symlink before acquisition, and fails closed if the directory is absent or altered. The persistent inhibit journal remains under `/var/lib`, not `/run`.

Backup and restore tooling additionally uses `/run/lock/<app-slug>/backup.lock`. When both are required, acquire `host-operation` first and `backup` second, never in reverse. Consistent database/Stalwart snapshot acquisition holds the global lock only for the minimum capture window; compression/upload continues after release. The unprivileged reconciler may observe lock state but cannot remove, replace, or bypass it. Implement with `flock` file descriptors so a killed process releases ownership; a surviving lock pathname is not a stale held lock. Alert on repeated contention and test simultaneous timers, bounded timeout, killed-process recovery, lock ordering, and predecessor revalidation.

`flock` solves concurrency, not interrupted-operation recovery. Before the first mutation, each root wrapper atomically creates and fsyncs a persistent operation journal plus recovery-inhibit marker under `/var/lib/<app-slug>/operations/`, recording operation ID, epoch/sequence, target and predecessor manifest digests, phase, and rollback target. Phase transitions are atomically recorded. Only a fully verified commit or verified rollback archives the journal and clears the inhibit marker. After acquiring the lock, every wrapper first checks that marker; an incomplete operation blocks all new mutation and automatic reconciliation until the documented recovery procedure resolves it. Test SIGKILL/power loss at every phase.

One root-owned `<app-slug>-activate-release <release-id> --target <staging|production|production-mail|public-edge|rollback>` transaction holds the global lock continuously across predecessor/epoch re-read, image pull, state start, migration or the approved mail transition, application/Caddy transition, health/isolation checks, atomic active-manifest pointer/status commit, off-VPS checkpoint update, and rollback on failure. `production-mail` changes only the sealed host mail state after separate provider/DNS/firewall approvals; it cannot mutate Netcup or Cloudflare. Separate `host-compose pull/up/run` calls are not an activation interface; `host-compose` is limited to sealed read-only verification/config/status diagnostics or invocation inside the locked transaction.

## 4. Immutable host releases

Recommended layout:

```text
/srv/myapp/
├── release-inbox/
├── releases/
├── operation-recovery/                 # Archived recovery evidence, not live authorization
├── staging/
│   └── media/
│       ├── public/
│       └── private/
├── production/
│   ├── media/
│   │   ├── public/
│   │   └── private/
│   └── backup-staging/

/etc/myapp/
├── deployment-policies/
│   └── staging.yaml
├── approved-releases/
└── secrets/
    ├── staging/
    └── production/

/var/lib/<app-slug>/operations/         # root:root 0700 persistent journal/inhibit state
```

The deployment credential may write only to the inbox or use the reconciler's fixed download path. A root-only approval record names the exact release ID, activation-manifest checksum/digest, every referenced shared/application payload checksum/digest, source SHA, environment, active overlays, image digests, and expected predecessor. The initial staging record and every production record are installed only after their explicit gates. After Prompt 05 activates the immutable automatic-staging policy, the root-owned reconciler may derive later staging-only records that match it exactly; it cannot edit the policy or derive production records. The trusted installer resolves all referenced payloads from fixed digest-addressed inbox paths, verifies the complete approved set, and then seals one root-owned/non-writable host release.

Secrets never enter any payload, activation manifest, image, logs, or Git history. Compose reads root-owned per-environment files by path.

Ansible creates `/var/lib/<app-slug>/operations` as `root:root` mode `0700`; the deployment identity cannot write it. Active journal/inhibit files are atomically written and fsynced there so they survive reboot. Completed journals are archived with bounded retention and included in encrypted offsite recovery evidence, but a restored journal never authorizes clearing an inhibit marker. Only the reviewed recovery procedure may resolve an interrupted operation and record the verified commit/rollback outcome.

### 4.1 Deterministic Compose rendering

`active_compose_files` lists logical source-template paths inside the verified shared-infrastructure payload; those templates are never executed directly. They contain only allowlisted non-secret tokens such as `@@STAGING_WEB_IMAGE@@`, `@@STAGING_SERVER_IMAGE@@`, `@@PRODUCTION_WEB_IMAGE@@`, and `@@PRODUCTION_SERVER_IMAGE@@`. Every concrete non-secret value needed for rendering—domains, certificate contact, mail identity, selected edge mode/fragment, prelaunch CIDRs, and approved fixed network addresses—appears canonically in the signed activation manifest. A digest alone is never treated as the source of a value. Secret values and tester-email lists stay in separately approved root-owned files at fixed schema paths.

Each environment block carries an opaque random `sealed_input_record_id` and its `sealed_input_record_mac`. The MAC is an authentication tag, not secret key material, so it may appear in the signed activation manifest; the HMAC key never leaves the root-owned policy controller or appears in GitHub, logs, artifacts, or the manifest. CI or a deployment request may propose a new opaque ID or reference an already approved pair, but it cannot mint or change the MAC. For the initial staging secret set and every new production/secret/allowlist set, a separately approved local controller action validates the installed root-only file against the versioned schema, mints the ID/MAC pair, and binds that exact pair and fixed file path in the root-only approval record. The installer recomputes and verifies the MAC before rendering. Routine automatic staging, production promotion, production-mail, and public-edge transitions preserve the exact pair unless a separate secret/allowlist approval authorizes a replacement. Never publish an unkeyed digest of a low-entropy tester list. A root-owned renderer installed by Prompt 04:

1. verifies that each environment block exactly matches its referenced application-payload inventory;
2. accepts only the schema-defined image/config keys and maps an environment's values only to service keys with that environment prefix;
3. substitutes exact `registry/repository@sha256:digest` image references and the explicit schema-validated non-secret manifest values;
4. emits ordered sealed files under `rendered/`, with secret references remaining fixed root-owned file paths rather than secret values;
5. rejects unresolved/extra tokens, mutable tags, cross-environment substitution, unsafe Compose features, path traversal, duplicate keys, anchors/merge tricks outside the reviewed template schema, and caller environment overrides; and
6. canonicalizes the ordered rendered files and verifies their combined SHA-256 against `rendered_compose_digest` in the signed activation manifest.

CI computes the expected digest independently with the same versioned rendering specification. The installer recomputes it from verified bytes; it does not trust CI output alone. The host wrapper maps the logical `active_compose_files` to the corresponding sealed `rendered/` files and runs only those outputs with an empty/sanitized process environment, fixed project name, and local Docker socket. A source template or caller-provided env file is never a runnable release.

### 4.2 Initial staging manifest

```yaml
release_id: <release-id>
previous_release_id: <previous-release-id-or-null>
previous_activation_manifest_digest: <previous-manifest-digest-or-null>
deployment_epoch: <approved-epoch-id>
deployment_sequence: 1
compose_project: <app-slug>-host
infrastructure_sha: <reviewed-infrastructure-commit>
shared_infrastructure_payload_digest: sha256:<reviewed-shared-infrastructure-payload-digest>
certificate_contact: <CERTIFICATE_CONTACT>
active_compose_files:
  - infra/compose.yaml
  - infra/compose.staging.yaml
rendered_compose_digest: sha256:<expected-base-plus-staging-render-digest>
change_targets:
  - staging
  - shared-infrastructure
shared_config_digest: sha256:<caddy-and-shared-config-digest>
environments:
  staging:
    sealed_input_record_id: <opaque-random-staging-input-record-id>
    sealed_input_record_mac: hmac-sha256:<root-keyed-record-mac>
    application_payload_digest: sha256:<staging-application-payload-digest>
    source_sha: <dev-source-sha>
    app_domain: <STAGING_APP_DOMAIN>
    admin_health_cidrs:
      - <ADMIN_SOURCE_CIDR_OR_APPROVED_VPN_CIDR>
    edge_subnet: <STAGING_EDGE_SUBNET>
    caddy_ip: <STAGING_CADDY_IP>
    web_image: ghcr.io/<namespace>/<web>@sha256:<staging-web-image-digest>
    server_image: ghcr.io/<namespace>/<server>@sha256:<staging-server-image-digest>
    schema_transition:
      from: <previous-staging-schema-or-empty>
      to: <staging-migration-id>
    config_digest: sha256:<staging-config-digest>
    ci_evidence_digest: sha256:<pre-activation-ci-evidence-digest>
  production: null
```

### 4.3 Production promotion manifest

```yaml
release_id: <release-id>
previous_release_id: <staging-only-or-prior-full-release>
previous_activation_manifest_digest: sha256:<exact-current-predecessor-manifest-digest>
deployment_epoch: <unchanged-approved-epoch-id>
deployment_sequence: <next-sequence>
compose_project: <app-slug>-host
infrastructure_sha: <reviewed-infrastructure-commit>
shared_infrastructure_payload_digest: sha256:<unchanged-reviewed-shared-infrastructure-payload-digest>
certificate_contact: <unchanged-certificate-contact>
active_compose_files:
  - infra/compose.yaml
  - infra/compose.staging.yaml
  - infra/compose.production.yaml
rendered_compose_digest: sha256:<expected-base-staging-production-render-digest>
change_targets:
  - production
shared_config_digest: sha256:<reviewed-shared-config-digest>
promotion_source_checkpoint_digest: sha256:<successful-current-staging-checkpoint-record-digest>
environments:
  staging:
    sealed_input_record_id: <unchanged-current-staging-input-record-id>
    sealed_input_record_mac: hmac-sha256:<unchanged-root-keyed-record-mac>
    application_payload_digest: sha256:<unchanged-current-staging-application-payload-digest>
    source_sha: <unchanged-current-staging-source-sha>
    app_domain: <unchanged-current-staging-domain>
    admin_health_cidrs:
      - <unchanged-staging-admin-or-vpn-cidr>
    edge_subnet: <unchanged-staging-edge-subnet>
    caddy_ip: <unchanged-staging-caddy-ip>
    web_image: ghcr.io/<namespace>/<web>@sha256:<unchanged-current-staging-web-image-digest>
    server_image: ghcr.io/<namespace>/<server>@sha256:<unchanged-current-staging-server-image-digest>
    schema_transition:
      from: <unchanged-staging-schema-from>
      to: <unchanged-staging-schema-to>
    config_digest: sha256:<unchanged-staging-config-digest>
    ci_evidence_digest: sha256:<unchanged-pre-activation-ci-evidence-digest>
  production:
    sealed_input_record_id: <approved-production-input-record-id>
    sealed_input_record_mac: hmac-sha256:<root-keyed-record-mac>
    application_payload_digest: sha256:<same-current-staging-application-payload-digest>
    source_sha: <current-successful-staging-source-sha>
    app_domain: <PRODUCTION_APP_DOMAIN>
    admin_health_cidrs:
      - <ADMIN_SOURCE_CIDR_OR_APPROVED_VPN_CIDR>
    edge_subnet: <PRODUCTION_EDGE_SUBNET>
    caddy_ip: <PRODUCTION_CADDY_IP>
    mail_domain: <MAIL_DOMAIN>
    mail_hostname: <MAIL_HOSTNAME>
    bounce_domain: <BOUNCE_DOMAIN>
    production_mail_admin_subnet: <PRODUCTION_MAIL_ADMIN_SUBNET>
    stalwart_mail_admin_ip: <STALWART_MAIL_ADMIN_IP>
    web_image: ghcr.io/<namespace>/<web>@sha256:<same-current-staging-web-image-digest>
    server_image: ghcr.io/<namespace>/<server>@sha256:<same-current-staging-server-image-digest>
    schema_transition:
      from: <current-production-schema-or-empty>
      to: <production-migration-id>
    config_digest: sha256:<production-config-digest>
    ci_evidence_digest: sha256:<same-pre-activation-ci-evidence-digest>
    mail_mode: private
    mail_config_digest: sha256:<reviewed-non-delivering-private-mail-config-digest>
    mail_evidence_digest: null
    edge_mode: restricted
    edge_fragment_digest: sha256:<reviewed-production-restricted-fragment-digest>
    prelaunch_test_cidrs:
      - <REVIEWED_TESTER_OR_VPN_CIDR>
    prelaunch_test_cidrs_digest: sha256:<reviewed-prelaunch-cidr-set-digest>
```

The activation-manifest digest and signature are external envelope/deployment metadata; the hashed inner YAML must never contain its own digest. Production may promote only the currently active healthy staging release. Its application-payload, source, image, and evidence fields must match that active staging record. If staging advances, the older candidate is no longer promotable without redeploying/revalidating it as current staging. The production activation manifest is a new signed artifact because it adds production state; it preserves the current staging block and the current shared-infrastructure payload. Later automatic staging manifests preserve the entire production block while replacing only the staging block with the newly tested application payload. A shared-infrastructure-payload change is an out-of-policy host-wide transition requiring an explicit compatibility, capacity, and rollback review for both environments.

### 4.4 Production-mail manifest invariant

Mail activation is a new next-sequence signed manifest and release, never an in-place `docker compose up` against the production release. It is based on the currently active restricted-production predecessor and may change only:

- `release_id`, `previous_release_id`, and `previous_activation_manifest_digest`;
- `deployment_sequence` within the unchanged epoch;
- `change_targets` to exactly `production-mail`;
- `rendered_compose_digest` and `shared_config_digest` to their independently computed reviewed external-mail values;
- production `mail_mode` from `private` to `external`;
- production `mail_config_digest` to the reviewed external-delivery configuration digest; and
- production `mail_evidence_digest` to the approved Netcup policy/Mail-block/firewall/PTR/DNS/TLS/quota/rollback evidence digest.

Every staging field, shared-infrastructure payload, production sealed-input/application/image/schema/app/edge/domain field, and fixed mail identity/admin network stays identical. The renderer selects one of two fully reviewed structural variants for the same logical `infra/compose.production.yaml` output: `private` has no host SMTP/IMAPS publication; `external` adds only TCP 25 and the documented loopback-only operational IMAPS binding. It does not inject arbitrary YAML. The mail activation wrapper verifies the new manifest, holds the global lock/journal across transition/checkpoint/rollback, and proves no host SMTP listener existed before the gate. A mail rollback is another next-sequence manifest returning `mail_mode` to `private`; close host/provider mail ingress first where required and never reuse an old whole-host manifest.

### 4.5 Public-launch manifest invariant

The public launch is another signed activation manifest, not an in-place Caddy edit. It is built from the **currently active host manifest**, whose predecessor must match at activation time. This matters because an approved automatic staging deployment may have advanced staging after restricted production was first verified. The launch manifest copies the current staging block and shared-infrastructure payload byte-for-byte. Its current restricted production non-edge block must still match a completed production verification record; if production changed, rerun the relevant production, capacity, isolation, and rollback checks before launch. Relative to that current active predecessor, the launch manifest may change only:

- `release_id`, `previous_release_id`, and `previous_activation_manifest_digest` to identify the exact current predecessor;
- `deployment_sequence` to the next value in the unchanged `deployment_epoch`;
- `change_targets` to the exact production-edge transition;
- `shared_config_digest`, because the sealed rendered Caddy selection changes;
- production `edge_mode` from `restricted` to `public`;
- production `edge_fragment_digest` from the reviewed restricted fragment to the reviewed public fragment; and
- production `prelaunch_test_cidrs` from the reviewed canonical list to `[]`; and
- `prelaunch_test_cidrs_digest` from the reviewed set to `null`.

The `deployment_epoch`, shared-infrastructure-payload digest, ordered Compose files, `rendered_compose_digest`, current full staging block/sealed-input reference, and every production sealed-input/application-payload/source/image/domain/mail/schema/config/evidence field remain identical. This is implementable because both reviewed edge variants render their content to the same fixed `rendered/sites/production.caddy` mount path; the Compose YAML bytes do not embed the selected fragment contents/digest. The changing Caddy bytes are covered independently by `edge_fragment_digest` and `shared_config_digest`, while a test proves every non-edge rendered file/service is byte-identical. The installer rejects any launch manifest that changes another field. Recheck current host capacity, staging isolation, production health, external denial in restricted mode, and rollback readiness immediately before the switch.

## 5. Staging deployment

Prompt 05 provisions the host and deploys staging first:

1. approve and record the Netcup/SCP/CCP read-only baseline;
2. if necessary, install verified Ubuntu 26.04 on the confirmed-empty server;
3. run remote Ansible `--check --diff`, review, and separately approve apply;
4. retain provider console/rescue access while hardening SSH/firewall;
5. configure shared Caddy, the reconciler, and isolated staging state;
6. keep the Netcup Mail block enabled and production/Stalwart inactive;
7. create Cloudflare staging DNS and staging OAuth clients through separate approvals;
8. seal the base+staging release;
9. start staging PostgreSQL/Valkey/Mailpit, run the one-shot migration, then start worker/API/web/Caddy;
10. run host-local and approved external staging tests;
11. report GitHub Deployment status and prove rollback/reboot recovery.

Subsequent protected `dev` candidates can deploy to staging automatically only through the same verified pull path. Automation stops on failed tests, signature/provenance failure, migration incompatibility, health failure, or unsafe resource pressure.

Prompt 05 must explicitly activate the narrow ongoing staging policy before this automation begins. It covers only the unchanged reviewed workflow/reconciler and staging-only state transitions: `production: null` is preserved before launch, and the complete production block/shared-infrastructure payload is preserved afterward. Any workflow, credential, provider, secret, migration-policy, or environment-boundary change requires fresh approval.

The policy file is root-owned, non-writable by the reconciler process, versioned by digest in operations records, and revocable through a documented kill switch. Every derived record logs the policy digest, Deployment ID, predecessor, every payload/manifest/image digest, decision checks, and outcome.

## 6. Production promotion

Prompt 06 requires a successful staging record. The production workflow:

1. verifies exact source SHA, image/application-payload digests, the unchanged shared-infrastructure payload, signatures, staging evidence, host capacity, and rollback target;
2. receives GitHub production Environment approval;
3. installs separate production secrets through an approved channel;
4. while holding the host-operation lock, re-reads the predecessor and seals the base+staging+production manifest;
5. privately bootstraps Stalwart with the Netcup Mail block/public SMTP still closed, validates its non-delivering configuration, and removes temporary bootstrap access;
6. starts isolated production PostgreSQL/Valkey and runs the one-shot migration;
7. starts production worker/API/web behind restricted Caddy routing; SMTP remains asynchronous/unavailable and the outbox stays retryable rather than failing API requests;
8. keeps the Cloudflare application record DNS-only, verifies an unapproved external source receives 403, and verifies an approved fixed/VPN tester CIDR can complete non-mail auth/OAuth, health, media, websocket, authorization, and environment-isolation tests;
9. under the separate Netcup/mail gate, enables Stalwart external delivery, mail DNS/PTR/firewall, signed feedback, and controlled end-to-end action-link canaries;
10. initializes the off-Netcup Restic repository and passes a no-production-egress isolated restore test;
11. verifies external monitoring, reboot recovery, rollback, security, isolation, and capacity;
12. records restricted-production acceptance;
13. only then a separate protected promotion workflow/identity with narrowly scoped `contents: write` updates `main` with force disabled to the exact staged source SHA; the VPS reconciler cannot update branches;
14. after another explicit approval, creates and seals a new signed activation manifest satisfying the exact public-launch invariant in section 4.5, activates it under the global lock, and proves public access from a formerly unallowlisted source.

## 7. Database migrations

- Migration images use a migration-only PostgreSQL role.
- API and worker credentials cannot create/alter schemas or install/migrate pg-boss.
- Runtime migration is disabled.
- Run migration as a one-shot job before compatible app services.
- Test every migration from an empty database and from the previous schema.
- Prefer expand-and-contract changes. Do not combine a destructive schema change with a release that cannot run against the previous schema.
- Before a destructive or difficult-to-reverse production migration, require a fresh backup and verified restore path.
- A migration failure stops activation; it never triggers an unreviewed destructive reset.

## 8. Rollback and `main`

The activation manifest contains previous release IDs and digest-pinned environment blocks. A normal application rollback creates a new signed activation manifest rather than reactivating an old whole-host manifest:

1. stops promotion;
2. preserves the current staging block and current shared-infrastructure payload;
3. replaces only the production block with the recorded prior compatible production application-payload/image/configuration digests, without rebuilding;
4. preserves database/media unless the reviewed recovery plan explicitly restores them;
5. runs health, security, and isolation checks;
6. reports rollback status.

For the first production release, rollback means a newly signed manifest that returns only production to the restricted no-production-app state while preserving staging and initialized production data. Later releases select a prior compatible production block. If the current shared-infrastructure payload or database schema is incompatible with that production block, stop and require an explicit multi-environment rollback plan; never reactivate a historical whole-host manifest that could silently roll staging backward.

`main` rules:

- failed activation before success leaves `main` unchanged;
- normal success fast-forwards `main` to the staged source SHA;
- the actor is the separately approved protected production-promotion workflow/identity, not the VPS reconciler; it verifies the successful GitHub Deployment ID and expected old/new refs before a force-disabled update;
- `main` is never force-pushed backward;
- after a later rollback to an older code tree, create and review a forward rollback/revert commit whose tree matches the restored live code, and advance `main` only after runtime verification;
- merge that forward rollback/revert record back into `dev` before another production candidate can pass the required `main`-ancestor check;
- until that reconciliation completes, the sealed runtime manifest is the exact source of truth and the mismatch is reported as an incident, not hidden.

## 9. Backup and restore

Production backup uses Restic to a repository outside Netcup and preferably outside the same provider/account failure domain. Netcup snapshots are optional, short-lived, supplemental rollback aids—not disaster-recovery backups.

Back up:

- consistent PostgreSQL dump and required globals/role reconstruction material without plaintext secrets;
- production public/private original media and required prepared variants;
- Stalwart configuration, embedded RocksDB data, queue/operational mailbox state, DKIM private keys, and the matching DNS/PTR inventory, captured by a brief stop or the pinned version's documented consistent snapshot/export method;
- encrypted copies of essential configuration and key material according to the recovery runbook;
- release manifests and migration metadata.

Do not back up:

- staging databases/media;
- Mailpit data;
- caches;
- container writable layers;
- rebuildable images;
- logs beyond the defined incident-retention need.

Every usable backup is identified by one canonical signed/checksummed recovery-set manifest. It records the active release and activation-manifest digests, deployment epoch/sequence/checkpoint, PostgreSQL dump/global checksums plus schema version and snapshot time, media root/file-manifest checksums and cutoff, Stalwart snapshot checksum and queue cutoff, configuration/DNS inventory, session/action-link/webhook key versions, security-tombstone high-water mark, and every Restic snapshot/object ID. Build each artifact as `.partial`, validate and fsync it, atomically rename it, upload all referenced components, then publish the offsite completion marker last. A six-hour database set may reference the latest completed daily media/mail state only when their different capture times are explicit and within the documented RPO. Restore rejects absent completion markers, checksum drift, incompatible schema/release, components from different unrecorded sets, or a tombstone/checkpoint gap.

Every host backup job uses a root-owned wrapper binding the exact repository, config, append-only/write credential source, source paths, and lock behavior. The wrapper rejects ambient repository/credential overrides. Where the backend supports it, enable append-only storage, object lock, immutable versions, or an equivalent tested control. The credential present on the VPS may create snapshots and perform the minimum consistency reads/lock operations, but it must not delete historical backup objects or run `forget --prune`.

Keep delete/prune authority and full recovery material off the VPS under a separate operator identity and recovery custodian. Retention runs from a separately approved trusted environment, verifies repository integrity before/after pruning, and records the exact policy. Test that the VPS credential cannot delete snapshots or repository objects. Backend versioning without independently protected retention is not sufficient if the same compromised credential can purge versions.

Suggested policy, adjusted to capacity and business need:

- PostgreSQL custom-format dump every six hours to meet the default RPO, plus daily globals material;
- immediately copy/snapshot every successfully completed six-hour database dump to the encrypted off-Netcup Restic repository; a dump left only on the VPS does not meet the host-loss RPO;
- daily Restic snapshot for media, consistent Stalwart state, encrypted recovery configuration, and the retained database-dump set;
- daily/weekly/monthly retention such as 7/4/6, applied only by the separate off-VPS retention identity;
- weekly automated restore to an isolated path/database;
- periodic manual full recovery exercise;
- alert on backup age, failure, lock contention, repository integrity, restore failure, and storage growth.

Every restore begins with a measured capacity preflight based on the selected dump, expected restored database size, media/mail artifacts, temporary copies, indexes, WAL, and filesystem/tool overhead. The fixed 15 GB local workspace is not proof that an allocated 50 GB database can be restored there. Refuse an in-place restore that would cross 70% disk use, approach the 80% critical threshold, or violate the 20% free-space reserve. Select a separately approved isolated external restore target or temporary host instead; never consume emergency headroom to make a scheduled restore test pass.

A backup is not launch-ready until an isolated restore proves PostgreSQL data/roles, media checksums, Stalwart domains/accounts/queue/config/DKIM recovery or certificate reissuance, release metadata, and application readability. Monitor freshness against the six-hour database and 24-hour media/mail RPO defaults.

Because a point-in-time restore can resurrect sessions, authorization, and action-link intent rows that were reduced, revoked, or consumed after the recovery point, keep the reconciler, timers, edge, writes, and external effects closed until the recovery policy runs. First authenticate/decrypt and replay every security-tombstone record newer than the restored high-water mark; fail closed on gaps, unreadable records, or unresolved/ambiguous prepared events. Then revoke every restored session; invalidate every outstanding restored magic-link/invitation issuance intent rather than guessing which rows crossed the unknown recovery gap; rotate session, action-link-derivation, and signed-feedback secrets; reissue still-valid pending invitations; and quarantine/reconcile outbox/pg-boss/Stalwart duplicate delivery by stable event ID. Install a newly approved deployment recovery epoch/floor from the independent off-VPS checkpoint before restarting reconciliation. Audit the reconciliation/invalidation and notify affected users when warranted. Restore tests must prove that a token consumed before the failure cannot become usable again and that no disabled/deleted/unlinked/removed/demoted authorization state is resurrected.

## 10. Mail deployment

Netcup's default Mail block prevents inbound and outbound SMTP and remains enabled through staging. Production mail activation is a separate Prompt 06 gate requiring:

- confirmation that the chosen product/contract permits the intended low-volume transactional use;
- written Netcup clarification when policy applicability is uncertain;
- assigned IPv4/IPv6 reputation checks;
- approved Mail-block removal and minimum firewall changes;
- PTR for `mail.<domain>`;
- Cloudflare DNS records for A/AAAA as applicable, MX, SPF, DKIM, and DMARC;
- TLS validation for the public and internal submission hostname;
- private Stalwart administration;
- signed/idempotent bounce and delivery feedback;
- low launch quotas, suppression, abuse handling, and monitoring.

Stalwart is limited to application magic links, invitations, system notifications, and named operational mailboxes such as postmaster, abuse, and support. No marketing, newsletter, campaign, bulk-mail, or general end-user mailbox service is permitted by this blueprint.

## 11. Monitoring

The 8 GB launch profile uses lightweight host/application telemetry and an external monitoring destination. Do not enable Prometheus/Grafana/Loki or other heavy containers by default.

Monitor at minimum:

- external HTTPS and TLS validity;
- `/api/health/live` and `/api/health/ready`;
- protected dependency checks from an operator/internal path;
- container health/restarts/OOM kills;
- host RAM, swap, load, disk, inode, and I/O pressure;
- PostgreSQL connections, backup age, restore-test age, and disk growth;
- Valkey memory/evictions;
- queue depth, retries, dead-letter/failure state, and outbox age;
- mail queue, deferrals, bounces, reputation signals, and certificate expiry;
- reconciler poll age, rejected deployment requests, deployment duration, and last successful release;
- staging/production digest and isolation invariants.

Investigate sustained RAM above 70%; treat sustained 75%+, active normal-load swap, any OOM kill, or disk above 80% as an immediate capacity incident.

## 12. Manual and approval-only actions

These are never implied by a merge, except that Prompt 05 may explicitly authorize the narrow ongoing routine staging policy described above:

- Netcup ISO installation, firewall, PTR, Mail-block removal, snapshot, or console action;
- Cloudflare DNS or domain setting changes;
- OAuth-console changes;
- GitHub Environment, branch protection, GitHub App, credential, or public visibility changes;
- secret creation/installation;
- Ansible remote check/apply;
- initial release sealing/environment activation, any production release, and any staging release outside the already approved automatic policy;
- Stalwart activation or external email test;
- Restic repository initialization/write/restore;
- external monitoring changes;
- `main` advancement;
- public production launch;
- destructive migration/reset or data restore.

Each approval names the target, exact release/change, expected effect, and rollback.

## 13. Acceptance criteria

- CI builds the candidate once and records immutable registry digests and provenance.
- Prompt 05 activates only base+staging and leaves production null.
- Prompt 06 uses base+staging+production and preserves staging.
- The VPS reconciler needs outbound HTTPS only; GitHub-hosted runners do not receive SSH access.
- Root-owned wrappers reject unsafe or unapproved releases and always target the local Docker socket.
- Automatic staging can derive an approval record only under the installed policy; production and out-of-policy shared changes always fail without a separate manual record.
- Production promotion uses the exact staging-tested bytes.
- Database migrations use a migration-only identity and runtime roles fail DDL tests.
- Rollback works without image rebuilding or silent destructive data handling.
- `main` advances only after verified production and follows the forward-only rollback rule.
- the branch-update actor is separate from the VPS reconciler, uses force-disabled `contents: write`, and proves the remote `main` ref matches the verified source after success.
- Mail remains blocked until its dedicated Netcup/policy/DNS/reputation gate passes.
- Production Restic backups leave Netcup and pass an isolated restore.
- Staging and production isolation tests fail in every forbidden direction.
- Combined host operation stays inside the documented 8 GB/256 GB thresholds.
