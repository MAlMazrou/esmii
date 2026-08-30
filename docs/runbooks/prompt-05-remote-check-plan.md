# Prompt 05 remote check plan and evidence

The initial root-key access, read-only SSH baseline, first-host Ansible bootstrap check/apply, separately approved WireGuard/passwordless-sudo gate, Netcup rescue proof, and corrected SSH/host-firewall hardening check/apply were completed on 30 August 2026. Every enabled timer, SCP/provider change, DNS/OAuth change, credential install, release action, and later host mutation still requires its own explicit Prompt 05 authorization.

## 1. Provider-console verification first

- Confirm exact Netcup server ID, plan, datacenter, x86-64 architecture, 4 cores, 8 GB RAM, 256 GB disk, assigned IPv4, routed IPv6 `/64`, and confirmed-empty status.
- Prove SCP console and rescue access. Record current snapshots/media without changing them.
- Export/review the complete Netcup firewall and confirm the `netcup Mail block` is enabled.
- Record current PTR and DNS state without changing either.

## 2. First SSH is read-only

Use the reviewed known host-key fingerprint and the bootstrap address. Do not use a dynamic GitHub runner address.

```bash
ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes <BOOTSTRAP_USER>@<VPS_IPV4>
```

Run and retain only non-secret results:

```bash
hostnamectl
cat /etc/os-release
uname -m
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
df -hT
free -h
ip -br address
ip route
ip -6 route
ss -lntup
systemctl --failed
journalctl -p warning -b --no-pager
docker version
docker compose version
```

Stop on identity drift, unexpected listeners/users/services/data, insufficient console recovery, wrong OS/architecture, disk mismatch, or unreviewed firewall state.

## 3. Local inventory and check mode

Copy `infra/ansible/inventories/netcup/hosts.example.yml` to the ignored `hosts.yml`, fill only reviewed non-secret host values, and keep secrets outside Git.

The first-host bootstrap inventory must keep both controls false:

```yaml
esmii_disable_ssh_passwords: false
esmii_enable_host_firewall: false
esmii_second_session_confirmed: false
```

This permits review and a later separately approved bootstrap apply without disabling root/password recovery or enabling UFW. The dynamic home egress `/32` may be recorded for check evidence but must not become a permanent firewall rule.

```bash
ansible-galaxy collection install -r infra/ansible/requirements.yml -p .local/prompt04/ansible/collections
ANSIBLE_CONFIG=infra/ansible/ansible.cfg ansible-inventory -i infra/ansible/inventories/netcup/hosts.yml --graph
ANSIBLE_CONFIG=infra/ansible/ansible.cfg ansible-playbook --check --diff -i infra/ansible/inventories/netcup/hosts.yml infra/ansible/playbooks/vps.yaml --limit esmii-vps
```

The 30 August 2026 bootstrap check passed with `ok=34`, `changed=24`, `unreachable=0`, and `failed=0`. It planned packages, UTC, swap, users, Docker, directories, fixed root-owned tooling, and disabled units while skipping SSH lock-down, UFW activation, and every timer. Post-check probes confirmed that none of those planned changes occurred.

Review the full diff, especially users, Docker daemon, swap, ownership, tmpfiles, sudoers, and disabled timer state. Check mode is a remote connection but is not an apply.

## 4. Two-stage access safety

The separately approved first real apply used the bootstrap flags above and completed with `ok=38`, `changed=23`, `unreachable=0`, and `failed=0`. Its post-apply check completed with `ok=33`, `changed=1`, `unreachable=0`, and `failed=0`; the sole reported change was the intentional check-mode planning notice for numeric container-owned directories. At that gate, root and `esmii-administrator` keyed sessions both worked, UFW remained inactive, no Esmii timer was enabled, only SSH was publicly listening, and no reboot was required.

After the separately approved hardening apply, the saved ignored inventory uses `esmii-administrator@10.77.0.1`, retains `HostKeyAlias=152.53.251.34` for host-key verification, and records `esmii_disable_ssh_passwords: true`, `esmii_enable_host_firewall: true`, and the proven second-session gate. It contains no application or provider secret.

Never claim second-session or stable-source confirmation in inventory merely to satisfy an assertion.

### 4.1 Verified administrator VPN and sudo gate

The approved configuration uses `wg0`, UDP 51820, server `10.77.0.1/24`, and administrator peer `10.77.0.2/32`; the client routes only `10.77.0.1/32`. The final apply completed with `ok=48`, `changed=4`, `unreachable=0`, and `failed=0`. Its post-check completed with `ok=47`, `changed=1`, `unreachable=0`, and `failed=0`; the sole reported change is the existing check-mode directory-planning marker.

Verification proved all of the following without changing either firewall or the SSH policy:

- public keyed root and `esmii-administrator` SSH still worked at that gate;
- `esmii-administrator` ran `sudo -n` as UID 0;
- `wg-quick@wg0` was active/enabled, UDP 51820 was listening, and `/etc/wireguard/wg0.conf` was `root:root` mode `0600`;
- a disposable isolated Ubuntu client first completed the WireGuard handshake, pinged `10.77.0.1`, and opened keyed SSH with server-observed source `10.77.0.2`, then was removed;
- the protected client configuration was imported into the persistent macOS WireGuard application, and its active `esmii-admin` tunnel completed a current handshake and keyed SSH through `10.77.0.1` with server-observed source `10.77.0.2` and passwordless sudo to UID 0;
- UFW remained inactive, `/etc/ssh/sshd_config.d/60-esmii.conf` remained absent, and the Netcup provider firewall was not changed;
- the mode-0600 source client configuration remained ignored from Git after the persistent macOS import.

### 4.2 Verified Netcup console and rescue recovery

On 30 August 2026, the separately approved rescue proof completed a real recovery cycle:

- the authenticated SCP Screen displayed the installed Ubuntu console for server `v2202608407081508770`;
- a clean preflight found no failed units or running containers before an ACPI shutdown;
- Netcup rescue mode booted successfully and the SCP console reached a live UID-0 root shell without sending the generated rescue password over public SSH;
- the rescue hostname matched the server record and the original 256 GB `vda` disk exposed the expected EFI, `/boot`, and root partitions;
- rescue mode was explicitly deactivated, its temporary system shut down, and the normal disk boot was started manually;
- post-boot SSH through `10.77.0.1` again proved `esmii-administrator`, server-observed source `10.77.0.2`, passwordless sudo to UID 0, active SSH and `wg-quick@wg0`, no failed units, no running containers, inactive UFW, and no SSH-hardening drop-in;
- the Netcup firewall returned active with the same Mail-block, ping, and implicit policies.

No disk, snapshot, installed-system credential, SSH policy, host-firewall policy, or provider-firewall rule changed during the proof.

### 4.3 Reviewed SSH and host-firewall hardening check

The separately approved hardening dry-run connected as `esmii-administrator` through `10.77.0.1`, with the server observing source `10.77.0.2`, and used the already verified passwordless sudo path. The first review exposed an unsafe task order that would have enabled default-deny UFW before installing its allow rules. Repository code was corrected so all SSH, WireGuard, and web rules are staged first and UFW activates last. The SSH policy was also brought into line with this runbook by explicitly disabling empty passwords and TCP forwarding. Focused Ansible tests passed before the corrected remote check.

The corrected `--check --diff` completed with `ok=54`, `changed=6`, `unreachable=0`, and `failed=0`. The six reported task-level changes were:

- install `/etc/ssh/sshd_config.d/60-esmii.conf`, allowing only public-key login by `esmii-administrator` and disabling root, password, keyboard-interactive, empty-password, agent, X11, TCP-forwarding, and tunnel access;
- allow TCP 22 only from the administrator VPN address `10.77.0.2/32`;
- allow public UDP 51820 for authenticated WireGuard peers;
- allow public TCP 80 plus TCP/UDP 443 for the future Caddy edge;
- activate default-deny UFW only after those allow rules exist;
- emit the already known check-mode planning marker for numeric container-owned directories.

No package, user, WireGuard configuration, Docker setting, fixed directory, release tool, systemd unit, or timer otherwise differed. The OpenSSH candidate passed its remote `sshd -t` validation, and the service reload handler correctly skipped in check mode.

Post-check probes confirmed that the VPS remained unchanged: keyed VPN SSH and passwordless sudo still worked, UFW was inactive with no staged rules, the SSH drop-in was absent, SSH and `wg-quick@wg0` were active, and there were no failed units or running containers. The saved inventory remained non-hardened, public root/operator access remained available, and neither the Netcup provider firewall nor its Mail block changed during the review.

### 4.4 Applied SSH and host-firewall hardening

After explicit approval, a fresh preflight again proved `esmii-administrator` through `10.77.0.1`, server-observed source `10.77.0.2`, passwordless sudo to UID 0, inactive UFW, absent SSH drop-in, active SSH/WireGuard, and no failed units. A public root fallback session was opened before the change and retained only until the fresh post-apply VPN session succeeded.

The broad `vps.yaml` apply was rejected before execution because it would have traversed the complete mutating host baseline instead of only the authorized SSH/UFW scope; it made no server change. Execution was constrained through an ignored local playbook containing only the repository's reviewed `ssh` and `firewall` roles plus assertions for the exact host, architecture, operator, recovery proof, VPN source, and enabled hardening flags. Its syntax check passed, and its final targeted `--check --diff` completed with `ok=11`, `changed=5`, `unreachable=0`, and `failed=0`. The five planned changes were exactly the SSH drop-in, VPN-scoped SSH rule, WireGuard rule, web rules, and UFW activation.

