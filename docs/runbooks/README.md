# Infrastructure and operations runbooks

These runbooks describe separately gated host work. Repository definitions do not themselves authorize a Netcup, Cloudflare, GitHub, GHCR, offsite-backup, or VPS action. Prompt 07 adds monitoring repository guidance while keeping its live audit/apply, secrets, Worker/DNS/TLS, staging soak, production activation, and off-host outage-monitor changes as external gates.

- [Ubuntu custom ISO](ubuntu-custom-iso.md)
- [Prompt 05 remote check plan](prompt-05-remote-check-plan.md)
- [Generated input checklist](generated-input-checklist.md)
- [Deployment and migration](deployment.md)
- [Automatic dev-to-staging pull](staging-pull.md)
- [Rollback and interrupted-operation recovery](rollback.md)
- [Backup and restore](backup-restore.md)
- [Mail and DNS gate](mail-dns.md)
- [Compromise](compromise.md)
- [Disk pressure](disk-pressure.md)
- [OOM and memory pressure](oom.md)
- [Reconciler failure](reconciler-failure.md)
- [Combined application and Prompt 07 monitoring resource budget](resource-budget.md)
- [Custom monitoring dashboard rollout and rollback](monitoring-dashboard.md)

The canonical architecture and gate rules remain in `docs/infrastructure.md`, `docs/vps-setup.md`, and `docs/deployment.md`.
