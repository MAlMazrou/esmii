import type { Pool, QueryResultRow } from "pg";

import { canonicalizeEmail } from "../email.js";
import { lockOrganization, type SqlExecutor, withTransaction } from "../transactions.js";
import type { AuditEventInput } from "./audit.js";
import { insertAuditEvent } from "./audit.js";
import {
  lockValidInvitationContinuation,
  markInvitationContinuationConsumed,
} from "./continuations.js";
import {
  createActionIntentWithOutbox,
  lockUsableActionIntent,
  markActionIntentConsumed,
} from "./delivery.js";

interface InvitationRow extends QueryResultRow {
  email: string;
  expires_at: Date;
  id: string;
  organization_id: string;
  role: "editor" | "member";
  status: string;
  version: number;
}

interface SafeInvitationRow extends QueryResultRow {
  accepted_at: Date | null;
  created_at: Date;
  email: string;
  expires_at: Date;
  id: string;
  inviter_id: string;
  inviter_name: string;
  organization_id: string;
  revoked_at: Date | null;
  role: "editor" | "member";
  status: string;
  updated_at: Date;
  version: number;
}

export interface SafeOrganizationInvitation {
  acceptedAt: Date | null;
  createdAt: Date;
  email: string;
  expiresAt: Date;
  id: string;
  inviterId: string;
  inviterName: string;
  organizationId: string;
  revokedAt: Date | null;
  role: "editor" | "member";
  status: "accepted" | "canceled" | "expired" | "pending" | "rejected" | "revoked";
  updatedAt: Date;
  version: number;
}

export async function listOrganizationInvitations(
  executor: SqlExecutor,
  input: {
    afterInvitationId?: string;
    limit: number;
    scope: "all" | "pending";
    sessionId: string;
    userId: string;
  },
): Promise<SafeOrganizationInvitation[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new TypeError("invitation list limit must be between 1 and 100");
  }
  const result = await executor.query<SafeInvitationRow>(
    `WITH authorized AS (
       SELECT requesting_member."organizationId" AS organization_id
         FROM app."session" AS requesting_session
         INNER JOIN app.organization
           ON organization.id = requesting_session."activeOrganizationId"
          AND organization."deletedAt" IS NULL
         INNER JOIN app.member AS requesting_member
           ON requesting_member."organizationId" = organization.id
          AND requesting_member."userId" = requesting_session."userId"
          AND requesting_member.status = 'active'
          AND requesting_member.role IN ('owner', 'editor')
        WHERE requesting_session.id = $1
          AND requesting_session."userId" = $2
          AND requesting_session."expiresAt" > statement_timestamp()
     )
     SELECT
       invitation.id,
       invitation."organizationId" AS organization_id,
       invitation.email,
       invitation.role,
       CASE
         WHEN invitation.status = 'pending'
          AND invitation."expiresAt" <= statement_timestamp()
         THEN 'expired'
         ELSE invitation.status
       END AS status,
       invitation."expiresAt" AS expires_at,
       invitation."createdAt" AS created_at,
       invitation."updatedAt" AS updated_at,
       invitation."acceptedAt" AS accepted_at,
       invitation."revokedAt" AS revoked_at,
       invitation."inviterId" AS inviter_id,
       inviter.name AS inviter_name,
       invitation.version
     FROM authorized
     INNER JOIN app.invitation ON invitation."organizationId" = authorized.organization_id
     INNER JOIN app."user" AS inviter ON inviter.id = invitation."inviterId"
     WHERE (
       $3::text = 'all'
       OR (
         invitation.status = 'pending'
         AND invitation."expiresAt" > statement_timestamp()
       )
     )
       AND ($4::text IS NULL OR invitation.id > $4)
     ORDER BY invitation.id
     LIMIT $5`,
    [input.sessionId, input.userId, input.scope, input.afterInvitationId ?? null, input.limit],
  );
  return result.rows.map((row) => ({
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    email: row.email,
    expiresAt: row.expires_at,
    id: row.id,
    inviterId: row.inviter_id,
    inviterName: row.inviter_name,
    organizationId: row.organization_id,
    revokedAt: row.revoked_at,
    role: row.role,
    status: row.status as SafeOrganizationInvitation["status"],
    updatedAt: row.updated_at,
    version: row.version,
  }));
}

