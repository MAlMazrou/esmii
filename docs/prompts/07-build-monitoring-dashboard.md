# Prompt 07 — Build the isolated monitoring dashboard

## Objective

Build and locally validate Esmii's custom infrastructure-monitoring application and its least-privilege metrics/log collection path. The dashboard is the operator interface; Prometheus and the exporters are private data-plane components, not public user interfaces.

The same immutable dashboard image is instantiated separately at:

- `staging-dashboard.esmii.app`, fixed to staging data; and
- `dashboard.esmii.app`, fixed to production data.

Staging and production run separate Prometheus and dashboard instances, credentials, sessions, SQLite operator-auth/audit databases, metric labels, log snapshots, Docker networks, and persistent data. They share only the physical VPS, one host `node_exporter`, the root-owned fixed collectors, Caddy, and the immutable dashboard image bytes. The browser cannot select an environment through a query/body value; a visual switch is only a normal link to the other independently authenticated hostname.

This prompt is multi-gated. Repository implementation and local validation do not authorize a VPS login/apply, secret creation or installation, Cloudflare mutation, certificate request, staging activation, production activation, or external-monitor configuration.

## Approved architecture

- One standalone `@esmii/dashboard` Next.js application in `apps/dashboard`, built as `esmii/dashboard:prompt07` locally and published as `ghcr.io/malmazrou/esmii-dashboard` by the existing versioned CI flow.
- One environment-neutral dashboard image built once per Git revision with the same application version and OCI source/revision/version labels as the web/server images.
- Two Prometheus instances with seven-day/1 GB-per-instance retention ceilings inside 1.25 GB disk allowances; each accepts scrapes and API queries only on its environment's private monitoring-data network.
- No OpenTelemetry Collector/SDK in this release; Prometheus OTLP ingestion, remote-write ingestion, admin, and lifecycle APIs remain disabled. The future application-monitoring contract stays ready for separately approved instrumentation.
- One host `node_exporter`, bound to `127.0.0.1:9100` behind systemd socket proxies that listen only on the two approved monitoring-data bridge gateway addresses. It is never bound to `0.0.0.0`, a public address, or a published Docker port.
- No cAdvisor. A fixed root-owned metrics collector reads only the allowlisted Docker/systemd facts needed for service state, health, start time, restart count, deployment state, and jobs, then atomically writes numeric Prometheus textfiles. It accepts no browser/dashboard parameters and exposes no socket.
- A separate fixed root-owned log collector reads only allowlisted services, parses known formats, drops fields not on the safe schema, redacts before persistence, and atomically writes one environment-specific warning/error snapshot. The dashboard never receives the Docker socket and never shells out.
- The production and staging dashboard instances call only their own Prometheus `/api/v1/query` and `/api/v1/query_range` endpoints through server-owned fixed query templates. No raw PromQL endpoint or arbitrary query string is exposed to the browser.
- One dedicated Better Auth operator realm per hostname using supported password hashing plus email OTP. These realms are not customer accounts and have no organization membership, application session, signup, reset, magic-link, social-login, customer database, or customer API access.
- Separate root-only password/email-OTP-sender/session secrets, host-only cookies, operator records, SQLite auth/audit databases, and revocation state for staging and production. A successful password check alone exposes no monitoring data; a single-use email OTP is required for every new session.
- Each dashboard uses one dedicated environment-specific Stalwart submission identity through only its matching internal `mail-submit` network. The recipient is taken from the password-authenticated session, STARTTLS certificate verification is mandatory, and staging/production never share SMTP credentials.
- Eight-hour maximum operator sessions, five-minute six-digit OTPs, Secure/HttpOnly host-only cookies, `SameSite=Strict`, exact-origin/CSRF enforcement, generic failures, bounded login/OTP-send/OTP-verification rate limits, audit of success/failure/logout/revocation, and no secret or OTP value in logs.
- Better Auth operations live only under `/api/operator-auth/*`; provisioning, email retargeting, recovery, password reset, and revocation use root-only local CLI flows with protected-file or TTY input, never secret-bearing command-line arguments.
- Caddy remains the only public HTTP entry point and, after each hostname's separate gate, obtains and auto-renews that hostname's Let's Encrypt certificate while redirecting HTTP to HTTPS. Dashboard port `3000`, Prometheus `9090`, node_exporter `9100`, collector outputs, and SQLite files remain private.

## Network and resource contract

Use these collision-reviewed monitoring networks:

| Environment | Edge network | Data network | Host/node target |
|---|---|---|---|
| staging | `172.30.40.0/29` | `172.30.40.8/29` | `172.30.40.9:9100` |
| production | `172.30.41.0/29` | `172.30.41.8/29` | `172.30.41.9:9100` |

Caddy joins each monitoring edge only. Each dashboard joins its own edge and data networks. Each Prometheus instance joins only its own internal data network. The two Prometheus instances never join one another's network. The dashboard has no application data/storage/mail network and no Docker socket.

