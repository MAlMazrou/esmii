import type { QueryResultRow } from "pg";

import type { SqlExecutor } from "../transactions.js";
import { lockOrganization } from "../transactions.js";

interface SafeSessionRow extends QueryResultRow {
  active_organization_id: string | null;
  created_at: Date;
  expires_at: Date;
  id: string;
  ip_address: string | null;
  updated_at: Date;
  user_agent: string | null;
}

export interface SafeSession {
  activeOrganizationId: string | null;
  createdAt: Date;
  expiresAt: Date;
  id: string;
  ipAddress: string | null;
  updatedAt: Date;
  userAgent: string | null;
}

export async function listSafeSessions(
  executor: SqlExecutor,
  userId: string,
): Promise<SafeSession[]> {
  const result = await executor.query<SafeSessionRow>(
    `SELECT
       id,
       "expiresAt" AS expires_at,
       "createdAt" AS created_at,
       "updatedAt" AS updated_at,
       "ipAddress" AS ip_address,
       "userAgent" AS user_agent,
       "activeOrganizationId" AS active_organization_id
     FROM app."session"
     WHERE "userId" = $1
       AND "expiresAt" > statement_timestamp()
     ORDER BY "createdAt" DESC, id ASC`,
    [userId],
  );

  return result.rows.map((row) => ({
    activeOrganizationId: row.active_organization_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: row.id,
    ipAddress: row.ip_address,
    updatedAt: row.updated_at,
    userAgent: row.user_agent,
  }));
}

export async function revokeSession(
  executor: SqlExecutor,
  input: { sessionId: string; userId: string },
): Promise<boolean> {
  const result = await executor.query('DELETE FROM app."session" WHERE id = $1 AND "userId" = $2', [
    input.sessionId,
    input.userId,
  ]);
  return result.rowCount === 1;
}

export async function revokeAllOtherSessions(
  executor: SqlExecutor,
  input: { currentSessionId: string; userId: string },
): Promise<number> {
  const result = await executor.query(
    'DELETE FROM app."session" WHERE "userId" = $1 AND id <> $2',
    [input.userId, input.currentSessionId],
  );
  return result.rowCount ?? 0;
}

export async function setActiveOrganization(
  transaction: SqlExecutor,
  input: { organizationId: string | null; sessionId: string; userId: string },
): Promise<boolean> {
  // Organization mutations take this lock before touching sessions. Keep the
  // same order here so a concurrent membership reduction cannot deadlock a
  // session switch while each transaction waits on the other's first lock.
  if (input.organizationId !== null) {
    await lockOrganization(transaction, input.organizationId);
  }

  const session = await transaction.query(
    `SELECT id
       FROM app."session"
      WHERE id = $1
        AND "userId" = $2
        AND "expiresAt" > statement_timestamp()
      FOR UPDATE`,
    [input.sessionId, input.userId],
  );
  if (session.rowCount !== 1) return false;

  if (input.organizationId !== null) {
    const membership = await transaction.query(
      `SELECT member.id
         FROM app.member
         INNER JOIN app.organization
           ON organization.id = member."organizationId"
          AND organization."deletedAt" IS NULL
        WHERE member."organizationId" = $1
          AND member."userId" = $2
          AND member.status = 'active'
        FOR SHARE OF member, organization`,
      [input.organizationId, input.userId],
    );
    if (membership.rowCount !== 1) return false;
  }

  const updated = await transaction.query(
    `UPDATE app."session"
        SET "activeOrganizationId" = $3,
            "updatedAt" = statement_timestamp()
      WHERE id = $1 AND "userId" = $2`,
    [input.sessionId, input.userId, input.organizationId],
  );
  return updated.rowCount === 1;
}

export async function clearActiveOrganizationForMembership(
  transaction: SqlExecutor,
  input: { organizationId: string; userId: string },
): Promise<number> {
  const result = await transaction.query(
    `UPDATE app."session"
        SET "activeOrganizationId" = NULL,
            "updatedAt" = statement_timestamp()
      WHERE "userId" = $1 AND "activeOrganizationId" = $2`,
    [input.userId, input.organizationId],
  );
  return result.rowCount ?? 0;
}

export async function clearActiveOrganizationForDeletedOrganization(
  transaction: SqlExecutor,
  organizationId: string,
): Promise<number> {
  const result = await transaction.query(
    `UPDATE app."session"
        SET "activeOrganizationId" = NULL,
            "updatedAt" = statement_timestamp()
      WHERE "activeOrganizationId" = $1`,
    [organizationId],
  );
  return result.rowCount ?? 0;
}
