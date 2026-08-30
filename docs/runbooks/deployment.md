# Deployment and migration

## Accepted release set

The outbound unprivileged reconciler may download but never execute a canonical signed activation manifest, its digest-addressed immutable shared/application payloads, signature/provenance envelopes, and images. The root staging-policy controller independently verifies the immutable policy, signature, provenance, protected `dev` source, staging environment, epoch/sequence, predecessor, fixed overlay set, production preservation, and digest-only images. It cannot authorize production or a shared/policy change.

The root installer accepts only the fixed inbox, exact referenced set, safe regular-file archives, canonical inventories, a root-only approval record, and same-environment allowlisted render tokens. It renders under the sealed release, verifies canonical Compose/config digests, sets root-owned non-writable modes, and never consumes secrets or caller Compose/Docker variables.

## Activation transaction

`esmii-activate-release` acquires `/run/lock/esmii/host-operation.lock`, re-reads the active predecessor and approval while locked, and refuses an existing persistent recovery inhibit. One journaled transaction covers:

1. pull immutable images;
2. start isolated state;
3. run the one-shot migration as the migration role;
4. switch API/worker/web and the selected Caddy fragment;
5. run health, route, tenant/isolation, resource, proxy-spoof, secret/mount, and rollback-target checks;
6. atomically commit the active pointer;
7. conditionally create and read back the immutable off-VPS checkpoint;
8. archive the journal and clear the inhibit only after verified commit.

Staging starts as base+staging with production null. Production promotion retains staging and reuses its exact application/image bytes. A later automatic staging record preserves the complete production block and shared payload. Public-edge and production-mail are separate next-sequence transitions.

## Migration rules

- Migrations run once through `*-migrate`, never on API startup.
- The migration role owns DDL and pg-boss schema changes; API and worker roles remain restricted.
- Verify empty-schema migration and the previous supported schema before release.
- Prefer backward-compatible expand/migrate/contract changes. Do not reverse destructive schema changes during rollback.
- A failed migration leaves the journal/inhibit active and the prior application release authoritative until verified recovery.

No GitHub-hosted runner receives SSH, Docker, repository-write, package-write, or arbitrary root execution access.

