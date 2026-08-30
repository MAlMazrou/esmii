import type { Pool, QueryResultRow } from "pg";

import type { OrganizationRole } from "../authorization.js";
import type { AuditEventInput } from "./audit.js";
import { insertAuditEvent } from "./audit.js";
import { clearActiveOrganizationForDeletedOrganization } from "./sessions.js";
import { lockOrganization, type SqlExecutor, withTransaction } from "../transactions.js";
import {
  bindPreparedTombstone,
  markTombstoneLocalApplied,
  type TombstoneScopeKind,
} from "./tombstones.js";

const sha256HexPattern = /^[0-9a-f]{64}$/u;

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  result_reference: string | null;
  status: string;
}

export interface CreateOrganizationInput {
  actorUserId: string;
  audit: AuditEventInput;
  idempotencyId: string;
  idempotencyKey: string;
  membershipId: string;
  name: string;
  organizationId: string;
  requestHash: string;
  slug: string;
}

export interface CreateOrganizationResult {
  organizationId: string;
  replayed: boolean;
}

export async function createOrganization(
  pool: Pool,
  input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  if (!sha256HexPattern.test(input.requestHash)) {
    throw new TypeError("organization request hash must be a lowercase SHA-256 hex digest");
  }

  return withTransaction(pool, async (transaction) => {
    const inserted = await transaction.query(
      `INSERT INTO app.operation_idempotency (
         id, actor_user_id, operation, idempotency_key, request_hash
       ) VALUES ($1, $2, 'organization.create', $3, $4)
       ON CONFLICT (actor_user_id, operation, idempotency_key) DO NOTHING`,
      [input.idempotencyId, input.actorUserId, input.idempotencyKey, input.requestHash],
    );

    if (inserted.rowCount === 0) {
      const replay = await transaction.query<IdempotencyRow>(
        `SELECT request_hash, result_reference, status
           FROM app.operation_idempotency
          WHERE actor_user_id = $1
            AND operation = 'organization.create'
            AND idempotency_key = $2
          FOR UPDATE`,
        [input.actorUserId, input.idempotencyKey],
      );
      const row = replay.rows[0];
      if (
        row === undefined ||
        row.request_hash !== input.requestHash ||
        row.status !== "completed" ||
        row.result_reference === null
      ) {
        throw new Error("idempotency key was reused with a different or incomplete request");
      }
      return { organizationId: row.result_reference, replayed: true };
    }

    const verified = await transaction.query(
      `SELECT id
         FROM app."user"
        WHERE id = $1 AND status = 'active' AND "emailVerified"
        FOR SHARE`,
      [input.actorUserId],
    );
    if (verified.rowCount !== 1) throw new Error("verified active user is required");

    await transaction.query(
      `INSERT INTO app.organization (id, name, slug)
       VALUES ($1, btrim($2), $3)`,
      [input.organizationId, input.name, input.slug],
    );
    await transaction.query(
      `INSERT INTO app.member (id, "organizationId", "userId", role)
       VALUES ($1, $2, $3, 'owner')`,
      [input.membershipId, input.organizationId, input.actorUserId],
    );
    await insertAuditEvent(transaction, {
      ...input.audit,
      action: "organization.created",
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      targetId: input.organizationId,
      targetType: "organization",
    });
    await transaction.query(
      `UPDATE app.operation_idempotency
          SET status = 'completed',
              result_reference = $2,
              completed_at = statement_timestamp()
        WHERE id = $1`,
      [input.idempotencyId, input.organizationId],
    );
    return { organizationId: input.organizationId, replayed: false };
  });
}

interface MembershipRow extends QueryResultRow {
  role: OrganizationRole;
  status: string;
  user_id: string;
}

async function requireRecentOwner(
  transaction: SqlExecutor,
  input: {
    actorSessionId: string;
    actorUserId: string;
    organizationId: string;
    recentAfter: Date;
  },
): Promise<void> {
  const actor = await transaction.query(
    `SELECT member.id
       FROM app.member
       INNER JOIN app.organization
         ON organization.id = member."organizationId"
        AND organization."deletedAt" IS NULL
       INNER JOIN app."user"
         ON "user".id = member."userId"
        AND "user".status = 'active'
        AND "user"."emailVerified"
       INNER JOIN app."session"
         ON "session".id = $3
        AND "session"."userId" = "user".id
        AND "session"."expiresAt" > statement_timestamp()
        AND "session"."createdAt" >= $4
      WHERE member."organizationId" = $1
        AND member."userId" = $2
        AND member.status = 'active'
        AND member.role = 'owner'
      FOR SHARE OF member, organization, "user", "session"`,
    [input.organizationId, input.actorUserId, input.actorSessionId, input.recentAfter],
  );
  if (actor.rowCount !== 1) throw new Error("recently authenticated owner is required");
}