Root-only monitoring secret/config files live under `/etc/esmii/monitoring/{staging,production}/` at mode `0600`. Operational state lives under `/var/lib/esmii/monitoring/`: shared collector cursors/textfiles under `shared/{state,textfiles}` and separate environment `auth`, `prometheus`, and `logs` directories under `{staging,production}/`. No environment may mount the other's subtree, and none of these files is committed or copied into an image.

The new memory ceilings total exactly 1,088 MiB:

| Component | Ceiling |
|---|---:|
| staging dashboard | 192 MiB |
| production dashboard | 192 MiB |
| staging Prometheus | 256 MiB |
| production Prometheus | 256 MiB |
| shared host node_exporter plus private socket proxies | 64 MiB aggregate |
| root metrics collector, transient `MemoryMax` | 64 MiB |
| root log collector, transient `MemoryMax` | 64 MiB |

The collectors do not run concurrently with one another. The combined existing-service plus monitoring ceiling is 5,088 MiB, or 5,280 MiB during one 192 MiB migration. Staging must complete a continuous 24-hour soak with representative combined application/mail load and no sustained RAM above 70%, sustained swap, OOM, repeated restart, disk/inode threshold breach, or unacceptable application latency before production monitoring can be proposed.

## Dashboard behavior

After password and email-OTP authentication, the fixed-environment application provides:

- `/overview` — CPU, RAM, disk, disk I/O, network, uptime, load, data freshness, and environment identity;
- `/services` — allowlisted service state, health, CPU/memory, current and rolling restart count, and last start/restart time;
- `/jobs` — staging/production pull state, health/maintenance/backup timer state when enabled, last outcome, and staleness without exposing commands or secrets;
- `/logs` — recent sanitized warnings/errors with service, severity, timestamp, safe message, and request/correlation ID when present;
- `/application` — visibly separate request-count, error-rate, and latency placeholder cards that say instrumentation is not yet connected and can later consume stable query descriptors without restructuring navigation/layout;
- typed server APIs under `/api/monitoring/{overview,series,services,jobs,logs,application}`; and
- public `/healthz`, limited to dashboard process liveness/readiness and containing no infrastructure detail.

The login page, the minimum `/api/operator-auth/*` password/email-OTP exchange, static assets required to render that flow, and `/healthz` are the only unauthenticated surfaces; none reveals metrics, service names/state, logs, Prometheus result, operator existence, or secret-bearing configuration. Monitoring HTML, RSC/prefetch responses, typed APIs, and caches must all enforce the operator session plus completed email-OTP boundary.

Use these visual-spec references as presentation targets, not as sources of production data, credentials, dates, addresses, or security policy:

- [`../design/monitoring-dashboard/desktop-production.png`](../design/monitoring-dashboard/desktop-production.png)
- [`../design/monitoring-dashboard/mobile-staging.png`](../design/monitoring-dashboard/mobile-staging.png)
- [`../design/monitoring-dashboard/operator-auth.png`](../design/monitoring-dashboard/operator-auth.png)

Canonical requirements in this prompt and `docs/requirements.md` override any illustrative sample copy in an image.

## Log and data safety

- Prometheus keeps at most seven days or 1 GB per environment, whichever is reached first, within a 1.25 GB per-environment disk allowance. It stores infrastructure metrics only and never labels metrics with email, URL/query, cookie, authorization data, message body, database value, token, full command line, or unbounded user-controlled text.
- The log collector reads only warning/error records from explicitly allowlisted containers/units. It allowlists `timestamp`, normalized `service`, `severity`, sanitized bounded `message`, safe event name, and request/correlation ID; every other field is discarded.
- Auth/action/invitation URLs, query strings, headers, cookies, IP addresses, emails, bodies, SQL values, SMTP content, OAuth material, OTP/TOTP values, stack traces, environment variables, and secrets never enter dashboard snapshots.
- Each environment snapshot is an atomic bounded replacement containing no more than the most recent 24 hours, 10,000 records, or 20 MiB, whichever limit is reached first; every message is truncated to 4 KiB after redaction. It is not a log archive. Docker's existing 10 MiB × 3 local-log bounds remain authoritative for source retention.
- The dashboard treats collected text as untrusted plain text, never renders HTML from logs, and never offers arbitrary grep, path, command, unit, container, or PromQL input.
- Prometheus, collector output, SQLite auth/audit state, and dashboard caches are separate per environment and root-owned outside Git. They are operational state, not application backup authority.

## Repository implementation deliverables

- Standalone custom dashboard UI and typed server-side data adapters; no Grafana/Prometheus skin or embedded raw Prometheus UI.
- Dedicated operator authentication, email OTP, session, audit, provisioning/retargeting/revocation tooling, negative authorization tests, and separate-environment fixtures.
- Fixed, allowlisted PromQL descriptors and strict validation of Prometheus response shapes, time ranges, result limits, timeouts, and safe error states.
- Prometheus scrape/rule configurations, root collector scripts/units, node_exporter configuration, environment-specific Compose/Caddy fragments, isolated networks, volumes, caps, health checks, and no-public-port policy.
- A single immutable dashboard image in CI with the same version/source/revision labels, vulnerability scan, SBOM, full-SHA publication, and `:dev`/`:main` convenience pointers as the existing application images.
- Rendered configuration, firewall, network-isolation, auth, redaction, resource-policy, rollback, desktop/mobile, and accessibility tests.
- A dedicated deterministic closed-inventory monitoring host payload containing only the approved host code/configuration and active pull-wrapper integration, bound to the full source SHA. Its independently hash-approved detached tiny bootstrap and fixed verifier live outside the candidate tree; the bootstrap, archive verifier/materializer, installers, and runtime helper must reject checkout paths, payload/bootstrap/verifier tampering, candidate self-verification, manifest-only activation, and digest/revision drift before host mutation.
- Documentation and runbook updates, including the exact 1,088 MiB budget and external gates.

