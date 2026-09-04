# Netcup VPS setup and host hardening

## 1. Scope

This runbook prepares one Netcup RS 1000 G12 for isolated staging and production. It is implemented as idempotent Ansible in `infra/ansible/` plus root-owned systemd units in `infra/systemd/`.

The expected host is x86-64/KVM with 4 dedicated AMD EPYC cores, 8 GB ECC RAM, 256 GB NVMe, one static IPv4 address, and a routed `/64` IPv6 subnet. Ubuntu 26.04 LTS is required.

Prompt 04 created and validated the host code locally. Prompt 05 performed separately approved provisioning and staging deployment. Prompt 06 performed separately approved production/mail activation. Prompt 07 adds a custom monitoring repository/CI implementation only; its live audit, secrets, host installation, staging Worker/DNS/TLS migration, staging activation/soak, production DNS/TLS activation, and off-host outage monitor remain separate approvals.

## 2. Provider responsibility map

| System | Responsibility |
|---|---|
| Netcup CCP | Account, contract, billing, identity verification, product administration, abuse notices, optional DPA |
| Netcup SCP | Power, console, image/custom ISO, rescue, snapshots, server firewall, assigned IPs, PTR, `netcup Mail block` |
| Cloudflare | Registrar and authoritative A/AAAA/CNAME/MX/TXT DNS records; narrowly scoped DNS-01 token if used |
| GitHub | Repository, protected branches, Actions, Environments, deployment approvals/status, GHCR |
| VPS/Ansible | Ubuntu, SSH, host firewall, Docker, directories, systemd, application stacks |
| Off-Netcup backup provider | Encrypted production Restic repository and recovery path |

Do not place broad Netcup SCP/CCP credentials in GitHub. The normal deploy path needs only outbound HTTPS from the VPS to GitHub/GHCR.

## 3. Required inputs

Before Prompt 05 remote discovery/provisioning, record:

- Netcup account/order verification completion using truthful details matching accepted identity documents;
- RS 1000 G12 contract/order and server IDs, selected location and contract term;
- confirmation that `IPv4 + IPv6 Connectivity` was selected at order time;
- assigned static IPv4, IPv6 `/64`, gateway/network details, and target `linux/amd64` platform;
- SCP and CCP recovery access owners;
- whether the server is empty/disposable and what, if anything, must be preserved;
- Ubuntu 26.04 stock-image identifier or official ISO URL, checksum, and signature verification record;
- administrator public key, proposed non-root username, administrative source CIDR or VPN, and emergency recovery contact;
- Cloudflare zone and the staging-DNS authority/token reference;
- staging hostname, explicit `open`/`allowlist` access mode, and staging OAuth-client references;
- current Netcup firewall and `netcup Mail block` status;
- protected `dev`/`main`, GitHub staging/production Environments, GitHub App identity, and read-only GHCR credential plan;
- immutable deployment-checkpoint storage outside Netcup, its restricted VPS credential, and its separate recovery/policy custodian;
- whether a Netcup DPA is required for the project's personal-data obligations.

Before the corresponding Prompt 06 production gate, additionally record:

- production application, mail, bounce, and certificate-contact values;
- production Google OAuth-client references;
- reviewed production prelaunch tester/VPN CIDRs and the collision-free production edge/mail-admin network values selected after host discovery;
- PTR control, current assigned-IP reputation results, and written Netcup transactional-mail clarification if required;
- the off-Netcup Restic destination, non-deleting VPS credential, separate retention/recovery custodian, and restore-test destination;
- the encrypted append-only off-Netcup security-tombstone journal and separate recovery/decrypt identity;
- external monitoring and alert destination;
- production mail senders and named operational mailboxes.

Before a Prompt 07 monitoring host action, additionally record:

- a fresh read-only inventory of listeners, Docker networks/containers, Caddy routes/certificates, systemd units/timers, memory/disk/inodes, and current Cloudflare Worker/DNS routes for both dashboard hostnames;
- the exact pinned Prometheus/node_exporter artifacts and checksums plus the immutable dashboard image digest/source/revision/version labels;
- separate root-only staging/production dashboard password, dedicated SMTP sender, session, recovery, SQLite/audit, and cookie-state file references without recording their values;
- the captured pre-change Worker route/DNS state and tested restore procedure for each hostname;
- the staging 24-hour soak start/end and objective acceptance evidence; and
- an independently owned off-host outage-monitor destination, if that later gate is being proposed.

