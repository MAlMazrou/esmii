import type { QueryResultRow } from "pg";

import type { SqlExecutor } from "../transactions.js";
import type { AuditEventInput } from "./audit.js";
import { insertAuditEvent } from "./audit.js";
import {
  bindPreparedTombstone,
  markTombstoneLocalApplied,
  type TombstoneScopeKind,
} from "./tombstones.js";

interface LinkedAccountRow extends QueryResultRow {
  created_at: Date;
  id: string;
  provider_id: string;
  updated_at: Date;
}

export interface LinkedAccountProvider {
  accountRecordId: string;
  createdAt: Date;
  providerId: string;
  updatedAt: Date;
}

export async function listLinkedAccountProviders(
  executor: SqlExecutor,
  input: { sessionId: string; userId: string },
): Promise<LinkedAccountProvider[]> {
  const result = await executor.query<LinkedAccountRow>(
    `SELECT linked_account.id,
            linked_account."providerId" AS provider_id,
            linked_account."createdAt" AS created_at,
            linked_account."updatedAt" AS updated_at
       FROM app.account AS linked_account
      WHERE linked_account."userId" = $1
        AND EXISTS (
          SELECT 1
            FROM app."session" AS current_session
           WHERE current_session.id = $2
             AND current_session."userId" = linked_account."userId"
             AND current_session."expiresAt" > statement_timestamp()
        )
      ORDER BY linked_account."createdAt", linked_account.id`,
    [input.userId, input.sessionId],
  );
  return result.rows.map((row) => ({
    accountRecordId: row.id,
    createdAt: row.created_at,
    providerId: row.provider_id,
    updatedAt: row.updated_at,
  }));
}

export async function applyUserStatusReduction(
  transaction: SqlExecutor,
  input: {
    audit: AuditEventInput;
    targetStatus: "deleted" | "disabled";
    tombstoneEventId: string;
    tombstoneScopeKind: Extract<TombstoneScopeKind, "account" | "user">;
    userId: string;
  },
): Promise<boolean> {
  if (input.audit.eventId !== input.tombstoneEventId) {
    throw new TypeError("user-status audit and tombstone event identities must match");
  }
  const current = await transaction.query<QueryResultRow & { status: string }>(
    `SELECT status FROM app."user" WHERE id = $1 FOR UPDATE`,
    [input.userId],
  );
  const user = current.rows[0];
  if (user === undefined || user.status !== "active") return false;

  await bindPreparedTombstone(transaction, {
    eventId: input.tombstoneEventId,
    scopeKind: input.tombstoneScopeKind,
    userId: input.userId,
  });
  await transaction.query('DELETE FROM app."session" WHERE "userId" = $1', [input.userId]);
  const changed = await transaction.query(
    `UPDATE app."user"
        SET status = $2,
            "statusChangedAt" = statement_timestamp(),
            "authorizationVersion" = "authorizationVersion" + 1,
            "updatedAt" = statement_timestamp()
      WHERE id = $1 AND status = 'active'`,
    [input.userId, input.targetStatus],
  );
  if (changed.rowCount !== 1) return false;
  if (!(await markTombstoneLocalApplied(transaction, input.tombstoneEventId))) {
    throw new Error("prepared tombstone is unavailable for user status reduction");
  }
  await insertAuditEvent(transaction, {
    ...input.audit,
    action: input.targetStatus === "deleted" ? "identity.deleted" : "identity.disabled",
    organizationId: null,
    targetId: input.userId,
    targetType: "user",
  });
  return true;
}

/**
 * Transaction primitive for a server capture-adapter flow. The caller must
 * durably prepare first, then commit/cancel the journal after this transaction.
 */
export async function unlinkLinkedAccountWithTombstone(
  transaction: SqlExecutor,
  input: {
    accountRecordId: string;
    audit: AuditEventInput;
    currentSessionId: string;
    magicLinkRemainsUsable: boolean;
    providerId: string;
    recentAfter: Date;
    tombstoneEventId: string;
    tombstoneScopeKind: Extract<TombstoneScopeKind, "account" | "provider">;
    usableProviderIds: readonly string[];
    userId: string;
  },
): Promise<boolean> {
  if (input.audit.eventId !== input.tombstoneEventId) {
    throw new TypeError("provider-unlink audit and tombstone event identities must match");
  }
  const currentIdentity = await transaction.query<
    QueryResultRow & { email_verified: boolean; status: string }
  >(
    `SELECT "emailVerified" AS email_verified, status
       FROM app."user"
      WHERE id = $1
      FOR UPDATE`,
    [input.userId],
  );
  const user = currentIdentity.rows[0];
  if (user === undefined || user.status !== "active") return false;

  const recentSession = await transaction.query(
    `SELECT id
       FROM app."session"
      WHERE id = $1
        AND "userId" = $2
        AND "expiresAt" > statement_timestamp()
        AND "createdAt" >= $3
      FOR UPDATE`,
    [input.currentSessionId, input.userId, input.recentAfter],
  );
  if (recentSession.rowCount !== 1) throw new Error("recent authentication is required");

  const linked = await transaction.query<LinkedAccountRow>(
    `SELECT id, "providerId" AS provider_id, "createdAt" AS created_at, "updatedAt" AS updated_at
       FROM app.account
      WHERE "userId" = $1
      FOR UPDATE`,
    [input.userId],
  );
  const target = linked.rows.find(
    (row) => row.id === input.accountRecordId && row.provider_id === input.providerId,
  );
  if (target === undefined) return false;

  const configuredProviders = new Set(input.usableProviderIds);
  const anotherProviderRemains = linked.rows.some(
    (row) => row.id !== target.id && configuredProviders.has(row.provider_id),
  );
  const magicLinkRemains = input.magicLinkRemainsUsable && user.email_verified;
  if (!anotherProviderRemains && !magicLinkRemains) {
    throw new Error("the final usable login method cannot be unlinked");
  }

  await bindPreparedTombstone(transaction, {
    accountId: target.id,
    eventId: input.tombstoneEventId,
    scopeKind: input.tombstoneScopeKind,
    userId: input.userId,
  });
  const deleted = await transaction.query(
    `DELETE FROM app.account
      WHERE id = $1 AND "userId" = $2 AND "providerId" = $3`,
    [target.id, input.userId, input.providerId],
  );
  if (deleted.rowCount !== 1) return false;
  await transaction.query(`DELETE FROM app."session" WHERE "userId" = $1 AND id <> $2`, [
    input.userId,
    input.currentSessionId,
  ]);
  await transaction.query(
    `UPDATE app."user"
        SET "authorizationVersion" = "authorizationVersion" + 1,
            "updatedAt" = statement_timestamp()
      WHERE id = $1`,
    [input.userId],
  );
  if (!(await markTombstoneLocalApplied(transaction, input.tombstoneEventId))) {
    throw new Error("prepared tombstone is unavailable for provider unlink");
  }
  await insertAuditEvent(transaction, {
    ...input.audit,
    action: "identity.provider_unlinked",
    actorUserId: input.userId,
    organizationId: null,
    targetId: target.id,
    targetType: "account",
  });
  return true;
}
