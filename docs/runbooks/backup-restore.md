# Backup and restore

## Backup boundary

Production recovery uses encrypted Restic storage outside Netcup. The VPS reads only `/etc/myapp/secrets/production/restic.env`; caller `RESTIC_*` variables are rejected. Its identity may create/read/list snapshots but cannot forget, prune, overwrite, unlock, reduce retention, or delete history. Netcup snapshots are supplemental and separately approved.

Database sets run every six hours; state sets run daily. Acquire `host-operation` then `backup`, hold the global lock only for the consistent capture, and release it before long upload. Write/checksum/fsync `.partial` components, rename atomically, publish the canonical recovery-set manifest, then publish the append-only completion marker last. Record release/manifest/epoch/sequence/checkpoint, PostgreSQL dump/globals/schema/time, media and Stalwart cutoffs, configuration/DNS inventory, key versions, tombstone high-water, and Restic object IDs.

Retention/prune is executed only by the separately held operator identity using `infra/operator/restic-retention.sh`; that script is not installed on the VPS.

## Restore test

1. Select one exact completed recovery set and verify every digest, signature, Restic object, capture time, RPO, checkpoint, and tombstone high-water.
2. Measure compressed and restored sizes plus tool/filesystem overhead. Refuse if projected use reaches 70%, could reach 80%, or leaves under 20% disk free. Use only an explicitly approved isolated external target if local capacity is insufficient.
3. Restore to unique non-public networks and paths with no production OAuth/webhook/SMTP/DNS/Internet credentials, no worker/scheduler egress, and no public Caddy route.
4. Validate PostgreSQL consistency/schema, media hashes, Stalwart state with delivery disabled, configuration/key versions, and application authorization using synthetic data.
5. Record duration and evidence, then remove only the exact disposable resources.

Reject partial/missing completion markers, mixed component times, checksum/schema/release drift, checkpoint gaps, tombstone gaps, or an out-of-RPO set.

