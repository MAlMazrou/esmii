import type { AppEnvironment } from "@esmii/config";
import { readTombstoneRecoveryState, type DatabaseClient } from "@esmii/database";

import { CapturedTombstoneJournal } from "../security/tombstones.js";
import { PostgresSecurityTombstoneOrchestrator } from "./tombstone-orchestrator.js";

/**
 * Development, test, and staging use the isolated database-backed capture adapter.
 * Production remains fail-closed unless the explicit initial-public-shell exception is active.
 */
export async function createRuntimeTombstoneOrchestrator(input: {
  allowProductionCapture?: boolean;
  database: DatabaseClient;
  environment: AppEnvironment;
  mode: "capture" | "external";
}): Promise<PostgresSecurityTombstoneOrchestrator> {
  if (
    input.mode !== "capture" ||
    (input.environment === "production" && input.allowProductionCapture !== true)
  ) {
    throw new Error("external tombstone capture must be provisioned before this runtime can start");
  }
  const state = await readTombstoneRecoveryState(input.database.pool);
  if (
    state === null ||
    state.accessClosed ||
    state.environment !== input.environment ||
    !/^\d+$/u.test(state.contiguousHighWater)
  ) {
    throw new Error("local tombstone recovery state is missing, mismatched, or fail-closed");
  }
  const unresolved = await input.database.pool.query<{ count: string; maximum: string }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('prepared', 'local_applied'))::text AS count,
       GREATEST(
         COALESCE(max(prepare_sequence), 0),
         COALESCE(max(resolution_sequence), 0)
       )::text AS maximum
     FROM app.security_tombstone_mutations
     WHERE environment = $1`,
    [input.environment],
  );
  const row = unresolved.rows[0];
  const highWater = Number(state.contiguousHighWater);
  if (
    row === undefined ||
    row.count !== "0" ||
    row.maximum !== state.contiguousHighWater ||
    !Number.isSafeInteger(highWater)
  ) {
    throw new Error("local tombstone journal requires fail-closed recovery");
  }
  return new PostgresSecurityTombstoneOrchestrator({
    environment: input.environment,
    journal: new CapturedTombstoneJournal([], highWater),
    pool: input.database.pool,
  });
}