async function requireInvitationManager(
  transaction: SqlExecutor,
  input: { actorUserId: string; organizationId: string },
): Promise<void> {
  const actor = await transaction.query(
    `SELECT member.id
       FROM app.member
       INNER JOIN app.organization
         ON organization.id = member."organizationId"
        AND organization."deletedAt" IS NULL
      WHERE member."organizationId" = $1
        AND member."userId" = $2
        AND member.status = 'active'
        AND member.role IN ('owner', 'editor')
      FOR SHARE OF member, organization`,
    [input.organizationId, input.actorUserId],
  );
  if (actor.rowCount !== 1) throw new Error("invitation management is not permitted");
}

export interface CreateOrResendInvitationInput {
  actorUserId: string;
  audit: AuditEventInput;
  correlationId: string;
  email: string;
  environment: "development" | "production" | "staging" | "test";
  intentId: string;
  invitationId: string;
  organizationId: string;
  outboxEventId: string;
  outboxIdempotencyKey: string;
  role: "editor" | "member";
}

export interface CreateOrResendInvitationResult {
  expiresAt: Date;
  invitationId: string;
  resent: boolean;
  version: number;
}

export async function createOrResendInvitation(
  pool: Pool,
  input: CreateOrResendInvitationInput,
): Promise<CreateOrResendInvitationResult> {
  const email = canonicalizeEmail(input.email);
  return withTransaction(pool, async (transaction) => {
    await lockOrganization(transaction, input.organizationId);
    await requireInvitationManager(transaction, input);

    const existingMember = await transaction.query(
      `SELECT member.id
         FROM app.member
         INNER JOIN app."user" ON "user".id = member."userId"
        WHERE member."organizationId" = $1
          AND "user".email = $2
          AND member.status = 'active'
        FOR SHARE OF member, "user"`,
      [input.organizationId, email],
    );
    if (existingMember.rowCount !== 0) {
      throw new Error("an active membership already exists for the invitation recipient");
    }

    await transaction.query(
      `UPDATE app.invitation
          SET status = 'expired',
              "updatedAt" = statement_timestamp(),
              version = version + 1
        WHERE "organizationId" = $1
          AND email = $2
          AND status = 'pending'
          AND "expiresAt" <= statement_timestamp()`,
      [input.organizationId, email],
    );

    const existing = await transaction.query<InvitationRow>(
      `SELECT
         id,
         "organizationId" AS organization_id,
         email,
         role,
         status,
         "expiresAt" AS expires_at,
         version
       FROM app.invitation
       WHERE "organizationId" = $1
         AND email = $2
         AND status = 'pending'
       FOR UPDATE`,
      [input.organizationId, email],
    );

    const current = existing.rows[0];
    let invitation: InvitationRow;
    let resent: boolean;
    if (current === undefined) {
      const inserted = await transaction.query<InvitationRow>(
        `INSERT INTO app.invitation (
           id,
           "organizationId",
           email,
           role,
           status,
           "expiresAt",
           "inviterId"
         ) VALUES ($1, $2, $3, $4, 'pending', transaction_timestamp() + interval '7 days', $5)
         RETURNING
           id,
           "organizationId" AS organization_id,
           email,
           role,
           status,
           "expiresAt" AS expires_at,
           version`,
        [input.invitationId, input.organizationId, email, input.role, input.actorUserId],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("invitation insertion did not return a row");
      invitation = row;
      resent = false;
    } else {
      const updated = await transaction.query<InvitationRow>(
        `UPDATE app.invitation
            SET role = $2,
                "inviterId" = $3,
                "updatedAt" = statement_timestamp(),
                version = version + 1
          WHERE id = $1 AND status = 'pending'
         RETURNING
           id,
           "organizationId" AS organization_id,
           email,
           role,
           status,
           "expiresAt" AS expires_at,
           version`,
        [current.id, input.role, input.actorUserId],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("pending invitation changed concurrently");
      invitation = row;
      resent = true;
    }

    await createActionIntentWithOutbox(transaction, {
      aggregateId: invitation.id,
      aggregateVersion: invitation.version,
      callbackIdentifier: "invitation_accept_callback",
      correlationId: input.correlationId,
      dispatchNotAfter: invitation.expires_at,
      environment: input.environment,
      generation: invitation.version,
      intentId: input.intentId,
      invitationId: invitation.id,
      outboxEventId: input.outboxEventId,
      outboxIdempotencyKey: input.outboxIdempotencyKey,
      purpose: "invitation_accept",
      recipientEmail: email,
    });
    await insertAuditEvent(transaction, {
      ...input.audit,
      action: resent ? "invitation.resent" : "invitation.created",
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      targetId: invitation.id,
      targetType: "invitation",
    });

    return {
      expiresAt: invitation.expires_at,
      invitationId: invitation.id,
      resent,
      version: invitation.version,
    };
  });
}

export async function revokeInvitation(
  pool: Pool,
  input: {
    actorUserId: string;
    audit: AuditEventInput;
    invitationId: string;
    organizationId: string;
  },
): Promise<boolean> {
  return withTransaction(pool, async (transaction) => {
    await lockOrganization(transaction, input.organizationId);
    await requireInvitationManager(transaction, input);
    const result = await transaction.query(
      `UPDATE app.invitation
          SET status = 'revoked',
              "revokedAt" = statement_timestamp(),
              "updatedAt" = statement_timestamp(),
              version = version + 1
        WHERE id = $1
          AND "organizationId" = $2
          AND role IN ('editor', 'member')
          AND status = 'pending'
          AND "expiresAt" > statement_timestamp()`,
      [input.invitationId, input.organizationId],
    );
    if (result.rowCount !== 1) return false;
    await transaction.query(
      `UPDATE app.action_link_issuance_intents
          SET status = 'superseded',
              superseded_at = statement_timestamp(),
              updated_at = statement_timestamp()
        WHERE invitation_id = $1 AND status IN ('requested', 'issued')`,
      [input.invitationId],
    );
    await insertAuditEvent(transaction, {
      ...input.audit,
      action: "invitation.revoked",
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      targetId: input.invitationId,
      targetType: "invitation",
    });
    return true;
  });
}

interface AcceptLockedInvitationInput {
  audit: AuditEventInput;
  authorizationEventId: string;
  authorizationIdempotencyKey: string;
  correlationId: string;
  intentId: string;
  invitationId: string;
  membershipId: string;
  userId: string;
}

export interface InvitationAcceptanceResult {
  organizationId: string;
  /** The append-only acceptance audit event ID, suitable as an invalidation version. */
  version: string;
}

/** Completes acceptance only after the caller has locked the exact issued intent. */
async function acceptLockedInvitation(
  transaction: SqlExecutor,
  input: AcceptLockedInvitationInput,
): Promise<InvitationAcceptanceResult | null> {
  const identity = await transaction.query<
    QueryResultRow & { email: string; email_verified: boolean; status: string }
  >(
    `SELECT email, "emailVerified" AS email_verified, status
       FROM app."user"
      WHERE id = $1
      FOR SHARE`,
    [input.userId],
  );
  const user = identity.rows[0];
  if (user === undefined || !user.email_verified || user.status !== "active") return null;

  const location = await transaction.query<QueryResultRow & { organization_id: string }>(
    `SELECT "organizationId" AS organization_id
       FROM app.invitation
      WHERE id = $1`,
    [input.invitationId],
  );
  const organizationId = location.rows[0]?.organization_id;
  if (organizationId === undefined) return null;

  await lockOrganization(transaction, organizationId);
  const invitationResult = await transaction.query<InvitationRow>(
    `SELECT
       id,
       "organizationId" AS organization_id,
       email,
       role,
       status,
       "expiresAt" AS expires_at,
       version
     FROM app.invitation
     WHERE id = $1
       AND "organizationId" = $2
       AND status = 'pending'
       AND "expiresAt" > statement_timestamp()
     FOR UPDATE`,
    [input.invitationId, organizationId],
  );
  const invitation = invitationResult.rows[0];
  if (invitation === undefined || invitation.email !== canonicalizeEmail(user.email)) {
    return null;
  }
  const organization = await transaction.query(
    `SELECT id FROM app.organization WHERE id = $1 AND "deletedAt" IS NULL FOR SHARE`,
    [organizationId],
  );
  if (organization.rowCount !== 1) return null;

  const currentMembership = await transaction.query<
    QueryResultRow & { id: string; status: string }
  >(
    `SELECT id, status
       FROM app.member
      WHERE "organizationId" = $1 AND "userId" = $2
      FOR UPDATE`,
    [organizationId, input.userId],
  );
  const membership = currentMembership.rows[0];
  if (membership?.status === "active") return null;
  let acceptedMembership: { id: string; version: number };
  if (membership === undefined) {
    const insertedMembership = await transaction.query<
      QueryResultRow & { id: string; version: number }
    >(
      `INSERT INTO app.member (
         id, "organizationId", "userId", role, status, "removedAt"
       ) VALUES ($1, $2, $3, $4, 'active', NULL)
       RETURNING id, version`,
      [input.membershipId, organizationId, input.userId, invitation.role],
    );
    const inserted = insertedMembership.rows[0];
    if (inserted === undefined) throw new Error("accepted membership was not inserted");
    acceptedMembership = inserted;
  } else {
    const reactivatedMembership = await transaction.query<
      QueryResultRow & { id: string; version: number }
    >(
      `UPDATE app.member
          SET role = $2,
              status = 'active',
              "removedAt" = NULL,
              "updatedAt" = statement_timestamp(),
              version = version + 1
        WHERE id = $1
        RETURNING id, version`,
      [membership.id, invitation.role],
    );
    const reactivated = reactivatedMembership.rows[0];
    if (reactivated === undefined) throw new Error("accepted membership was not reactivated");
    acceptedMembership = reactivated;
  }
  await transaction.query(
    `UPDATE app.invitation
        SET status = 'accepted',
            "acceptedAt" = statement_timestamp(),
            "updatedAt" = statement_timestamp(),
            version = version + 1
      WHERE id = $1 AND status = 'pending'`,
    [input.invitationId],
  );
  if (
    !(await markActionIntentConsumed(transaction, input.intentId, {
      invitationId: input.invitationId,
      purpose: "invitation_accept",
    }))
  ) {
    throw new Error("locked invitation action intent is no longer consumable");
  }
  await insertAuditEvent(transaction, {
    ...input.audit,
    action: "invitation.accepted",
    actorUserId: input.userId,
    organizationId,
    targetId: input.invitationId,
    targetType: "invitation",
  });
  await transaction.query(
    `INSERT INTO app.outbox_events (
       event_id,
       event_type,
       aggregate_type,
       aggregate_id,
       aggregate_version,
       idempotency_key,
       payload,
       correlation_id
     ) VALUES (
       $1,
       'authorization.invalidated',
       'organization_membership',
       $2,
       $3,
       $4,
       $5::jsonb,
       $6
     )`,
    [
      input.authorizationEventId,
      acceptedMembership.id,
      acceptedMembership.version,
      input.authorizationIdempotencyKey,
      JSON.stringify({ organizationId, userId: input.userId }),
      input.correlationId,
    ],
  );
  return { organizationId, version: input.audit.eventId };
}

/** Raw action-token acceptance boundary used only before the token is exchanged away. */
export async function acceptInvitation(
  transaction: SqlExecutor,
  input: AcceptLockedInvitationInput & {
    environment: "development" | "production" | "staging" | "test";
    presentedTokenHash: string;
  },
): Promise<boolean> {
  const lockedIntent = await lockUsableActionIntent(transaction, {
    environment: input.environment,
    intentId: input.intentId,
    presentedTokenHash: input.presentedTokenHash,
    purpose: "invitation_accept",
  });
  if (lockedIntent?.invitationId !== input.invitationId) return false;
  return (await acceptLockedInvitation(transaction, input)) !== null;
}

/**
 * Accepts only through the hash-authenticated continuation bound to the exact
 * issued action intent at exchange time. No raw action token is retained or
 * required after the clean redirect.
 */
export async function acceptInvitationFromContinuation(
  pool: Pool,
  input: Omit<AcceptLockedInvitationInput, "intentId" | "invitationId"> & {
    continuationId: string;
    environment: "development" | "production" | "staging" | "test";
    presentedSecretHash: string;
  },
): Promise<InvitationAcceptanceResult | null> {
  return withTransaction(pool, async (transaction) => {
    const continuation = await lockValidInvitationContinuation(transaction, {
      continuationId: input.continuationId,
      environment: input.environment,
      presentedSecretHash: input.presentedSecretHash,
    });
    if (continuation === null) return null;

    const accepted = await acceptLockedInvitation(transaction, {
      ...input,
      intentId: continuation.actionIntentId,
      invitationId: continuation.invitationId,
    });
    if (accepted === null) return null;
    if (
      !(await markInvitationContinuationConsumed(transaction, {
        actionIntentId: continuation.actionIntentId,
        continuationId: input.continuationId,
      }))
    ) {
      throw new Error("locked invitation continuation changed before consumption");
    }
    return accepted;
  });
}
