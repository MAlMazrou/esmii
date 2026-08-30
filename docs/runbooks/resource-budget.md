# Combined 8 GB / 256 GB resource budget

Steady-state container ceilings total 4,000 MiB (about 3.9 GiB):

| Service group | Ceiling |
|---|---:|
| shared Caddy | 96 MiB |
| staging PostgreSQL / Valkey / web / API / worker / Mailpit | 384 / 128 / 256 / 256 / 192 / 128 MiB |
| production PostgreSQL / Valkey / web / API / worker / Stalwart | 768 / 256 / 384 / 384 / 256 / 512 MiB |

Only one environment migration runs at a time, with a 192 MiB cap, so the bounded activation peak is 4,192 MiB. This still leaves 4,000 MiB on an 8 GiB host for Ubuntu, Docker, kernel, page cache, backup/restore, bounded media work, and safety headroom. Limits are ceilings, not reservations. Worker concurrency starts at one; databases and Valkey must be configured within their caps.

Disk planning allowances total 256 GB: 40 GB OS/packages/logs/images/releases; 50 GB production PostgreSQL; 12 GB staging PostgreSQL/state; 55 GB production media; 10 GB staging media; 12 GB Stalwart; 15 GB bounded backup/restore workspace; 62 GB emergency/growth reserve. They are monitored budgets, not partitions.

Do not enable SeaweedFS, ClamAV, Prometheus/Grafana/Loki, replicas, public mailbox mode, marketing/bulk mail, video transcoding, or other deferred services. Resize/optimize on sustained thresholds in `docs/infrastructure.md`, any OOM, normal-load swap, persistent queue/database latency, or less than 20% disk headroom.
