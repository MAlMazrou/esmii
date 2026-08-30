# Rollback and interrupted-operation recovery

## Automatic failure during activation

Keep the global lock for the complete transaction. Stop new app writes when necessary, retain the failed release and journal, restore the previously sealed manifest/app images, and run its compatible services. Verify health, tenant isolation, queue/outbox state, routes, and resource limits. Only a verified rollback may update the active pointer/checkpoint, archive the journal, and clear the recovery inhibit.

Never run `docker compose down` against an unverified caller file, force-move `main`, reverse a destructive database migration, reuse an old whole-host manifest, or clear the inhibit because the process died.

## Reboot with recovery inhibit

1. Keep reconciler and mutating timers stopped.
2. Acquire `host-operation`; if backup state is involved, then acquire `backup` second.
3. Inspect the root-owned journal, active pointer, sealed predecessor/target, Docker state, schema, and immutable off-VPS high-water checkpoint.
4. Decide verified forward completion or verified rollback. A restored local checkpoint never outranks the off-VPS record.
5. Complete health/isolation checks and write the next append-only outcome checkpoint.
6. Archive the journal and clear the inhibit with the fixed recovery command.
7. Re-enable only the timers authorized for the current prompt.

The first production rollback returns to restricted/no-production-app while keeping staging. From the second production release onward, retain the prior production digests. A later runtime rollback is recorded by a reviewed forward revert whose tree matches the restored release and is merged back into `dev` before another promotion.