Production-only values are not prerequisites for Prompt 05 staging. Each becomes mandatory immediately before the Prompt 06 action that consumes it.

If Netcup identity verification cannot process the identifying script on the document, contact Netcup or use an offered prepayment route. Do not treat the server as available until verification and provisioning complete.

## 4. Approval sequence

Remote setup is deliberately multi-gated:

1. approve read-only SCP/CCP/server discovery;
2. if needed, approve destructive Ubuntu installation on the exact confirmed-empty server;
3. approve the first read-only SSH baseline;
4. approve the exact first-host bootstrap Ansible `--check --diff`, with SSH lock-down and host-firewall activation disabled;
5. review that diff and separately approve only the bootstrap apply;
6. prove a second keyed named-operator session, its reviewed sudo method, SCP console recovery, and a stable administrator CIDR or approved VPN;
7. approve and review a separate SSH/host-firewall hardening `--check --diff`, then separately approve its apply;
8. approve Cloudflare staging DNS, staging OAuth, GitHub staging Environment, and staging secrets;
9. approve staging release sealing and activation;
10. later, approve production secrets/release activation in Prompt 06;
11. separately approve Netcup Mail-block removal, firewall/PTR, Cloudflare mail DNS, Stalwart, and a controlled mail test;
12. separately approve off-Netcup Restic initialization/restore testing, `main` advancement, and public launch;
13. for Prompt 07, approve a fresh read-only host/Cloudflare audit before any monitoring change;
14. separately approve root-only operator-secret creation/installation and the pinned node_exporter/socket-proxy/collector plus private staging Prometheus/dashboard apply;
15. separately approve migration of `staging-dashboard.esmii.app` from its current Cloudflare Worker route to Caddy, including DNS/TLS and exact rollback state;
16. accept the continuous 24-hour staging soak only after reviewing capacity, isolation, auth, redaction, and application-latency evidence; and
17. separately approve production monitoring secrets/apply and the fresh `dashboard.esmii.app` DNS/TLS activation after proving the hostname is unoccupied. Off-host outage monitoring is another independent gate.

Approval for one step does not authorize the next.

## 5. Host invariants

- Ubuntu 26.04 LTS on `x86_64`/`linux/amd64`.
- One non-root administrator using key-only SSH; root/password login disabled only after a second session and SCP console recovery are proven.
- Administrative SSH allowed only from the reviewed admin CIDR/VPN.
- GitHub-hosted runners never SSH to the host; deployment is pull-based over outbound HTTPS.
- Netcup provider firewall and host firewall both enforce reviewed policy.
- Docker installed from an approved pinned source; Compose version meets the repository preflight.
- Docker socket is never public and only trusted root-owned wrappers may control it.
- No database, cache, Mailpit, Stalwart admin, reconciler, private-health, dashboard `3000`, Prometheus `9090`, or node_exporter `9100` port is public.
- Shared Caddy is the only public HTTP edge.
- Staging and production state/credentials/networks remain separate.
- The Netcup Mail block remains enabled through staging.
- Restic production backups leave Netcup.
- Provider console/rescue access is retained and periodically verified.

## 6. Read-only discovery

Before making changes, compare host observations with SCP:

```bash
hostnamectl
uname -a
uname -m
cat /etc/os-release
systemd-detect-virt
nproc
free -h
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
df -hT
ip -br address
ip route
ip -6 route
ss -lntup
systemctl --failed
journalctl -p warning -b --no-pager
```

Record installed packages/services, listeners, users, SSH policy, firewall state, time sync, disk layout, and anything not expected on a new server. Stop if server ID, IP, location, architecture, disk, OS, recovery access, or preserved-data assumptions do not match.

## 7. Ubuntu installation

Check the available SCP images first. If Ubuntu 26.04 LTS is available, use the exact reviewed image. Otherwise:

1. obtain the official Ubuntu Server ISO from Ubuntu;
2. verify checksum and signature on the control machine;
3. upload/mount it using Netcup's SCP custom-ISO workflow;
4. confirm the exact server is empty and the installation target is the expected 256 GB disk;
5. receive explicit destructive approval;
6. install a minimal system with OpenSSH and no optional server roles;
7. unmount the ISO, boot the installed system, and record the resulting OS/disk/network identity.

Reimaging destroys the selected server disk. Never infer approval from the fact that the server is new.