/** Additive owner-authority transfer: the initiating owner remains an owner. */
export async function grantOwnerAuthority(
  pool: Pool,
  input: {
    actorSessionId: string;
    actorUserId: string;
    audit: AuditEventInput;
    organizationId: string;
    recentAfter: Date;
    targetMembershipId: string;
  },
): Promise<boolean> {
  return withTransaction(pool, async (transaction) => {
    await lockOrganization(transaction, input.organizationId);
    await requireRecentOwner(transaction, input);
    const target = await transaction.query<MembershipRow>(
      `SELECT member."userId" AS user_id, member.role, member.status
         FROM app.member
         INNER JOIN app."user"
           ON "user".id = member."userId"
          AND "user".status = 'active'
          AND "user"."emailVerified"
        WHERE member.id = $1
          AND member."organizationId" = $2
          AND member.status = 'active'
        FOR UPDATE OF member`,
      [input.targetMembershipId, input.organizationId],
    );
    const row = target.rows[0];
    if (row === undefined) throw new Error("verified active target member is required");
    if (row.role === "owner") return false;

    await transaction.query(
      `UPDATE app.member
          SET role = 'owner',
              version = version + 1,
              "updatedAt" = statement_timestamp()
        WHERE id = $1`,
      [input.targetMembershipId],
    );
    await transaction.query('DELETE FROM app."session" WHERE "userId" = $1', [row.user_id]);
    await transaction.query(
      `UPDATE app."user"
          SET "authorizationVersion" = "authorizationVersion" + 1,
              "updatedAt" = statement_timestamp()
        WHERE id = $1`,
      [row.user_id],
    );
    await insertAuditEvent(transaction, {
      ...input.audit,
      action: "ownership.granted",
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      targetId: input.targetMembershipId,
      targetType: "membership",
    });
    return true;
  });
}

async function requireOwner(
  transaction: SqlExecutor,
  input: { actorSessionId: string; actorUserId: string; organizationId: string },
): Promise<void> {
  const actor = await transaction.query(
    `SELECT member.id
       FROM app.member
       INNER JOIN app.organization
         ON organization.id = member."organizationId"
        AND organization."deletedAt" IS NULL
       INNER JOIN app."session"
         ON "session".id = $3
        AND "session"."userId" = member."userId"
        AND "session"."expiresAt" > statement_timestamp()
      WHERE member."organizationId" = $1
        AND member."userId" = $2
        AND member.status = 'active'
        AND member.role = 'owner'
      FOR SHARE OF member, organization, "session"`,
    [input.organizationId, input.actorUserId, input.actorSessionId],
  );
  if (actor.rowCount !== 1) throw new Error("organization owner is required");
}

/** Non-reducing member-to-editor role change. Demotions use applyMembershipReduction. */
export async function promoteMembershipToEditor(
  pool: Pool,
  input: {
    actorSessionId: string;
    actorUserId: string;
    audit: AuditEventInput;
    organizationId: string;
    targetMembershipId: string;
  },
): Promise<boolean> {
  return withTransaction(pool, async (transaction) => {
    await lockOrganization(transaction, input.organizationId);
    await requireOwner(transaction, input);
    const target = await transaction.query<MembershipRow>(
      `SELECT "userId" AS user_id, role, status
         FROM app.member
        WHERE id = $1 AND "organizationId" = $2
        FOR UPDATE`,
      [input.targetMembershipId, input.organizationId],
    );
    const row = target.rows[0];
    if (row === undefined || row.status !== "active") return false;
    if (row.role === "editor") return false;
    if (row.role !== "member") throw new Error("owner authority uses the ownership flow");

    await transaction.query(
      `UPDATE app.member
          SET role = 'editor', version = version + 1, "updatedAt" = statement_timestamp()
        WHERE id = $1`,
      [input.targetMembershipId],
    );
    await transaction.query('DELETE FROM app."session" WHERE "userId" = $1', [row.user_id]);
    await transaction.query(
      `UPDATE app."user"
          SET "authorizationVersion" = "authorizationVersion" + 1,
              "updatedAt" = statement_timestamp()
        WHERE id = $1`,
      [row.user_id],
    );
    await insertAuditEvent(transaction, {
      ...input.audit,
      action: "membership.role_changed",
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      targetId: input.targetMembershipId,
      targetType: "membership",
    });
    return true;
  });
}

