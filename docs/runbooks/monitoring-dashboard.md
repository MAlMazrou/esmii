# Custom monitoring dashboard

This runbook covers Prompt 07's separately gated monitoring rollout and rollback. It is not authorization to connect to the VPS, create or install a secret, pull an image, start a container, change Caddy or Cloudflare, request a certificate, or activate production. Stop at each named gate in [`../prompts/07-build-monitoring-dashboard.md`](../prompts/07-build-monitoring-dashboard.md).

## Repository artifacts

- `apps/dashboard/` — the environment-neutral custom Next.js operator application and root-only operator CLI.
- `infra/compose.monitoring.{staging,production}.yaml` — private dashboard/Prometheus data planes. These files do not attach Caddy or activate a public hostname.
- `infra/compose.monitoring.{staging,production}.edge.yaml` — separately gated Caddy attachments.
- `infra/monitoring/prometheus/` — environment-local scrape and rule configuration.
- `infra/monitoring/{container_metrics_collector.py,log_collector.py}` — fixed root-owned collectors.
- `infra/monitoring/provision_dashboard_mail.py` — root-only idempotent provisioning of the environment's dedicated Stalwart email-OTP sender and mode-`0600` SMTP URL.
- `infra/systemd/esmii-{node-exporter,container-metrics-collector,log-collector}*` — private exporter/proxy and bounded timer units.
- `infra/monitoring/{install-host-collectors.sh,rollback-host-collectors.sh}` — shared collector install/enable and environment-specific rollback boundaries.
- `infra/monitoring/{install-monitoring-runtime.sh,rollback_monitoring_runtime.py}` — immutable environment render and bounded rendered-config rollback.
- `infra/monitoring/manage-monitoring-runtime.sh` — the only private-start, public-edge, and stop controller; it uses Compose project `esmii` and the same `/run/lock/esmii/host-pull.lock` as the active application pulls.
- `infra/monitoring/install-pull-wrapper-integration.sh` — the fixed updater/validator for the already active staging and production pull wrappers; it does not start, stop, or reload a service.
- `scripts/monitoring-payload.mjs` and `infra/monitoring/monitoring_payload.py` — deterministic build plus fail-closed verification/materialization for the exact Prompt-07 host payload. The closed payload contains the monitoring host code/configuration, Docker firewall helper, and both active pull wrappers; it excludes dashboard application source and all tests.

The canonical auth secret and dedicated SMTP URL remain separate root-owned mode-`0600` files under `/etc/esmii/monitoring/<environment>/`. A no-network one-shot copies only those two secrets into the fixed, labeled, environment-local Docker handoff volume at mode `0440` for UID/GID `10003`; purge that detached copy during rollback or rotation. The dashboard receives no Docker socket, journal, application database, customer-auth state, or other environment's state. Its only application-side network attachment is the matching internal `mail-submit` network, used with the dedicated monitoring sender for certificate-verified STARTTLS to `mail.esmii.app`; it receives no worker/customer SMTP credential. A rendered manifest is inert: only the fixed manager may atomically create/remove the root-owned `private-enabled` and `edge-enabled` markers. An edge marker is invalid without its private marker. Host installation is never sourced from a checkout: every mutating entry point re-verifies the root-only materialized payload against the separately approved digest and full revision before it creates a lock/directory or changes a host file. The installed collector record, pull-wrapper integration record, and each environment runtime manifest bind that same payload identity.

This first release does not install an OpenTelemetry Collector or application SDK, and Prometheus does not enable its OTLP receiver, remote-write receiver, admin API, or lifecycle API. The application-monitoring cards are a stable typed empty state for a later, separately approved instrumentation decision; they do not fabricate telemetry.

## Local verification

Run from the repository root with the pinned project toolchain:

```bash
corepack pnpm --filter @esmii/dashboard lint
corepack pnpm --filter @esmii/dashboard typecheck
corepack pnpm --filter @esmii/dashboard test
corepack pnpm --filter @esmii/dashboard build
python3 -m unittest discover -s infra/monitoring/tests -p 'test_*.py'
corepack pnpm monitoring:verify-host-payload -- --revision <FULL_GIT_SHA>
corepack pnpm test:policy
corepack pnpm test:infra
corepack pnpm scan:secrets
```

Render both private and edge compositions with synthetic local paths before any host proposal. Validate that:

- no `ports`, host networking, Docker socket, journal, or cross-environment state mount appears;
- the dashboard is on only its environment's edge/data networks plus its matching internal `mail-submit` network, and Prometheus only on its data network;
- the private composition contains no `caddy` service or dashboard Caddy fragment;
- only the edge overlay attaches Caddy and mounts the exact environment site;
- memory limits total 1,088 MiB and Prometheus retains seven days or 1 GB; and
- the labeled secret-handoff volume name matches the bounded rollback allowlist.

## Gate 1 — fresh read-only audit

Before proposing a host change, re-read the current VPS and Cloudflare state. Record without printing secrets:

- OS/kernel, memory/swap, disk/inodes, load, listeners, UFW/provider-firewall policy, Docker networks/containers/restarts, failed units, timers, and Caddy config/certificates;
- any existing Prometheus/exporter/monitoring process or port conflict;
- current `staging-dashboard.esmii.app` Worker custom-domain binding and complete restoration data;
- whether `dashboard.esmii.app` remains unoccupied; and
- current A/AAAA targets, proxy mode, TTL, and IPv4/IPv6 reachability.

Perform the host-side audit through the existing WireGuard administrator path: the server is `10.77.0.1` and the already authorized operator peer is `10.77.0.2`. Do not open public SSH, change WireGuard, or treat a VPN result as proof of public reachability. Public IPv4/IPv6 DNS, HTTP, TLS, and closed-port checks are separate external tests at their later gates.

Stop and present the audit. It does not authorize installation.

## Gate 2 — pin and render one private environment

After a separate host-change approval, record the exact official Prometheus and node_exporter versions, immutable digests/checksum, the dashboard digest, full source revision, application version, and `digest`, `bootstrap_sha256`, and `verifier_sha256` emitted for the `esmii-monitoring-host-payload-<FULL_GIT_SHA>` artifact by the successful protected CI run. Do not use tags or abbreviated SHAs in the activation record. The expected payload, tiny-bootstrap, and fixed-verifier digests must come from reviewed CI/approval evidence independently of the downloaded artifact files and detached inventory. Install the separately fetched and checksum-verified node_exporter binary at the reviewed root-owned path first; no payload entry point downloads it.

Download the exact CI artifact without unpacking its tar. Verify the tar, detached tiny bootstrap, and detached verifier against their three independently recorded digests before installing either executable into the fixed root-only bootstrap directory. The bootstrap repeats the archive and fixed-verifier checks immediately before invoking the fixed verifier; it never extracts or executes the candidate payload's verifier. The fixed verifier validates the closed inventory/checksums/modes/metadata completely in memory and only then atomically materializes the exact source at `/var/lib/esmii/monitoring/host-payloads/<64_HEX>`. A bootstrap, verifier, or archive mismatch must leave that destination absent. `ESMII_MONITORING_PAYLOAD_ROOT` below must be that exact digest-named directory; never substitute a checkout or a generic extracted directory.

```bash
export ESMII_MONITORING_PAYLOAD=/root/esmii-monitoring-host-payload.tar
export ESMII_MONITORING_BOOTSTRAP=/root/esmii-monitoring-host-payload.bootstrap.sh
export ESMII_MONITORING_VERIFIER=/root/esmii-monitoring-host-payload.verifier.py
export ESMII_MONITORING_PAYLOAD_DIGEST=sha256:<64_HEX>
export ESMII_MONITORING_PAYLOAD_REVISION=<FULL_GIT_SHA>
export ESMII_MONITORING_BOOTSTRAP_SHA256=sha256:<64_HEX>
export ESMII_MONITORING_VERIFIER_SHA256=sha256:<64_HEX>
export ESMII_MONITORING_PAYLOAD_ROOT=/var/lib/esmii/monitoring/host-payloads/<64_HEX>

printf '%s  %s\n' \
  "${ESMII_MONITORING_PAYLOAD_DIGEST#sha256:}" \
  "${ESMII_MONITORING_PAYLOAD}" \
  | sudo /usr/bin/sha256sum --check --strict

printf '%s  %s\n' \
  "${ESMII_MONITORING_BOOTSTRAP_SHA256#sha256:}" \
  "${ESMII_MONITORING_BOOTSTRAP}" \
  | sudo /usr/bin/sha256sum --check --strict
printf '%s  %s\n' \
  "${ESMII_MONITORING_VERIFIER_SHA256#sha256:}" \
  "${ESMII_MONITORING_VERIFIER}" \
  | sudo /usr/bin/sha256sum --check --strict
sudo install -d -o root -g root -m 0700 \
  /var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring
sudo install -o root -g root -m 0700 \
  "${ESMII_MONITORING_BOOTSTRAP}" \
  /var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/materialize-monitoring-payload.sh
sudo install -o root -g root -m 0700 \
  "${ESMII_MONITORING_VERIFIER}" \
  /var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/monitoring_payload.py
sudo /var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/materialize-monitoring-payload.sh \
  --archive "${ESMII_MONITORING_PAYLOAD}" \
  --expected-digest "${ESMII_MONITORING_PAYLOAD_DIGEST}" \
  --expected-revision "${ESMII_MONITORING_PAYLOAD_REVISION}" \
  --expected-verifier-digest "${ESMII_MONITORING_VERIFIER_SHA256}"
```

