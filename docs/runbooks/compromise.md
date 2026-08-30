# Compromise response

1. Stop public ingress and automatic reconciliation; preserve SCP console/rescue access and evidence.
2. Revoke GitHub App/Deployment-status, GHCR pull, OAuth, DNS, alert, Restic, checkpoint, SSH, database/cache, Better Auth, action-link, Stalwart/DKIM/webhook, and tombstone credentials according to affected scope.
3. Preserve immutable off-VPS checkpoints, append-only tombstones, Restic history, Netcup audit records, release manifests, journals, and logs. Do not delete or prune evidence.
4. Rebuild from verified Ubuntu and reviewed infrastructure on a clean host. Do not trust restored local high-water or authorization state alone.
5. Establish a new approved deployment epoch/floor from the independent checkpoint identity, invalidate old requests, replay tombstones, revoke sessions/action links/invitations, and quarantine side effects.
6. Validate tenant isolation, authentication, queues, mail, media, backups, routes, and external scans before reopening.
7. Record the incident, affected scope, timeline, rotations, user/regulatory notifications, and forward Git reconciliation.

An ambiguous tombstone gap fails closed for the affected tenant or all tenants when scope cannot be proved.

