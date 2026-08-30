import type { QueryResultRow } from "pg";

import type { SqlExecutor } from "../transactions.js";

const sha256HexPattern = /^[0-9a-f]{64}$/u;

export type TombstoneScopeKind =
  "account" | "membership" | "organization" | "ownership" | "provider" | "user";

export interface PreparedTombstoneInput {
  accountId?: string;
  environment: "development" | "production" | "staging" | "test";
  eventId: string;
  membershipId?: string;
  operation: string;
  organizationId?: string;
  prepareSequence: number;
  preparedAt: Date;
  scopeDigest: string;
  scopeKind: TombstoneScopeKind;
  userId?: string;
}

export async function recordPreparedTombstone(
  executor: SqlExecutor,
  input: PreparedTombstoneInput,
): Promise<void> {
  if (!sha256HexPattern.test(input.scopeDigest)) {
    throw new TypeError("tombstone scope digest must be a lowercase SHA-256 hex digest");
  }
  if (!Number.isSafeInteger(input.prepareSequence) || input.prepareSequence < 1) {
    throw new TypeError("tombstone prepare sequence must be a positive integer");
  }

  await executor.query(
    `INSERT INTO app.security_tombstone_mutations (
       event_id,
       environment,
       operation,
       scope_kind,
       scope_digest,
       user_id,
       organization_id,
       membership_id,
       account_id,
       prepare_sequence,
       prepared_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      input.eventId,
      input.environment,
      input.operation,
      input.scopeKind,
      input.scopeDigest,
      input.userId ?? null,
      input.organizationId ?? null,
      input.membershipId ?? null,
      input.accountId ?? null,
      input.prepareSequence,
      input.preparedAt,
    ],
  );

  const existing = await executor.query(
    `SELECT event_id
       FROM app.security_tombstone_mutations
      WHERE event_id = $1
        AND environment = $2
        AND operation = $3
        AND scope_kind = $4
        AND scope_digest = $5
        AND user_id IS NOT DISTINCT FROM $6::text
        AND organization_id IS NOT DISTINCT FROM $7::text
        AND membership_id IS NOT DISTINCT FROM $8::text
        AND account_id IS NOT DISTINCT FROM $9::text
        AND prepare_sequence = $10
        AND prepared_at = $11`,
    [
      input.eventId,
      input.environment,
      input.operation,
      input.scopeKind,
      input.scopeDigest,
      input.userId ?? null,
      input.organizationId ?? null,
      input.membershipId ?? null,
      input.accountId ?? null,
      input.prepareSequence,
      input.preparedAt,
    ],
  );
  if (existing.rowCount !== 1) {
    throw new Error("tombstone event identity was reused with different preparation data");
  }
}

export interface PreparedTombstoneBinding {
  accountId?: string;
  eventId: string;
  membershipId?: string;
  organizationId?: string;
  scopeKind: TombstoneScopeKind;
  userId?: string;
}

/**
 * Binds one already-durable prepared capture to this database transaction.
 * The database triggers independently re-check this identity on the mutation.
 */
export async function bindPreparedTombstone(
  transaction: SqlExecutor,
  input: PreparedTombstoneBinding,
): Promise<void> {
  const prepared = await transaction.query(
    `SELECT event_id
       FROM app.security_tombstone_mutations
      WHERE event_id = $1
        AND status = 'prepared'
        AND scope_kind = $2
        AND ($3::text IS NULL OR user_id = $3)
        AND ($4::text IS NULL OR organization_id = $4)
        AND ($5::text IS NULL OR membership_id = $5)
        AND ($6::text IS NULL OR account_id = $6)
      FOR SHARE`,
    [
      input.eventId,
      input.scopeKind,
      input.userId ?? null,
      input.organizationId ?? null,
      input.membershipId ?? null,
      input.accountId ?? null,
    ],
  );
  if (prepared.rowCount !== 1) {
    throw new Error("prepared tombstone does not match the requested local mutation");
  }
  await transaction.query("SELECT set_config('esmii.tombstone_event_id', $1, true)", [
    input.eventId,
  ]);
}

/** Must be called inside the same transaction as the access-lowering mutation and audit insert. */
export async function markTombstoneLocalApplied(
  transaction: SqlExecutor,
  eventId: string,
): Promise<boolean> {
  const result = await transaction.query(
    `UPDATE app.security_tombstone_mutations
        SET status = 'local_applied',
            local_applied_at = statement_timestamp(),
            updated_at = statement_timestamp()
      WHERE event_id = $1 AND status = 'prepared'`,
    [eventId],
  );
  return result.rowCount === 1;
}

export async function markTombstoneCommitted(
  executor: SqlExecutor,
  input: { eventId: string; resolutionSequence: number; resolvedAt: Date },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.resolutionSequence) || input.resolutionSequence < 1) {
    throw new TypeError("tombstone resolution sequence must be a positive integer");
  }
  const result = await executor.query(
    `UPDATE app.security_tombstone_mutations
        SET status = 'committed',
            resolution_sequence = $2,
            resolved_at = $3,
            failure_code = NULL,
            updated_at = statement_timestamp()
      WHERE event_id = $1 AND status = 'local_applied'`,
    [input.eventId, input.resolutionSequence, input.resolvedAt],
  );
  if (result.rowCount === 1) return true;
  const existing = await executor.query<
    QueryResultRow & { resolution_sequence: string; resolved_at: Date; status: string }
  >(
    `SELECT status, resolution_sequence::text, resolved_at
       FROM app.security_tombstone_mutations
      WHERE event_id = $1`,
    [input.eventId],
  );
  const row = existing.rows[0];
  return (
    row?.status === "committed" &&
    row.resolution_sequence === String(input.resolutionSequence) &&
    row.resolved_at.getTime() === input.resolvedAt.getTime()
  );
}

export async function markTombstoneCancelled(
  executor: SqlExecutor,
  input: { eventId: string; failureCode: string; resolutionSequence: number; resolvedAt: Date },
): Promise<boolean> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(input.failureCode)) {
    throw new TypeError("tombstone failure code must be a bounded stable code");
  }
  if (!Number.isSafeInteger(input.resolutionSequence) || input.resolutionSequence < 1) {
    throw new TypeError("tombstone resolution sequence must be a positive integer");
  }
  const result = await executor.query(
    `UPDATE app.security_tombstone_mutations
        SET status = 'cancelled',
            resolution_sequence = $2,
            resolved_at = $3,
            failure_code = $4,
            updated_at = statement_timestamp()
      WHERE event_id = $1 AND status = 'prepared'`,
    [input.eventId, input.resolutionSequence, input.resolvedAt, input.failureCode],
  );
  if (result.rowCount === 1) return true;
  const existing = await executor.query<
    QueryResultRow & {
      failure_code: string;
      resolution_sequence: string;
      resolved_at: Date;
      status: string;
    }
  >(
    `SELECT status, resolution_sequence::text, resolved_at, failure_code
       FROM app.security_tombstone_mutations
      WHERE event_id = $1`,
    [input.eventId],
  );
  const row = existing.rows[0];
  return (
    row?.status === "cancelled" &&
    row.resolution_sequence === String(input.resolutionSequence) &&
    row.resolved_at.getTime() === input.resolvedAt.getTime() &&
    row.failure_code === input.failureCode
  );
}

interface TombstoneStateRow extends QueryResultRow {
  access_closed: boolean;
  closure_reason: string | null;
  contiguous_high_water: string;
  environment: string;
  epoch: string;
  version: number;
}

export interface TombstoneRecoveryState {
  accessClosed: boolean;
  closureReason: string | null;
  contiguousHighWater: string;
  environment: string;
  epoch: string;
  version: number;
}

export async function readTombstoneRecoveryState(
  executor: SqlExecutor,
): Promise<TombstoneRecoveryState | null> {
  const result = await executor.query<TombstoneStateRow>(
    `SELECT
       environment,
       epoch,
       contiguous_high_water::text,
       access_closed,
       closure_reason,
       version
     FROM app.security_tombstone_state
     WHERE singleton`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    accessClosed: row.access_closed,
    closureReason: row.closure_reason,
    contiguousHighWater: row.contiguous_high_water,
    environment: row.environment,
    epoch: row.epoch,
    version: row.version,
  };
}

/** Advances only one contiguous journal record; gaps fail closed instead of being skipped. */
export async function advanceTombstoneHighWater(
  transaction: SqlExecutor,
  input: { environment: string; epoch: string; expectedCurrent: number; next: number },
): Promise<boolean> {
  if (input.next !== input.expectedCurrent + 1) {
    throw new TypeError("tombstone high-water may advance only by one contiguous record");
  }
  const result = await transaction.query(
    `UPDATE app.security_tombstone_state
        SET contiguous_high_water = $4,
            version = version + 1,
            updated_at = statement_timestamp()
      WHERE singleton
        AND environment = $1
        AND epoch = $2
        AND contiguous_high_water = $3
        AND NOT access_closed`,
    [input.environment, input.epoch, input.expectedCurrent, input.next],
  );
  return result.rowCount === 1;
}

export async function closeTombstoneRecoveryAccess(
  executor: SqlExecutor,
  input: { environment: string; epoch: string; reason: string },
): Promise<boolean> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(input.reason)) {
    throw new TypeError("closure reason must be a bounded stable code");
  }
  const result = await executor.query(
    `UPDATE app.security_tombstone_state
        SET access_closed = true,
            closure_reason = $3,
            version = version + 1,
            updated_at = statement_timestamp()
      WHERE singleton AND environment = $1 AND epoch = $2`,
    [input.environment, input.epoch, input.reason],
  );
  return result.rowCount === 1;
}