Install the shared-but-disabled host integration from `ESMII_MONITORING_PAYLOAD_ROOT`, then atomically update only the two already active pull-wrapper programs from the same root. The first command also installs the payload-bound Docker firewall helper but does not enable monitoring. The second command verifies the installed helper/manager and `host-payload.json`, acquires the same host-operation lock as both pull timers, syntax-checks both candidates, replaces only the fixed root-owned wrapper paths, and writes `pull-wrapper-integration.json` with their hashes and payload identity. It does not restart or enable a pull timer and does not activate monitoring.

```bash
sudo "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/install-host-collectors.sh \
  --expected-host-payload-digest "${ESMII_MONITORING_PAYLOAD_DIGEST}" \
  --expected-host-payload-revision "${ESMII_MONITORING_PAYLOAD_REVISION}" \
  --node-exporter-sha256 <NODE_EXPORTER_SHA256> \
  --install-shared

sudo "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/install-pull-wrapper-integration.sh \
  --expected-host-payload-digest "${ESMII_MONITORING_PAYLOAD_DIGEST}" \
  --expected-host-payload-revision "${ESMII_MONITORING_PAYLOAD_REVISION}"

sudo cmp "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/staging-pull/esmii-staging-pull /usr/local/libexec/esmii/esmii-staging-pull
sudo cmp "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/production-pull/esmii-production-pull /usr/local/libexec/esmii/esmii-production-pull
sudo cmp "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/ansible/roles/firewall/files/esmii-docker-firewall.sh /usr/local/sbin/esmii-docker-firewall
sudo stat -c '%U:%G %a %n' \
  /usr/local/libexec/esmii/esmii-staging-pull \
  /usr/local/libexec/esmii/esmii-production-pull \
  /usr/local/libexec/esmii/monitoring_overlay_state.py \
  /usr/local/libexec/esmii/manage-monitoring-runtime \
  /usr/local/sbin/esmii-docker-firewall \
  /var/lib/esmii/monitoring/shared/state/host-payload.json \
  /var/lib/esmii/monitoring/shared/state/pull-wrapper-integration.json
```

All installed files and records must be `root:root`; executable programs are mode `0755` and the two identity records are mode `0600`. Re-read both active timers afterward without restarting them, and run each timer's installed wrapper with `bash -n`. Stop if a byte/hash/mode differs, either record names a different payload identity, or a timer stopped unexpectedly. Manifest materialization and these installations still leave both `private-enabled` markers absent.

For a later reviewed monitoring payload, do not run `--install-shared` over active shared collectors. First stop and remove every rendered monitoring environment through the fixed manager and rollback commands in the rollback section, then disable each registered environment exporter path. If—and only if—the candidate's installed collector files, systemd units, Docker firewall helper, and both active pull wrappers are byte-identical to the current installation, adopt the new sealed identity with:

```bash
sudo "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/install-host-collectors.sh \
  --expected-host-payload-digest "${ESMII_MONITORING_PAYLOAD_DIGEST}" \
  --expected-host-payload-revision "${ESMII_MONITORING_PAYLOAD_REVISION}" \
  --node-exporter-sha256 <NODE_EXPORTER_SHA256> \
  --rebind-compatible-shared
```