The targeted apply completed with `ok=12`, `changed=6`, `unreachable=0`, and `failed=0`; the sixth change was the expected SSH reload handler. Fresh verification proved:

- keyed SSH and passwordless sudo still work as `esmii-administrator` through `10.77.0.1`, with server-observed source `10.77.0.2`;
- `/etc/ssh/sshd_config.d/60-esmii.conf` is `root:root` mode `0600`, `sshd -t` succeeds, and the effective policy permits only public-key `esmii-administrator` while disabling root, passwords, keyboard-interactive, empty passwords, X11, agent/TCP forwarding, and tunnels;
- UFW is active and allows TCP 22 only from `10.77.0.2`, public UDP 51820, public TCP 80, and public TCP/UDP 443, with no public SSH rule;
- SSH and `wg-quick@wg0` are active, UDP 51820 and TCP 22 are listening, no containers are running, and no systemd unit is failed;
- fresh direct public root and operator SSH attempts to `152.53.251.34` both timed out as intended;
- the retained root fallback session remained UID 0 until those checks passed and was then closed cleanly;
- the targeted post-check completed with `ok=11`, `changed=0`, `unreachable=0`, and `failed=0`;
- the standard full playbook post-check through the saved VPN inventory completed with `ok=54`, `changed=1`, `unreachable=0`, and `failed=0`; its sole planned change was the known numeric-owner directory marker.

The saved ignored inventory now uses the VPN operator and hardened flags. A fresh read-only Netcup SCP view confirmed that the provider firewall remains active with exactly the prior `netcup Mail block`, `netcup Ping allow`, and implicit accept policies. No provider-firewall control was edited or saved.

## 5. Remaining Prompt 05 changes after hardening

- Keep the Netcup provider firewall and Mail block unchanged unless a later exact provider change is separately approved.
- Approve and configure a non-conflicting Cloudflare staging hostname plus exact staging OAuth callbacks.
- Configure the reviewed GitHub branch protections, staging Environment, GitHub App permissions, GHCR pull permission, and immutable application/shared-infrastructure publication.
- Approve and install staging-only secrets, reconciler credentials, and the immutable off-Netcup checkpoint identity.
- Under the later exact gates, seal and activate only base+staging with `production: null`; enable only Prompt 05 timers and validate reboot, rollback, isolation, resource headroom, and the external port surface.

Each DNS/OAuth, GitHub/GHCR, secret/credential, release-install, activation, and automatic-staging-policy action remains its own reviewed external change within Prompt 05.

## 6. Read-only external and network readiness audit

The 30 August 2026 read-only readiness pass changed no external state and found:

- GitHub `MAlMazrou/esmii` has only `main` at `74015f3aa9a6a1ca115aab02b8e06e3f96e07c45`, with no remote `dev`, branch protection, Environment, package, or Esmii deployment App boundary. The local `dev` candidate remains uncommitted and unpushed.
- Cloudflare already routes `staging.esmii.app` and `staging-dashboard.esmii.app` to a separate `esmii-staging` Worker. The first serves an existing business-name collaboration application and must not be overwritten without an explicit replacement decision. The `esmii.app` apex did not resolve during the same check.
- The existing EU R2 bucket `esmii-staging-backups-eu` contains unrelated `d1/` data, has public access disabled, and has no Bucket Lock rule. It is not currently an approved immutable deployment-checkpoint target.
- The VPS has routes for the public `/22`, WireGuard `10.77.0.0/24`, and Docker `172.17.0.0/16` only. The fixture staging edge pair `172.30.10.0/24` with fixed Caddy address `172.30.10.2` is collision-free but remains an explicit activation input.

These observations narrow the next proposals but do not authorize a commit/push, domain replacement, DNS/OAuth mutation, GitHub/GHCR configuration, bucket/retention/credential change, secret install, or release action.

### 6.1 Gate 7 staging name and DNS apply

After explicit approval and a direct user correction, `staging.esmii.app` is the only staging application hostname. Cloudflare exposed its previous Worker custom-domain record as read-only, so Gate 7 detached only the `staging.esmii.app` binding from the `esmii-staging` Worker, preserved `staging-dashboard.esmii.app`, and created DNS-only records with TTL 300:

- A `staging.esmii.app` → `152.53.251.34`;
- AAAA `staging.esmii.app` → `2a0a:4cc0:c0:a064:e463:5dff:fee8:b5c6`.