export async function applyMembershipReduction(
  transaction: SqlExecutor,
  input: {
    actorSessionId: string;
    actorUserId: string;
    audit: AuditEventInput;
    newRole: Exclude<OrganizationRole, "owner"> | null;
    organizationId: string;
    recentAfter: Date;
    targetMembershipId: string;
    tombstoneEventId: string;
    tombstoneScopeKind: Extract<TombstoneScopeKind, "membership" | "ownership">;
  },
): Promise<boolean> {
  if (input.audit.eventId !== input.tombstoneEventId) {
    throw new TypeError("membership audit and tombstone event identities must match");
  }
  await lockOrganization(transaction, input.organizationId);
  await requireRecentOwner(transaction, input);
  const target = await transaction.query<MembershipRow>(
    `SELECT "userId" AS user_id, role, status
       FROM app.member
      WHERE id = $1 AND "organizationId" = $2
      FOR UPDATE`,
    [input.targetMembershipId, input.organizationId],
  );
  const row = target.rows[0];
  if (row === undefined || row.status !== "active") return false;
  if (
    (row.role === "owner" && input.tombstoneScopeKind !== "ownership") ||
    (row.role !== "owner" && input.tombstoneScopeKind !== "membership")
  ) {
    throw new TypeError("membership reduction tombstone kind does not match current authority");
  }

  if (input.newRole === null) {
    await bindPreparedTombstone(transaction, {
      eventId: input.tombstoneEventId,
      membershipId: input.targetMembershipId,
      organizationId: input.organizationId,
      scopeKind: input.tombstoneScopeKind,
      userId: row.user_id,
    });
    await transaction.query(
      `UPDATE app.member
          SET status = 'removed',
              "removedAt" = statement_timestamp(),
              version = version + 1,
              "updatedAt" = statement_timestamp()
        WHERE id = $1`,
      [input.targetMembershipId],
    );
  } else {
    if (row.role === input.newRole) return false;
    const roleRank: Readonly<Record<OrganizationRole, number>> = {
      editor: 2,
      member: 1,
      owner: 3,
    };
    if (roleRank[input.newRole] >= roleRank[row.role]) {
      throw new TypeError("membership reduction cannot grant additional authority");
    }
    await bindPreparedTombstone(transaction, {
      eventId: input.tombstoneEventId,
      membershipId: input.targetMembershipId,
      organizationId: input.organizationId,
      scopeKind: input.tombstoneScopeKind,
      userId: row.user_id,
    });
    await transaction.query(
      `UPDATE app.member
          SET role = $2,
              version = version + 1,
              "updatedAt" = statement_timestamp()
        WHERE id = $1`,
      [input.targetMembershipId, input.newRole],
    );
  }

  await transaction.query('DELETE FROM app."session" WHERE "userId" = $1', [row.user_id]);
  await transaction.query(
    `UPDATE app."user"
        SET "authorizationVersion" = "authorizationVersion" + 1,
            "updatedAt" = statement_timestamp()
      WHERE id = $1`,
    [row.user_id],
  );
  if (!(await markTombstoneLocalApplied(transaction, input.tombstoneEventId))) {
    throw new Error("prepared tombstone is unavailable for membership reduction");
  }
  await insertAuditEvent(transaction, {
    ...input.audit,
    action: input.newRole === null ? "membership.removed" : "membership.role_reduced",
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    targetId: input.targetMembershipId,
    targetType: "membership",
  });
  return true;
}

export async function applyOrganizationSoftDeletion(
  transaction: SqlExecutor,
  input: {
    actorSessionId: string;
    actorUserId: string;
    audit: AuditEventInput;
    organizationId: string;
    recentAfter: Date;
    tombstoneEventId: string;
  },
): Promise<boolean> {
  if (input.audit.eventId !== input.tombstoneEventId) {
    throw new TypeError("organization audit and tombstone event identities must match");
  }
  await lockOrganization(transaction, input.organizationId);
  await requireRecentOwner(transaction, input);
  const current = await transaction.query(
    `SELECT id FROM app.organization WHERE id = $1 AND "deletedAt" IS NULL FOR UPDATE`,
    [input.organizationId],
  );
  if (current.rowCount !== 1) return false;
  await bindPreparedTombstone(transaction, {
    eventId: input.tombstoneEventId,
    organizationId: input.organizationId,
    scopeKind: "organization",
  });
  const changed = await transaction.query(
    `UPDATE app.organization
        SET "deletedAt" = statement_timestamp(),
            "updatedAt" = statement_timestamp(),
            version = version + 1
      WHERE id = $1 AND "deletedAt" IS NULL`,
    [input.organizationId],
  );
  if (changed.rowCount !== 1) return false;

  await clearActiveOrganizationForDeletedOrganization(transaction, input.organizationId);
  await transaction.query(
    `UPDATE app.invitation
        SET status = 'revoked',
            "revokedAt" = statement_timestamp(),
            "updatedAt" = statement_timestamp(),
            version = version + 1
      WHERE "organizationId" = $1 AND status = 'pending'`,
    [input.organizationId],
  );
  await transaction.query(
    `UPDATE app.member
        SET status = 'disabled',
            "removedAt" = statement_timestamp(),
            "updatedAt" = statement_timestamp(),
            version = version + 1
      WHERE "organizationId" = $1 AND status = 'active'`,
    [input.organizationId],
  );
  await transaction.query(
    `UPDATE app."user"
        SET "authorizationVersion" = "authorizationVersion" + 1,
            "updatedAt" = statement_timestamp()
      WHERE id IN (SELECT "userId" FROM app.member WHERE "organizationId" = $1)`,
    [input.organizationId],
  );
  if (!(await markTombstoneLocalApplied(transaction, input.tombstoneEventId))) {
    throw new Error("prepared tombstone is unavailable for organization deletion");
  }
  await insertAuditEvent(transaction, {
    ...input.audit,
    action: "organization.deleted",
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    targetId: input.organizationId,
    targetType: "organization",
  });
  return true;
}