Netcup rescue mode is an emergency path. The provider firewall may be disabled while rescue mode is active, so rescue use requires its own exposure check and immediate credential hygiene afterward.

## 8. Ansible structure

Recommended layout:

```text
infra/ansible/
├── ansible.cfg
├── requirements.yml
├── inventories/
│   └── netcup/
│       ├── hosts.example.yml
│       ├── hosts.yml                 # ignored local exact target
│       └── group_vars/
│           └── all.yml              # committed non-secret variables only
├── playbooks/
│   └── vps.yaml
└── roles/
    ├── baseline/
    ├── users/
    ├── ssh/
    ├── firewall/
    ├── docker/
    ├── directories/
    ├── logging/
    ├── deployment_reconciler/
    ├── systemd/
    └── verification/
```

Pin collection versions. Commit `infra/ansible/inventories/netcup/hosts.example.yml` and its non-secret `group_vars/all.yml`; do not create competing example inventory/group-variable trees. Keep the real `hosts.yml` ignored locally (or use an explicitly approved external inventory path), and keep keys, tokens, and secret values outside Git. Templates refer to secret file paths only. Before any remote command, prove the real inventory is not tracked and that it resolves exactly one reviewed Netcup server under `<NETCUP_INVENTORY_HOST>`.

Every remote apply is preceded by:

```bash
ansible-playbook --check --diff \
  -i infra/ansible/inventories/netcup/hosts.yml \
  infra/ansible/playbooks/vps.yaml \
  --limit <NETCUP_INVENTORY_HOST>
```

After apply, repeat check mode. A stable host should report no unexplained changes.

## 9. Baseline packages and settings

Install only required components, for example:

- CA certificates, curl, jq, unzip, rsync;
- nftables or UFW with Docker-aware policy;
- fail2ban only if its policy is tested and useful;
- chrony/systemd-timesyncd;
- unattended security updates with controlled reboot notification, not unattended application image upgrades;
- Restic and PostgreSQL client tools needed by trusted backup wrappers;
- Docker Engine, buildx/Compose plugin at reviewed versions;
- audit/log rotation utilities.

Configure:

- UTC system clock and reliable NTP;
- a modest swap file as an emergency buffer, not normal capacity;
- Docker `local` logging driver with bounded rotation, matching the concrete `daemon.json` baseline in `docs/infrastructure.md`;
- journald retention consistent with the 256 GB disk budget;
- kernel/file limits only when measured need justifies them;
- automatic security patches with an explicit maintenance/reboot policy;
- no Watchtower or unattended `latest`-tag deployment.

## 10. Users, SSH, and recovery

- Create one named admin account with the reviewed public key. The dedicated keyed `esmii-administrator` receives the explicitly approved, `visudo`-validated `NOPASSWD: ALL` policy; do not add it to the Docker group.
- Test a second independent SSH session before disabling root/password authentication.
- Disable password auth, keyboard-interactive auth, empty passwords, agent/X11/TCP forwarding unless an approved tunnel explicitly needs one.
- Restrict SSH at both Netcup and host firewalls to the admin CIDR/VPN.
- Keep SCP console and rescue recovery available and test ownership of the recovery path.
- Do not install a persistent general-purpose self-hosted GitHub Actions runner on the production host.
- The deployment reconciler uses fixed code and outbound HTTPS; it is not an interactive SSH user.

## 11. Network and firewall

Netcup's firewall is stateful. New servers may initially allow traffic except SMTP; adding rules can change the direction's implicit behavior. Treat every rule set as a complete reviewed policy and externally scan it after apply.

For the host firewall, install every reviewed SSH, VPN, and web allow rule while UFW is still inactive, then set the default-deny policy and enable UFW only as the final firewall step. Never create a lockout window by enabling the default-deny policy before the administrator rules exist.

### 11.1 Provider and host ingress

| Port | Protocol | Source | Phase | Purpose |
|---:|---|---|---|---|
| 22 | TCP | approved admin CIDR/VPN only | Prompt 05 | administration |
| 51820 | UDP | authenticated WireGuard peers | Prompt 05 | administrator VPN endpoint |
| 80 | TCP | public | Prompt 05 | HTTP redirect/ACME if required |
| 443 | TCP/UDP as used | public | Prompt 05 | HTTPS/HTTP3 through Caddy |
| 25 | TCP | public mail peers | Prompt 06 mail gate only | SMTP reception |
| 1993 | TCP | host loopback only | Prompt 06 | tunnel to operational IMAPS while validating `<MAIL_HOSTNAME>` |