The compatible rebind holds both host locks, verifies the old fixed-file manifest and pull-wrapper integration, compares every installed shared byte with the new candidate, and refuses while any environment manifest/configuration/activation marker/container/exporter proxy/listener/firewall rule remains. It updates only `host-payload.json`, `pull-wrapper-integration.json`, and `collector-install.sha256`, verifies the complete new state before releasing the lock, restores all three prior records if final verification fails, and never replaces shared code or changes systemd service state. A changed shared byte is not eligible for this path; use a separately reviewed full shared-component replacement instead.

Provision or reconcile the dedicated sender before rendering the environment. This command reads the existing root-only Stalwart administrator credential in memory, pins every administration request to the private `172.30.30.2:8080` endpoint while accepting only Stalwart's canonical advertised `https://mail.esmii.app/jmap/` API origin, creates or updates only `monitoring-staging@esmii.app` for staging or `monitoring@esmii.app` for production, writes only `/etc/esmii/monitoring/<environment>/dashboard-smtp-url` at root-owned mode `0600`, and never prints the generated credential. Do not reuse the application worker sender or copy this file between environments.

```bash
sudo "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/provision_dashboard_mail.py <ENVIRONMENT>
sudo stat -c '%U:%G %a %n' /etc/esmii/monitoring/<ENVIRONMENT>/dashboard-smtp-url
```

The reviewed render entry point is:

```bash
sudo "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/install-monitoring-runtime.sh \
  --expected-host-payload-digest "${ESMII_MONITORING_PAYLOAD_DIGEST}" \
  --expected-host-payload-revision "${ESMII_MONITORING_PAYLOAD_REVISION}" \
  --environment <ENVIRONMENT> \
  --dashboard-image <DASHBOARD_IMAGE_DIGEST> \
  --prometheus-image <PROMETHEUS_IMAGE_DIGEST> \
  --source https://github.com/MAlMazrou/esmii \
  --revision <FULL_GIT_SHA> \
  --version <APP_VERSION>
```

It validates already-local images and host state under the shared host-operation lock, writes the fixed environment files under `/srv/myapp/staging-runtime`, and performs no pull, start, reload, DNS, certificate, marker creation, or external request. Immediately after a first render, the overlay verifier must not return that environment's base or edge file because no activation marker exists.

Preserve the preceding runtime manifest/configuration as the rollback point. Rendering is a stop point and never authorizes the private start.

## Gate 3 — host collectors and private verification

Start only the reviewed private environment through the fixed manager. This atomically creates its `private-enabled` marker, validates the complete active Compose model, starts only that environment's Prometheus/dashboard services, and removes the marker again if a failed first start is fully detached. It does not attach Caddy or create the edge marker.

```bash
sudo /usr/local/libexec/esmii/manage-monitoring-runtime start-private staging
```

After the private monitoring bridge exists, a separate environment enable action adds only its fixed socket and exact-source UFW rule:

```bash
sudo "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/install-host-collectors.sh \
  --expected-host-payload-digest "${ESMII_MONITORING_PAYLOAD_DIGEST}" \
  --expected-host-payload-revision "${ESMII_MONITORING_PAYLOAD_REVISION}" \
  --node-exporter-sha256 <NODE_EXPORTER_SHA256> \
  --enable-staging
```

Use the equivalent production action only after production approval. Never add a public `9090`/`9100` rule or Caddy route.

From a root-controlled TTY reached through the existing WireGuard operator peer `10.77.0.2` to server `10.77.0.1`, run the dashboard's operator database migration and `provision`, `retarget`, `recover`, or `revoke-sessions` command inside the matching running container. Identity input comes from a protected file or its TTY; never pass passwords, SMTP credentials, OTPs, cookies, or email addresses as command arguments. `retarget` requires exactly one existing operator, changes that record's email, generates a new temporary password, clears legacy TOTP/OTP state, and revokes every session. Remove the mode-`0600` bootstrap output immediately after the first successful password-change and email-OTP verification. This private path is not a public-reachability test.

Private verification must prove:

- anonymous, password-only, wrong-environment, expired, and revoked sessions retrieve zero monitoring data;
- a six-digit, five-minute, single-use email OTP is required for every password-created session, the recipient is fixed to that session's operator email, the temporary password must change only after OTP verification, and the session expires within eight hours;
- the dashboard submits through only its matching internal `mail-submit` network using its dedicated sender and certificate-verified STARTTLS; staging and production SMTP credentials are different and neither can use the other's network;
- staging queries only staging plus shared-host metrics/logs and cannot reach production Prometheus/state;
- collector age over 90 seconds becomes unknown/stale, worker age over three minutes degrades, and stopped/OOM/restarted/unhealthy services and failed timers surface correctly;
- snapshots contain only warning/error safe fields and pass credential, cookie, email, IP, URL/query, SQL, path, stack, OAuth/OTP/TOTP, and truncation sentinels;
- ports `3000`, `9090`, and `9100` have no public IPv4/IPv6 listener or route; and
- the resource/retention ceilings match [`resource-budget.md`](resource-budget.md).

## Gate 4 — staging hostname and TLS

Only after private staging acceptance and a distinct Cloudflare approval:

1. capture the current Worker binding again;
2. detach only `staging-dashboard.esmii.app` from that Worker;
3. create the approved DNS-only A/AAAA records;
4. run `sudo /usr/local/libexec/esmii/manage-monitoring-runtime enable-edge staging`; the manager creates the edge marker, validates the complete active Compose model, and reconciles only shared Caddy; and
5. verify Caddy's Let's Encrypt chain/renewal, HTTP-to-HTTPS redirect, HSTS/CSP/no-referrer/noindex headers, authenticated routing, and absence of raw monitoring routes.

Any failed DNS, certificate, routing, auth, or isolation check runs `sudo /usr/local/libexec/esmii/manage-monitoring-runtime disable-edge staging`, verifies Caddy is detached from that edge, and then restores the captured Worker/DNS state. Public A/AAAA, HTTP redirect, certificate, and external closed-port probes must run from outside the VPS/VPN path.

## Gate 5 — 24-hour staging soak

Collect the evidence listed in [`resource-budget.md`](resource-budget.md) continuously for at least 24 hours under representative application and mail load. Production monitoring is rejected if there is any OOM, sustained normal-load swap, sustained RAM above 70%, repeated restart, collector overlap/staleness, disk/inode breach, unbounded retention, data leak, isolation failure, or unacceptable application regression.

## Gate 6 — production

Production requires a new explicit approval, new production-only canonical auth/SMTP secrets, operator/SQLite state, the exact accepted dashboard digest, its own inert render followed by `manage-monitoring-runtime start-private production`, collector enablement, and repeat isolation/auth/private-port checks. A later, separate `dashboard.esmii.app` DNS/TLS approval uses `manage-monitoring-runtime enable-edge production`. Staging credentials, cookies, secret handoff, snapshots, and Prometheus data are never promoted.

## Rollback

Stop only the affected environment through the fixed manager first. It detaches and verifies Caddy before removing the edge marker, removes/verifies the three environment monitoring containers before removing the private marker, and preserves Prometheus/auth/log data. Restore that hostname's captured Worker/DNS state when applicable. Only then remove the rendered environment configuration with its exact confirmation; rollback refuses to remove configuration while an activation marker remains. Add `--purge-secret-handoff` only after its containers are detached and the fixed name/labels have been verified by the rollback tool.

```bash
sudo /usr/local/libexec/esmii/manage-monitoring-runtime stop staging

sudo python3 "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/rollback_monitoring_runtime.py \
  --expected-host-payload-digest "${ESMII_MONITORING_PAYLOAD_DIGEST}" \
  --expected-host-payload-revision "${ESMII_MONITORING_PAYLOAD_REVISION}" \
  --environment staging \
  --confirm remove-staging-monitoring-config \
  --purge-secret-handoff

sudo "${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/rollback-host-collectors.sh \
  --expected-host-payload-digest "${ESMII_MONITORING_PAYLOAD_DIGEST}" \
  --expected-host-payload-revision "${ESMII_MONITORING_PAYLOAD_REVISION}" \
  --environment staging \
  --confirm disable-staging-monitoring
```

Use the production confirmation strings only for an approved production rollback. Shared collector removal is a separate exact-confirmation action and is refused while either environment remains registered/active. Durable Prometheus/auth/log state and the canonical `/etc` secret are preserved for diagnosis; delete or rotate them only under a separate bounded approval.

Never restore service by exposing Prometheus/exporter ports, mounting Docker/journal into the dashboard, reusing the other environment's credential, bypassing email OTP, or adding Grafana/Loki/cAdvisor. Same-host monitoring also cannot detect complete VPS/provider/DNS loss; that remains the separate off-host outage-monitor gate.
