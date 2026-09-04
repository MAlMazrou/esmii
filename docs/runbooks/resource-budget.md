# Combined 8 GiB / 256 GB resource budget

This is the canonical starting budget for the existing dual-environment application plus the exact Prompt 07 monitoring profile. It is a set of ceilings and growth allowances, not reserved memory or disk and not permission to activate a service. Monitoring repository code/CI is approved; every live host, secret, Worker/DNS/TLS, soak, production, and off-host-monitor gate in `docs/prompts/07-build-monitoring-dashboard.md` still applies.

## Memory ceilings

Existing steady-state service ceilings total 4,000 MiB:

| Service group | Ceiling |
|---|---:|
| shared Caddy | 96 MiB |
| staging PostgreSQL / Valkey / web / API / worker / Mailpit | 384 / 128 / 256 / 256 / 192 / 128 MiB |
| production PostgreSQL / Valkey / web / API / worker / Stalwart | 768 / 256 / 384 / 384 / 256 / 512 MiB |

Prompt 07 adds exactly 1,088 MiB:

| Monitoring component | Ceiling |
|---|---:|
| staging dashboard | 192 MiB |
| production dashboard | 192 MiB |
| staging Prometheus | 256 MiB |
| production Prometheus | 256 MiB |
| shared node_exporter plus private systemd socket proxies | 64 MiB aggregate slice |
| root metrics collector | 64 MiB transient `MemoryMax` |
| root log collector | 64 MiB transient `MemoryMax` |
| **Prompt 07 total** | **1,088 MiB** |

The collectors are scheduled not to overlap. The steady-state ceiling is therefore 5,088 MiB. Only one environment migration runs at a time at 192 MiB, so the bounded activation peak is 5,280 MiB. This leaves 2,912 MiB on an 8 GiB host for Ubuntu, Docker, kernel, page cache, backup/restore, bounded media work, and safety headroom.

Worker concurrency starts at one. PostgreSQL and Valkey internal settings must fit their container ceilings; a cgroup limit alone does not make their memory use safe.

## Retention and disk allowances

- Each Prometheus keeps no more than seven days or 1 GB of samples, whichever limit is reached first, inside a 1.25 GB disk allowance. The combined TSDB allowance is 2.5 GB.
- Each environment's sanitized warning/error snapshot keeps no more than 24 hours, 10,000 events, or 20 MiB, whichever limit is reached first. Every post-redaction message is truncated to 4 KiB.
- Source Docker logs retain the existing 10 MiB × 3 rotation per container. Dashboard snapshots are diagnostic views, not archives or backup inputs.
- SQLite auth/audit state and collector cursor files remain bounded, environment-local, root-owned operational state. Alert before any allowance is exhausted; do not silently take space from database, media, mail, backup, or emergency budgets.

Disk planning allowances total 256 GB:

| Use | Initial allowance |
|---|---:|
| OS, packages, bounded source logs, Docker images/releases | 40 GB |
| production PostgreSQL | 50 GB |
| staging PostgreSQL and test state | 12 GB |
| production media originals/variants | 55 GB |
| staging media | 10 GB |
| Stalwart config/queues/operational mail | 12 GB |
| both Prometheus TSDB allowances plus monitoring snapshots/state/headroom | 5 GB |
| bounded local backup/restore workspace | 15 GB |
| emergency/growth reserve | 57 GB |

These are monitored budgets, not partitions. Keep at least 20% of the filesystem free.

## Staging soak gate

Production monitoring remains disabled until staging monitoring runs continuously for at least 24 hours under representative combined application and mail load. Record at minimum:

- cgroup current/peak memory for both staging monitoring containers, shared exporter/proxies, and both collectors;
- host available RAM, page-cache pressure, swap use, OOM events, load/CPU, disk/inode use, and I/O latency;
- customer web/API/worker/database/mail latency, error, restart, and queue behavior before versus during the soak;
- Prometheus TSDB size/retention behavior, snapshot age/count/bytes, collector duration/overlap, and stale/degraded signals; and
- cross-environment isolation, password/email-OTP authentication and delivery, redaction sentinels, and private-port checks.

Acceptance requires no sustained RAM above 70%, sustained normal-load swap, OOM, repeated restart, disk/inode threshold breach, collector overlap, unbounded growth, secret leakage, cross-environment access, or unacceptable customer-application latency. Sustained 75% RAM or any OOM is an immediate capacity incident, not a soak success.

## Rollback trigger and order

Rollback the newly activated monitoring environment if it causes an OOM/restart loop, sustained swap/RAM pressure, retention or snapshot growth beyond its limits, repeated stale collection, secret/redaction failure, isolation/auth failure, customer-application regression, or TLS/routing failure.

1. Restore only that hostname's captured preceding Cloudflare Worker/DNS/Caddy route so monitoring data fails closed.
2. Stop only that environment's dashboard and Prometheus; do not touch customer web/API/worker/database/media/mail services.
3. Disable shared exporter/collector units only when no accepted monitoring environment still depends on them.
4. Restore the preceding monitoring Compose/state pointer and preserve bounded sanitized incident evidence.
5. Re-measure the host/customer baseline and document the exact trigger. Repair forward through a new reviewed candidate; never expose `3000`, `9090`, `9100`, Docker, journal, or raw snapshots as a workaround.

Do not add cAdvisor, Grafana, Loki, Alertmanager, extra exporters, tracing, SeaweedFS, ClamAV, replicas, public mailbox mode, marketing/bulk mail, video transcoding, or another deferred service within this budget. Off-host outage monitoring has its own budget and approval because same-VPS components cannot observe complete host/provider/DNS loss.