Everything else is denied unless a reviewed requirement is added. PostgreSQL, Valkey, Docker, Caddy admin, Stalwart admin, Mailpit, reconciler, dashboard `3000`, Prometheus `9090`, node_exporter `9100`, and internal service ports are never public. Prompt 07 adds no provider- or host-firewall ingress rule: Caddy remains the sole public HTTP path.

### 11.2 Egress

Allow only what the host/services require: DNS, NTP, HTTPS to Ubuntu/GitHub/GHCR/backup/monitoring endpoints, and later approved SMTP for Stalwart. Workers have no public egress. Restricting container traffic requires Docker-aware `DOCKER-USER`/nftables rules plus Compose internal networks; host INPUT rules alone are insufficient.

### 11.3 Netcup Mail block

The SCP `netcup Mail block` blocks incoming and outgoing SMTP. Keep it enabled through Prompt 05. In Prompt 06, remove it only after written policy clarification where needed, assigned-IP reputation checks, Stalwart/TLS/queue/bounce readiness, PTR and DNS review, firewall review, and explicit approval. Verify inbound and outbound TCP 25 separately. Block removal proves connectivity, not deliverability.

## 12. Directory and permission model

Create during initial provisioning:

```text
/srv/myapp/
├── release-inbox/
├── releases/
├── operation-recovery/
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
├── secrets/
│   ├── staging/
│   └── production/

/etc/esmii/monitoring/
├── staging/                           # separate secret/config files, mode 0600
└── production/                        # separate secret/config files, mode 0600

/var/lib/<app-slug>/operations/         # root:root 0700 persistent journal/inhibit state
/var/lib/esmii/monitoring/
├── shared/
│   ├── state/                          # collector cursors/status, no secrets
│   └── textfiles/                      # atomically replaced Prometheus textfiles
├── staging/
│   ├── auth/                           # staging SQLite auth/audit state
│   ├── prometheus/                     # staging TSDB
│   └── logs/                           # staging sanitized snapshot
└── production/
    ├── auth/                           # production SQLite auth/audit state
    ├── prometheus/                     # production TSDB
    └── logs/                           # production sanitized snapshot
```

The top-level tree and releases are root-owned/non-writable by the deploy identity. Production directories may exist empty before Prompt 06, but no production data/secrets/services are initialized in Prompt 05. Caddy receives read-only access only to `*/media/public/variants`; API/worker receive only their environment-specific mounts. Monitoring secret/config files are root-owned mode `0600`. Monitoring SQLite/auth/audit, Prometheus TSDB, collector cursor, and log-snapshot paths are separate per environment; dashboard mounts are read-only except the exact environment-local auth/audit/cache path. Neither dashboard receives application databases, customer auth state, Docker/journal sockets, or the other environment's state.

The deployment identity cannot write `/var/lib/<app-slug>/operations`. Journal/inhibit files are atomically written and fsynced, survive reboot, and are cleared only by a verified commit/rollback recovery path. Completed journals have bounded archival retention and are included only as encrypted recovery evidence; restoring an old journal never authorizes a new operation.

Install `/etc/tmpfiles.d/<app-slug>-locks.conf` so `/run/lock/<app-slug>` is recreated as `root:root` mode `0700` on every boot. Mutating services order after `systemd-tmpfiles-setup.service`; wrappers validate exact ownership/mode/no-symlink before `flock` and fail closed on drift. Do not put the persistent inhibit marker under `/run`.

## 13. Docker and systemd

- Pin/record Docker and Compose versions.
- Use a fixed project name and exact overlay list from the sealed manifest.
- Explicitly target `unix:///var/run/docker.sock` and the local default context.
- Reject caller `DOCKER_HOST`, `DOCKER_CONTEXT`, `COMPOSE_FILE`, profiles, project-directory, and env-file overrides.
- Reject host PID/network/IPC namespaces, privileged mode, device mounts, Docker-socket mounts, dangerous capabilities, arbitrary bind mounts, and unapproved published ports.
- Use read-only root filesystems and dropped capabilities where compatible.
- Define health checks, restart policies, logging limits, and memory/CPU limits.

Systemd units/timers cover:

- deployment reconciliation;
- backup and restore checks;
- certificate/health checks;
- host-only Docker image/build-cache/log pruning with protected current/previous digests; this timer never runs Restic `forget`, `prune`, repository deletion, or retention;
- disk-pressure and OOM checks;
- maintenance jobs with locking and failure alerts.

Prompt 07 additionally defines these disabled-by-default host units until their separate apply gate:

- `esmii-node-exporter.service` on loopback plus separate staging/production proxy socket-service pairs on only `172.30.40.9:9100` and `172.30.41.9:9100`; enabling one environment cannot pull in the other environment's socket, and all five units share the 64 MiB `esmii-node-exporter.slice` ceiling;
- `esmii-container-metrics-collector.timer` every 15 seconds with a fixed root-owned one-shot service at `MemoryMax=64M`; and
- `esmii-log-collector.timer` every 30 seconds with a separate fixed root-owned one-shot service at `MemoryMax=64M`.

The reviewed host-collector entrypoints are `infra/monitoring/install-host-collectors.sh` and `infra/monitoring/rollback-host-collectors.sh`; they install or remove only the allowlisted `infra/systemd/esmii-node-exporter*`, `infra/systemd/esmii-container-metrics-collector*`, and `infra/systemd/esmii-log-collector*` units plus their fixed scripts/configuration. Environment runtime rendering/apply/rollback uses only `infra/monitoring/render_monitoring.py`, `infra/monitoring/install-monitoring-runtime.sh`, `infra/monitoring/manage-monitoring-runtime.sh`, `infra/monitoring/install-pull-wrapper-integration.sh`, and `infra/monitoring/rollback_monitoring_runtime.py`. These programs are never installed or run mutably from a checkout: CI builds the dedicated closed Prompt-07 host payload, the operator independently records its archive/full-revision, tiny-bootstrap, and fixed-verifier hashes, installs the two separately approved verifier components outside the candidate tree, and only that fixed verifier materializes the archive under `/var/lib/esmii/monitoring/host-payloads/<digest-hex>`. Every mutating entrypoint re-verifies that sealed identity before creating locks/directories or changing state, and the collector, active-pull integration, and rendered runtime records bind it. Rendering is inert; the fixed manager alone changes private/edge activation markers and every monitoring Compose mutation shares `/run/lock/esmii/host-pull.lock` with the active project-`esmii` pull services. The two collectors must not overlap. They accept no parameters from HTTP/dashboard input, never expose a listener, and write only atomic bounded outputs. Node-exporter/collector or monitoring-runtime installation, enablement, or start is an external host mutation requiring its own approved check/apply.

Timers must use locking, bounded runtimes, explicit environments, persistent missed-run behavior where safe, and observable failure.

Use explicit schedules rather than one ambiguous backup timer:

| Unit | Initial schedule | Enablement | Required controls |
|---|---|---|---|
| deployment reconciler | 2 minutes after boot, then every 2 minutes | Prompt 05 | bounded network/runtime timeout; global lock only inside accepted activation |
| health check | every 5 minutes | Prompt 05 | outside-host alert on failure; no mutation |
| database backup | every 6 hours at minute 15 | Prompt 06 | `Persistent=true`, randomized delay up to 5 minutes, effective oneshot `TimeoutStartSec=45m`, bounded locks |
| state backup (media/mail/config) | daily 01:30 UTC | Prompt 06 | `Persistent=true`, randomized delay up to 15 minutes, effective oneshot `TimeoutStartSec=2h`, bounded locks |
| isolated restore check | Sunday 08:30 UTC | Prompt 06 | `Persistent=true`, randomized delay up to 15 minutes, effective oneshot `TimeoutStartSec=3h`, no production egress |
| host prune | Saturday 04:30 UTC | Prompt 05 | `Persistent=true`, randomized delay up to 15 minutes, effective oneshot `TimeoutStartSec=30m`; Docker/image/log only |
| maintenance | first Sunday 14:00 UTC | Prompt 05 | reviewed non-upgrade tasks only, `Persistent=true`, randomized delay up to 15 minutes, effective oneshot `TimeoutStartSec=2h` |
| container metrics collector | every 15 seconds | Prompt 07 staging-host gate | fixed allowlist; `Persistent=false`; 12-second timeout; 64 MiB; scheduled not to overlap log collection |
| sanitized log collector | every 30 seconds | Prompt 07 staging-host gate | fixed allowlist/redaction; `Persistent=false`; 25-second timeout; 64 MiB; scheduled not to overlap metrics collection |

