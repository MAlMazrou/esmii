import { timingSafeEqual } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { SqlExecutor } from "../transactions.js";

const sha256HexPattern = /^[0-9a-f]{64}$/u;

export async function createInvitationContinuation(
  executor: SqlExecutor,
  input: {
    actionIntentId: string;
    expiresAt: Date;
    id: string;
    invitationId: string;
    secretHash: string;
  },
): Promise<void> {
  if (!sha256HexPattern.test(input.secretHash)) {
    throw new TypeError("continuation secret hash must be a lowercase SHA-256 hex digest");
  }
  const inserted = await executor.query(
    `INSERT INTO app.invitation_continuations (
       id, invitation_id, action_intent_id, secret_hash, expires_at
     )
     SELECT
       $1,
       $2,
       intent.id,
       $4,
       LEAST($5, intent.expires_at, transaction_timestamp() + interval '10 minutes')
       FROM app.action_link_issuance_intents AS intent
      WHERE intent.id = $3
        AND intent.invitation_id = $2
        AND intent.purpose = 'invitation_accept'
        AND intent.status = 'issued'
        AND intent.expires_at > statement_timestamp()`,
    [input.id, input.invitationId, input.actionIntentId, input.secretHash, input.expiresAt],
  );
  if (inserted.rowCount !== 1) {
    throw new Error("invitation continuation requires the matching issued action intent");
  }
}

interface ContinuationRow extends QueryResultRow {
  action_intent_id: string;
  invitation_id: string;
  secret_hash: string;
}

interface InspectedContinuationRow extends QueryResultRow {
  email: string;
  expires_at: Date;
  invitation_id: string;
  invitation_status: InspectedInvitationContinuation["status"];
  organization_deleted: boolean;
  organization_name: string;
  role: "editor" | "member";
  secret_hash: string;
}

export interface InspectedInvitationContinuation {
  email: string;
  expiresAt: Date;
  invitationId: string;
  organization: { deleted: boolean; displayName: string };
  role: "editor" | "member";
  status: "accepted" | "canceled" | "expired" | "pending" | "rejected" | "revoked";
}

/** Safe, non-consuming presentation read for the clean invitation page. */
export async function inspectInvitationContinuation(
  executor: SqlExecutor,
  input: { continuationId: string; presentedSecretHash: string },
): Promise<InspectedInvitationContinuation | null> {
  if (!sha256HexPattern.test(input.presentedSecretHash)) return null;
  const result = await executor.query<InspectedContinuationRow>(
    `SELECT
       continuation.secret_hash,
       invitation.id AS invitation_id,
       invitation.email,
       invitation.role,
       invitation.status AS invitation_status,
       invitation."expiresAt" AS expires_at,
       organization.name AS organization_name,
       (organization."deletedAt" IS NOT NULL) AS organization_deleted
       FROM app.invitation_continuations AS continuation
       INNER JOIN app.action_link_issuance_intents AS intent
         ON intent.id = continuation.action_intent_id
        AND intent.invitation_id = continuation.invitation_id
        AND intent.purpose = 'invitation_accept'
        AND intent.status = 'issued'
        AND intent.expires_at > statement_timestamp()
       INNER JOIN app.invitation
         ON invitation.id = continuation.invitation_id
       INNER JOIN app.organization
         ON organization.id = invitation."organizationId"
      WHERE continuation.id = $1
        AND continuation.consumed_at IS NULL
        AND continuation.expires_at > statement_timestamp()`,
    [input.continuationId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const expected = Buffer.from(row.secret_hash, "hex");
  const presented = Buffer.from(input.presentedSecretHash, "hex");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;

  return {
    email: row.email,
    expiresAt: row.expires_at,
    invitationId: row.invitation_id,
    organization: {
      deleted: row.organization_deleted,
      displayName: row.organization_name,
    },
    role: row.role,
    status: row.invitation_status,
  };
}

export interface LockedInvitationContinuation {
  actionIntentId: string;
  invitationId: string;
}

/** Locks a hash-authenticated continuation and the exact issued intent it was exchanged from. */
export async function lockValidInvitationContinuation(
  transaction: SqlExecutor,
  input: {
    continuationId: string;
    environment: "development" | "production" | "staging" | "test";
    presentedSecretHash: string;
  },
): Promise<LockedInvitationContinuation | null> {
  if (!sha256HexPattern.test(input.presentedSecretHash)) return null;
  const result = await transaction.query<ContinuationRow>(
    `SELECT
       continuation.action_intent_id,
       continuation.invitation_id,
       continuation.secret_hash
       FROM app.invitation_continuations AS continuation
       INNER JOIN app.action_link_issuance_intents AS intent
         ON intent.id = continuation.action_intent_id
        AND intent.invitation_id = continuation.invitation_id
        AND intent.purpose = 'invitation_accept'
        AND intent.environment = $2
        AND intent.status = 'issued'
        AND intent.expires_at > statement_timestamp()
      WHERE continuation.id = $1
        AND continuation.consumed_at IS NULL
        AND continuation.expires_at > statement_timestamp()
      FOR UPDATE OF continuation, intent`,
    [input.continuationId, input.environment],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const expected = Buffer.from(row.secret_hash, "hex");
  const presented = Buffer.from(input.presentedSecretHash, "hex");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;

  return { actionIntentId: row.action_intent_id, invitationId: row.invitation_id };
}

export async function markInvitationContinuationConsumed(
  transaction: SqlExecutor,
  input: { actionIntentId: string; continuationId: string },
): Promise<boolean> {
  const consumed = await transaction.query(
    `UPDATE app.invitation_continuations
        SET consumed_at = statement_timestamp()
      WHERE id = $1
        AND action_intent_id = $2
        AND consumed_at IS NULL
        AND expires_at > statement_timestamp()`,
    [input.continuationId, input.actionIntentId],
  );
  return consumed.rowCount === 1;
}