## Repository verification

Run the applicable root checks plus focused dashboard/monitoring checks. At minimum:

```bash
corepack pnpm --filter @esmii/dashboard lint
corepack pnpm --filter @esmii/dashboard typecheck
corepack pnpm --filter @esmii/dashboard test
corepack pnpm --filter @esmii/dashboard build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:policy
corepack pnpm test:infra
corepack pnpm monitoring:verify-host-payload -- --revision <FULL_GIT_SHA>
corepack pnpm scan:secrets
corepack pnpm build
```

Also render and validate staging-only and full monitoring compositions, validate Caddy, inspect the dashboard image user/labels/health endpoint, scan it, generate its SBOM, and prove:

- unauthenticated/password-only/cross-host/stale/revoked sessions cannot retrieve any monitoring response;
- staging credentials and cookies fail on production and vice versa;
- a browser cannot change the configured environment or submit arbitrary PromQL;
- neither dashboard nor Caddy can reach the other Prometheus/data network;
- no monitoring port is host/publicly published and the dashboard has no Docker socket;
- hostile metric/log strings are bounded, redacted, escaped, and cannot inject HTML, labels, queries, file paths, or commands;
- future application-monitoring cards render as an explicit empty state without fabricated data; and
- both visual layouts remain unmistakably environment-labelled at representative desktop/mobile widths.

## External gates retained

Repository completion stops before all of these actions:

1. **Fresh read-only audit approval:** inspect current Cloudflare custom-domain/DNS state and live VPS services, listeners, routes, packages, timers, capacity, Docker networks, restart history, certificate state, and monitoring conflicts.
2. **Staging host-change approval:** install the reviewed node_exporter/collector units, root-owned files/secrets, staging Prometheus/dashboard composition, and Caddy fragment without changing DNS.
3. **Private staging verification:** use the VPN/loopback path to prove targets, queries, password/email-OTP delivery, redaction, isolation, rollback, and resource limits before public DNS.
4. **Cloudflare staging-hostname approval:** record the existing `staging-dashboard.esmii.app` Worker custom-domain binding, detach only that binding, create DNS-only VPS A/AAAA records, obtain/verify Caddy's Let's Encrypt certificate and automatic renewal, and retain exact Worker restoration data.
5. **24-hour staging-soak acceptance:** review resource and application evidence. Failure rolls back monitoring without changing the application runtime.
6. **Production host-change and secret approval:** create a completely separate production operator realm, secrets, SQLite state, Prometheus/dashboard instance, network, Caddy fragment, and rollback point using the already verified image digest.
7. **Cloudflare production-hostname approval:** confirm `dashboard.esmii.app` is unoccupied, then create DNS-only A/AAAA records and verify Caddy's Let's Encrypt certificate/renewal, HTTPS redirect, auth, and no-public-metrics exposure.
8. **Separate off-host outage-monitor gate:** an on-VPS Prometheus/dashboard cannot report loss of the VPS, provider, network, power, or authoritative DNS. `DEC-INPUT-009` remains unresolved until a distinct external probe and alert route are approved and tested.

No gate authorizes provider firewall changes, new public ports, production Google OAuth, backup acceptance, customer-auth changes, or a general platform-admin role.

## Rollback contract

- Preserve the prior Caddy fragments, Compose overlays, unit enablement, and Cloudflare Worker/DNS records before each external change.
- A staging failure removes only the staging dashboard/Prometheus, disables collectors/node_exporter only if no accepted environment uses them, restores the prior Caddy fragment and Worker custom-domain binding, and leaves staging/production application services, data, mail, and timers unchanged.
- A production failure removes only the production dashboard/Prometheus/Caddy/DNS state and restores the prior production monitoring state; staging monitoring and both application environments remain unchanged.
- Never roll back by deleting application databases, media, mail, Docker volumes, or customer auth. Monitoring SQLite/Prometheus data may be quarantined for diagnosis, then removed only under an explicit bounded target.
- If Caddy validation, auth-before-data, network isolation, external port scanning, or resource thresholds fail, do not publish/retain the hostname.

## Completion report

Report:

1. outcome and exact Prompt 07 phase completed;
2. files and behavior changed;
3. checks run and their results;
4. dashboard image identity and CI evidence, if published under a separately authorized branch action;
5. authentication, isolation, log-safety, and resource evidence;
6. explicit external actions performed or `none`;
7. every retained external gate and rollback point; and
8. the smallest next approval required.
