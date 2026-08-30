# Disk pressure

Alert at 60%, act at 70%, treat 80% as critical, and preserve at least 20% free.

1. At 60%, identify growth by filesystem, Docker local logs/images/build cache, PostgreSQL/WAL, media, Stalwart, backup workspace, inode usage, and sealed releases. Do not delete yet.
2. At 70%, pause uploads/large jobs if present, defer restore tests, alert externally, and plan capacity or bounded cleanup.
3. At 80% or inode exhaustion, close writes as needed, stop nonessential jobs, protect PostgreSQL and mail integrity, and escalate to resize/migration.
4. Run only the locked host-prune wrapper. It protects active/previous image digests and may prune Docker build cache, unused host images, and bounded logs. It never runs Restic forget/prune/delete or removes database/media/mail/release state.
5. Re-measure, verify service health and rollback inventory, and record what changed.

Never treat the 62 GB planning reserve or swap as disposable application space.