Every service has `OnFailure` wired to the external alert path and logs a run ID, result, duration, and lock outcome. The nominal times plus maximum random delay/runtime leave non-overlapping windows for state backup, weekly restore, host prune, maintenance, and the six-hour database job. Staggered randomized delays plus bounded locks handle simultaneous missed-run catch-up after reboot; a job that times out defers/alerts instead of running concurrently. Test the actual `systemd-analyze calendar` output, worst-case windows, reboot catch-up, timer overlap, and disabled-before-Prompt-06 state.

## 14. DNS, PTR, TLS, and OAuth ownership

Cloudflare changes:

- staging and production A/AAAA records;
- only after separate Prompt 07 gates, migrate `staging-dashboard.esmii.app` from its recorded Cloudflare Worker custom-domain binding to the reviewed Caddy origin path, then create `dashboard.esmii.app` DNS only after a fresh audit proves the name remains unoccupied;
- `mail.<domain>` A/AAAA as verified;
- MX, SPF, DKIM, DMARC, bounce/feedback records;
- narrowly scoped DNS-01 token if certificate automation requires it.

Mail-related records must be DNS-only, not proxied. Application proxying is a separate reviewed choice and must preserve websocket/auth behavior.

Before either dashboard migration, use a read-only Cloudflare audit to capture exact Worker route, record type/value/proxy state/TTL, origin reachability, and certificate state. Never guess that the two hostnames are ordinary A/AAAA records. Preserve the captured Worker configuration as the rollback target. After the separately approved route/DNS mutation, Caddy must obtain and auto-renew that hostname's Let's Encrypt certificate, redirect HTTP to HTTPS, serve only the intended environment dashboard, and expose no raw `3000`, `9090`, or `9100` path. A failed validation restores that hostname's preceding Worker/DNS route before any later environment proceeds.

Netcup SCP changes:

- provider firewall;
- `netcup Mail block` removal;
- IPv4 and, only when enabled/tested, IPv6 PTR to `<MAIL_HOSTNAME>`.

OAuth-console changes:

- separate staging and production Google clients/callbacks;
- no shared secrets or wildcard callback URLs.

Delay IPv6 mail sending/listening until IPv6 firewall, forward DNS, PTR, TLS, and delivery behavior are verified. It is acceptable to run application IPv6 while mail initially uses only the proven IPv4 identity.

## 15. Stalwart production boundary

Production Stalwart is configured in Prompt 04 but activated only in Prompt 06. Requirements:

- administration on a private fixed listener reachable only from the approved admin path;
- internal submission validates `<MAIL_HOSTNAME>` TLS/SNI, not a container-only hostname;
- low transactional quotas and rate limits;
- signed, replay-resistant, idempotent delivery/bounce ingestion;
- monitored queues, deferrals, bounces, suppressions, certificate expiry, and abuse signals;
- only application transactional mail and named operational mailboxes;
- no newsletters, campaigns, marketing, broadcasts, bulk mail, or general end-user mailbox hosting.

Monitor the Netcup account email/CCP for abuse notices and maintain a documented response owner.

## 16. Backup and provider snapshots

Restic is the production recovery system. Its repository must be outside Netcup and use independent credentials/recovery custody. Run backup/restore only through the root-owned wrapper described in `docs/deployment.md`.

Netcup offline snapshots may be taken before risky host maintenance when separately approved. They remain in the provider/account failure domain, may have export limits/costs, and never replace database/media/config backups or restore testing.

## 17. Lightweight operations baseline

The 8 GB host runs shared Caddy, reduced staging, and production. Prompt 07 authorizes repository implementation of one exact 1,088 MiB on-host exception: two 192 MiB dashboards, two 256 MiB Prometheus instances, one 64 MiB aggregate node_exporter/socket-proxy slice, and two non-overlapping 64 MiB root collectors. Prometheus retains at most seven days/1 GB inside a 1.25 GB disk allowance per environment. Log snapshots retain at most 24 hours/10,000 events/20 MiB with 4 KiB per-message truncation. Keep Grafana, Loki, cAdvisor, Alertmanager, additional exporters, tracing, ClamAV, SeaweedFS, search clusters, replicas, and other optional containers disabled until measured need and a separately approved capacity/design change.

Minimum alerts:

- host unreachable and HTTPS failure;
- certificate expiry;
- RAM above 70% sustained, RAM above 75% urgent, normal-load swap, OOM kill;
- disk 60% warning, 70% action, 80% critical, inode pressure;
- container restart/health failure;
- PostgreSQL connection/disk/backup/restore age;
- Valkey memory/eviction;
- queue/outbox delay/failure;
- mail queue/deferral/bounce/reputation signals;
- reconciler poll/deployment/rejection failures;
- staging/production digest or isolation drift.

Same-host Prometheus is diagnostic, not an external outage signal. Host, provider-network, power, or authoritative-DNS loss can remove the dashboard and its monitor together, so the off-host outage monitor remains a separate production-acceptance gate.

## 18. Validation and handoff

Before declaring Prompt 05 complete:

- Netcup product/server/network, SCP/CCP, console, and rescue access match the record;
- Ubuntu source and installed identity are verified;
- Ansible apply is idempotent;
- external port scan matches policy;
- admin SSH remains reachable only from the approved path;
- the Netcup Mail block is still enabled;
- only base+staging is active and production is null;
- reboot recovers staging and the reconciler safely;
- combined resource headroom is acceptable.

Before Prompt 06 restricted-production acceptance and any later public launch:

- production uses the exact staging-tested digests;
- environment isolation passes;
- Netcup transactional-mail policy evidence, Mail-block removal, PTR, firewall, and assigned-IP reputation are recorded;
- Cloudflare application/mail DNS and exact OAuth callbacks pass;
- Stalwart has no bulk/marketing capability and controlled tests pass;
- off-Netcup Restic backup and isolated restore pass;
- external monitoring and rollback pass;
- `main` follows the verified-live rule after restricted-production acceptance;
- opening the restricted hostname publicly, if requested, receives its own later approval. Remaining restricted is a valid launch decision and does not invalidate the accepted production release.

Before Prompt 07 staging monitoring soak acceptance:

- the fresh host/Cloudflare audit and exact rollback state are recorded;
- only private monitoring ports/listeners exist, the four monitoring subnets render exactly, and no dashboard/Prometheus/Caddy process has the Docker socket;
- staging operator password plus a five-minute single-use email OTP, dedicated environment sender, certificate-verified private Stalwart submission, eight-hour session, host-only cookie, CSRF/origin, rate-limit, revocation, and anonymous/password-only/wrong-host denial tests pass without exposing secrets;
- Prometheus retention, snapshot age/count/size/message bounds, source allowlists, redaction sentinels, metric relabeling, and stale/degraded states pass;
- total monitoring ceilings equal 1,088 MiB and a continuous 24-hour soak under representative application/mail load shows no sustained RAM above 70%, sustained swap, OOM, restart loop, disk/inode breach, or unacceptable application latency; and
- staging rollback restores its preceding Worker route and removes only staging monitoring state/routes, leaving customer application/data/mail and production unchanged.

Production monitoring requires explicit acceptance of that evidence, new production-only secrets/state, the same verified dashboard digest, a separate `dashboard.esmii.app` occupancy-check/DNS/TLS gate, production isolation tests, and a production-specific rollback rehearsal. It never inherits staging credentials or treats CI publication as deployment permission.

## 19. Netcup references

- [RS 1000 G12](https://www.netcup.com/en/server/root-server/rs-1000-g12-ip-iv-12m)
- [Network configuration](https://www.netcup.com/en/helpcenter/documentation/server/network-configuration)
- [Server media, custom ISO, and snapshots](https://www.netcup.com/en/helpcenter/documentation/server/media)
- [Firewall and Mail block](https://www.netcup.com/en/helpcenter/documentation/server/firewall)
- [Network and PTR](https://www.netcup.com/en/helpcenter/documentation/server/network-server)
- [Rescue system](https://www.netcup.com/en/helpcenter/documentation/server/rescue-system)
- [Instance upgrades](https://www.netcup.com/en/helpcenter/documentation/general/instance-upgrade)
- [Identity verification](https://www.netcup.com/en/helpcenter/documentation/general/identity-verification)
- [Data processing agreement](https://www.netcup.com/en/helpcenter/documentation/general/dpa)
- [Abuse notices](https://www.netcup.com/en/helpcenter/documentation/security/abuse-notices)
- [Terms and conditions](https://www.netcup.com/en/terms-and-conditions)