API verification found exactly those two records, the unchanged dashboard Worker record, and no rejected alternate hostname. Google Cloud project `Esmii Staging` (`esmii-staging`) now has an external consent configuration and the `Esmii Staging Web` client with origin `https://staging.esmii.app` and callback `https://staging.esmii.app/api/auth/callback/google`. The downloaded credential is protected in the ignored local Prompt 05 secret area with mode `0600`; it was not printed, committed, or installed on the VPS. The user removed Microsoft and Apple from the active provider scope, so Gate 7 is complete with Google only.

### 6.2 Temporary empty staging demo

On 30 August 2026 the user explicitly required an immediately visible empty sample site and authorized all staging-only work needed to reach it without another pause. The smallest reversible path was installed at `/srv/myapp/staging-demo`:

- one digest-pinned Caddy 2.11.4 Alpine container with a read-only root filesystem, `96 MiB` memory limit, `128` PID limit, bounded local logs, and `restart: unless-stopped`;
- root-owned mode-0644 Compose, Caddy, and static HTML inputs whose remote SHA-256 values match the ignored reviewed local copies;
- automatic HTTPS for exactly `staging.esmii.app`, HTTP-to-HTTPS redirect, `Cache-Control: no-store`, and `X-Robots-Tag: noindex, nofollow, noarchive`;
- no secret, OAuth credential, database, cache, Mailpit, API, worker, application web image, production state, or additional public port.

Fresh public verification returned HTTP/2 200 and the exact expected Esmii text. The Let's Encrypt certificate subject is `CN=staging.esmii.app`, the container reported healthy, Docker is enabled for restart persistence, and it was the only running container. This direct placeholder is not installed through the root-sealed release controller and therefore does not satisfy the permanent Prompt 05 release, migration, immutable-checkpoint, reconciler, rollback, or application acceptance gates. Replace it with the reviewed sealed base+staging release when those remaining inputs are available.

## 7. Local application-payload preparation

The repository can deterministically build the environment-neutral application payload after CI has produced the exact registry image digests, web/server SBOMs, provenance record, and pre-activation evidence record:

```bash
corepack pnpm release:build-application-payload -- \
  --input <CANDIDATE_INPUT_JSON> \
  --artifact-root <CI_ARTIFACT_DIRECTORY> \
  --output <IGNORED_LOCAL_OUTPUT_DIRECTORY>
```

The non-secret input names the full source SHA, digest-pinned `ghcr.io/malmazrou/esmii-web` and `esmii-server` images, exact migration transition, and relative paths to the two SBOMs, provenance, and CI evidence. The builder hashes the actual files, inventories the pinned lockfile and every migration source, emits canonical normalized tar bytes plus `payload-inventory.json`, rejects mutable images/missing migrations/symlinked evidence, and is deterministic. It does not build or push images, publish the payload, create an attestation, sign an activation manifest, or authorize any external/release action.

After the separately approved staging sealed-input action has produced its opaque record ID/MAC, and every other concrete non-secret input is reviewed, prepare the initial staging-only activation manifest locally:

```bash
corepack pnpm release:build-staging-manifest -- \
  --input <INITIAL_STAGING_INPUT_JSON> \
  --artifact-root <APPLICATION_PAYLOAD_DIRECTORY> \
  --output <IGNORED_LOCAL_OUTPUT_DIRECTORY>
```

This builder reads the actual application payload, derives its digest/source/images/migration/evidence fields, fixes the overlays to base+staging, fixes `production: null`, renders the reviewed templates, computes `rendered_compose_digest` and `shared_config_digest`, verifies the completed closed manifest, and writes it under its digest-addressed filename. It accepts only deployment sequence 1 with no predecessor. It does not mint the sealed-input MAC, sign or publish the manifest, install an approval record, upload to the VPS, or activate services.

After the actual shared/application payloads and initial manifest exist, prepare the exact review bundle for the later install and activation gates:

```bash
corepack pnpm release:build-staging-bundle -- \
  --manifest <DIGEST_ADDRESSED_MANIFEST_JSON> \
  --shared-payload <SHARED_INFRASTRUCTURE_TAR> \
  --application-payload <APPLICATION_PAYLOAD_TAR> \
  --target-host 152.53.251.34 \
  --checkpoint-target <APPROVED_IMMUTABLE_CHECKPOINT_TARGET> \
  --output <IGNORED_LOCAL_OUTPUT_DIRECTORY>
```

The builder re-verifies the canonical staging-only manifest, `production: null`, both payload digests, application metadata, source SHA, immutable images, migration, and CI evidence. It creates an exact three-file digest-addressed `release-inbox/`, separate install and activation approval drafts under `root-approvals/`, and a canonical human-readable `release-review.json` naming every value needed by the two later approval gates. It does not sign, publish, upload, install, approve, or activate the bundle.
