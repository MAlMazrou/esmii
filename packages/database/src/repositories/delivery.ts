import { timingSafeEqual } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import { canonicalizeEmail } from "../email.js";
import type { SqlExecutor } from "../transactions.js";
import { withTransaction } from "../transactions.js";

export type ActionLinkPurpose = "invitation_accept" | "magic_login";
export type ActionLinkIntentStatus =
  "cancelled" | "consumed" | "expired" | "issued" | "requested" | "superseded";
export type OutboxEventType =
  | "authorization.invalidated"
  | "invitation.requested"
  | "magic_link.requested"
  | "notification.requested";

const sha256HexPattern = /^[0-9a-f]{64}$/u;
const rfcMessageIdPattern = /^<[A-Za-z0-9._-]{1,200}@[A-Za-z0-9.-]{1,253}>$/u;

function assertSha256Hex(value: string, label: string): void {
  if (!sha256HexPattern.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hex digest`);
  }
}

export interface CreateActionIntentInput {
  aggregateId: string;
  aggregateVersion: number;
  callbackIdentifier: "invitation_accept_callback" | "magic_login_callback";
  correlationId: string;
  dispatchNotAfter: Date;
  environment: "development" | "production" | "staging" | "test";
  generation: number;
  intentId: string;
  invitationId: string | null;
  outboxEventId: string;
  outboxIdempotencyKey: string;
  purpose: ActionLinkPurpose;
  recipientEmail: string;
}

/** Inserts the current intent and its safe outbox request in one domain transaction. */
export async function createActionIntentWithOutbox(
  transaction: SqlExecutor,
  input: CreateActionIntentInput,
): Promise<void> {
  const recipientEmail = canonicalizeEmail(input.recipientEmail);
  if (
    (input.purpose === "magic_login" &&
      (input.invitationId !== null || input.callbackIdentifier !== "magic_login_callback")) ||
    (input.purpose === "invitation_accept" &&
      (input.invitationId === null || input.callbackIdentifier !== "invitation_accept_callback"))
  ) {
    throw new TypeError("action-link purpose, callback, and invitation identity do not match");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new TypeError("action-link generation must be a positive integer");
  }
  if (!Number.isSafeInteger(input.aggregateVersion) || input.aggregateVersion < 1) {
    throw new TypeError("aggregate version must be a positive integer");
  }

  if (input.purpose === "magic_login") {
    await transaction.query(
      `UPDATE app.action_link_issuance_intents
          SET status = 'superseded',
              superseded_at = statement_timestamp(),
              updated_at = statement_timestamp()
        WHERE environment = $1
          AND purpose = 'magic_login'
          AND recipient_email = $2
          AND status IN ('requested', 'issued')`,
      [input.environment, recipientEmail],
    );
  } else {
    await transaction.query(
      `UPDATE app.action_link_issuance_intents
          SET status = 'superseded',
              superseded_at = statement_timestamp(),
              updated_at = statement_timestamp()
        WHERE invitation_id = $1
          AND purpose = 'invitation_accept'
          AND status IN ('requested', 'issued')`,
      [input.invitationId],
    );
  }

  await transaction.query(
    `INSERT INTO app.action_link_issuance_intents (
       id,
       environment,
       purpose,
       recipient_email,
       callback_identifier,
       invitation_id,
       generation,
       dispatch_not_after
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.intentId,
      input.environment,
      input.purpose,
      recipientEmail,
      input.callbackIdentifier,
      input.invitationId,
      input.generation,
      input.dispatchNotAfter,
    ],
  );

  const eventType =
    input.purpose === "magic_login" ? "magic_link.requested" : "invitation.requested";
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
     ) VALUES ($1, $2, 'action_link_issuance_intent', $3, $4, $5, $6::jsonb, $7)`,
    [
      input.outboxEventId,
      eventType,
      input.aggregateId,
      input.aggregateVersion,
      input.outboxIdempotencyKey,
      JSON.stringify({ intentId: input.intentId, purpose: input.purpose }),
      input.correlationId,
    ],
  );
}

interface IssuedIntentRow extends QueryResultRow {
  environment: string;
  expires_at: Date;
  invitation_id: string | null;
  purpose: ActionLinkPurpose;
  recipient_email: string;
  requested_at: Date;
  status: string;
}

interface DeliveryIntentRow extends QueryResultRow {
  callback_identifier: "invitation_accept_callback" | "magic_login_callback";
  dispatch_not_after: Date;
  expires_at: Date | null;
  invitation_id: string | null;
  invitation_role: "editor" | "member" | null;
  key_version: string | null;
  organization_id: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  purpose: ActionLinkPurpose;
  recipient_email: string;
  requested_at: Date;
  stable_message_id: string | null;
  status: ActionLinkIntentStatus;
  token_hash: string | null;
}

export interface DeliveryActionIntent {
  callbackIdentifier: "invitation_accept_callback" | "magic_login_callback";
  dispatchNotAfter: Date;
  expiresAt: Date | null;
  invitationId: string | null;
  invitationRole: "editor" | "member" | null;
  keyVersion: string | null;
  organization: { id: string; name: string; slug: string } | null;
  purpose: ActionLinkPurpose;
  recipientEmail: string;
  requestedAt: Date;
  stableMessageId: string | null;
  status: ActionLinkIntentStatus;
  tokenHash: string | null;
}

/** Token-free delivery context. Only a one-way hash may leave this boundary. */
export async function getActionIntentForDelivery(
  executor: SqlExecutor,
  input: { environment: string; intentId: string; purpose: ActionLinkPurpose },
): Promise<DeliveryActionIntent | null> {
  const result = await executor.query<DeliveryIntentRow>(
    `SELECT
       intent.purpose,
       intent.recipient_email,
       intent.callback_identifier,
       intent.invitation_id,
       invitation.role AS invitation_role,
       intent.requested_at,
       intent.dispatch_not_after,
       intent.status,
       intent.key_version,
       intent.token_hash,
       intent.stable_message_id,
       intent.expires_at,
       organization.id AS organization_id,
       organization.name AS organization_name,
       organization.slug AS organization_slug
     FROM app.action_link_issuance_intents AS intent
     LEFT JOIN app.invitation ON invitation.id = intent.invitation_id
     LEFT JOIN app.organization
       ON organization.id = invitation."organizationId"
      AND organization."deletedAt" IS NULL
     WHERE intent.id = $1
       AND intent.environment = $2
       AND intent.purpose = $3`,
    [input.intentId, input.environment, input.purpose],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const organization =
    row.organization_id === null || row.organization_name === null || row.organization_slug === null
      ? null
      : { id: row.organization_id, name: row.organization_name, slug: row.organization_slug };
  return {
    callbackIdentifier: row.callback_identifier,
    dispatchNotAfter: row.dispatch_not_after,
    expiresAt: row.expires_at,
    invitationId: row.invitation_id,
    invitationRole: row.invitation_role,
    keyVersion: row.key_version,
    organization,
    purpose: row.purpose,
    recipientEmail: row.recipient_email,
    requestedAt: row.requested_at,
    stableMessageId: row.stable_message_id,
    status: row.status,
    tokenHash: row.token_hash,
  };
}

export async function issueCurrentActionIntent(
  transaction: SqlExecutor,
  input: {
    environment: string;
    expiresAt: Date;
    intentId: string;
    keyVersion: number | string;
    purpose: ActionLinkPurpose;
    stableMessageId: string;
    tokenHash: string;
  },
): Promise<boolean> {
  assertSha256Hex(input.tokenHash, "token hash");
  const keyVersion = String(input.keyVersion);
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyVersion)) {
    throw new TypeError("key version must be a bounded opaque identifier");
  }
  if (!rfcMessageIdPattern.test(input.stableMessageId)) {
    throw new TypeError("stable message ID must be a bounded RFC Message-ID");
  }

  const locked = await transaction.query<IssuedIntentRow>(
    `SELECT
       intent.environment,
       intent.purpose,
       intent.recipient_email,
       intent.invitation_id,
       intent.requested_at,
       intent.dispatch_not_after AS expires_at,
       intent.status
     FROM app.action_link_issuance_intents AS intent
     WHERE intent.id = $1
       AND intent.dispatch_not_after > statement_timestamp()
     FOR UPDATE`,
    [input.intentId],
  );
  const row = locked.rows[0];
  if (
    row === undefined ||
    row.environment !== input.environment ||
    row.purpose !== input.purpose ||
    row.status !== "requested"
  ) {
    return false;
  }

  if (row.purpose === "invitation_accept") {
    const invitation = await transaction.query<{ expires_at: Date } & QueryResultRow>(
      `SELECT "expiresAt" AS expires_at
         FROM app.invitation
        WHERE id = $1
          AND status = 'pending'
          AND "expiresAt" > statement_timestamp()
        FOR UPDATE`,
      [row.invitation_id],
    );
    const invitationExpiry = invitation.rows[0]?.expires_at;
    if (invitationExpiry === undefined || input.expiresAt.getTime() > invitationExpiry.getTime()) {
      return false;
    }
  }

  const result = await transaction.query(
    `UPDATE app.action_link_issuance_intents
        SET status = 'issued',
            key_version = $2,
            token_hash = $3,
            stable_message_id = $4,
            issued_at = statement_timestamp(),
            expires_at = $5,
            updated_at = statement_timestamp()
      WHERE id = $1 AND status = 'requested'`,
    [input.intentId, keyVersion, input.tokenHash, input.stableMessageId, input.expiresAt],
  );
  return result.rowCount === 1;
}

interface UsableIntentRow extends QueryResultRow {
  invitation_id: string | null;
  purpose: ActionLinkPurpose;
  recipient_email: string;
  token_hash: string;
}

export interface LockedActionIntent {
  invitationId: string | null;
  purpose: ActionLinkPurpose;
  recipientEmail: string;
}

/** Caller must keep the transaction open and mark the returned row consumed in it. */
export async function lockUsableActionIntent(
  transaction: SqlExecutor,
  input: {
    environment: string;
    intentId: string;
    purpose: ActionLinkPurpose;
    presentedTokenHash: string;
  },
): Promise<LockedActionIntent | null> {
  assertSha256Hex(input.presentedTokenHash, "presented token hash");
  const result = await transaction.query<UsableIntentRow>(
    `SELECT purpose, recipient_email, invitation_id, token_hash
       FROM app.action_link_issuance_intents
      WHERE id = $1
        AND environment = $2
        AND purpose = $3
        AND status = 'issued'
        AND expires_at > statement_timestamp()
      FOR UPDATE`,
    [input.intentId, input.environment, input.purpose],
  );
  const row = result.rows[0];
  if (row === undefined) return null;

  const expected = Buffer.from(row.token_hash, "hex");
  const presented = Buffer.from(input.presentedTokenHash, "hex");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;

  return {
    invitationId: row.invitation_id,
    purpose: row.purpose,
    recipientEmail: row.recipient_email,
  };
}

export async function markActionIntentConsumed(
  transaction: SqlExecutor,
  intentId: string,
  expected?: { invitationId?: string; purpose: ActionLinkPurpose },
): Promise<boolean> {
  const result = await transaction.query(
    `UPDATE app.action_link_issuance_intents
        SET status = 'consumed',
            consumed_at = statement_timestamp(),
            updated_at = statement_timestamp()
      WHERE id = $1
        AND status = 'issued'
        AND expires_at > statement_timestamp()
        AND ($2::text IS NULL OR purpose = $2)
        AND ($3::text IS NULL OR invitation_id = $3)`,
    [intentId, expected?.purpose ?? null, expected?.invitationId ?? null],
  );
  return result.rowCount === 1;
}

interface ClaimedOutboxRow extends QueryResultRow {
  aggregate_id: string;
  aggregate_type: string;
  aggregate_version: string;
  correlation_id: string;
  event_id: string;
  event_type: OutboxEventType;
  idempotency_key: string;
  payload: Record<string, unknown>;
}

export interface ClaimedOutboxEvent {
  aggregateId: string;
  aggregateType: string;
  aggregateVersion: string;
  correlationId: string;
  eventId: string;
  eventType: OutboxEventType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export async function claimOutboxBatch(
  pool: Pool,
  input: {
    allowedEventTypes: readonly OutboxEventType[];
    leaseSeconds: number;
    limit: number;
    workerId: string;
  },
): Promise<ClaimedOutboxEvent[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new TypeError("outbox claim limit must be between 1 and 100");
  }
  if (
    !Number.isSafeInteger(input.leaseSeconds) ||
    input.leaseSeconds < 5 ||
    input.leaseSeconds > 300
  ) {
    throw new TypeError("outbox lease must be between 5 and 300 seconds");
  }
  const allowedEventTypes = [...new Set(input.allowedEventTypes)];
  if (allowedEventTypes.length === 0) {
    throw new TypeError("outbox claim requires at least one allowed event type");
  }

  return withTransaction(pool, async (transaction) => {
    const result = await transaction.query<ClaimedOutboxRow>(
      `WITH claimable AS (
         SELECT event_id
           FROM app.outbox_events
          WHERE event_type = ANY($4::text[])
            AND (
              (status = 'pending' AND available_at <= statement_timestamp())
              OR (status = 'claimed' AND lease_expires_at <= statement_timestamp())
            )
          ORDER BY available_at, created_at, event_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE app.outbox_events AS outbox
          SET status = 'claimed',
              claimed_at = statement_timestamp(),
              claimed_by = $2,
              lease_expires_at = statement_timestamp() + make_interval(secs => $3),
              dispatch_attempts = outbox.dispatch_attempts + 1,
              updated_at = statement_timestamp()
         FROM claimable
        WHERE outbox.event_id = claimable.event_id
       RETURNING
         outbox.event_id,
         outbox.event_type,
         outbox.aggregate_type,
         outbox.aggregate_id,
         outbox.aggregate_version::text,
         outbox.idempotency_key,
         outbox.payload,
         outbox.correlation_id`,
      [input.limit, input.workerId, input.leaseSeconds, allowedEventTypes],
    );
    return result.rows.map((row) => ({
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      aggregateVersion: row.aggregate_version,
      correlationId: row.correlation_id,
      eventId: row.event_id,
      eventType: row.event_type,
      idempotencyKey: row.idempotency_key,
      payload: row.payload,
    }));
  });
}

export async function markOutboxDispatched(
  executor: SqlExecutor,
  input: { eventId: string; pgBossJobId: string; workerId: string },
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE app.outbox_events
        SET status = 'dispatched',
            pg_boss_job_id = $3,
            dispatched_at = statement_timestamp(),
            claimed_at = NULL,
            claimed_by = NULL,
            lease_expires_at = NULL,
            failure_code = NULL,
            updated_at = statement_timestamp()
      WHERE event_id = $1
        AND status = 'claimed'
        AND claimed_by = $2`,
    [input.eventId, input.workerId, input.pgBossJobId],
  );
  return result.rowCount === 1;
}

const stableCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

function assertStableCode(value: string, label: string): void {
  if (!stableCodePattern.test(value)) throw new TypeError(`${label} must be a bounded stable code`);
}

export interface DeliveryAttemptIdentity {
  attemptId: string;
  attemptNumber: number;
  outboxEventId: string;
  stableMessageId: string;
}

function assertDeliveryAttemptIdentity(input: DeliveryAttemptIdentity): void {
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new TypeError("delivery attempt number must be a positive integer");
  }
  if (!rfcMessageIdPattern.test(input.stableMessageId)) {
    throw new TypeError("stable message ID must be a bounded RFC Message-ID");
  }
}

export async function recordDeliveryAttemptStarted(
  executor: SqlExecutor,
  input: DeliveryAttemptIdentity,
): Promise<boolean> {
  assertDeliveryAttemptIdentity(input);
  const result = await executor.query(
    `INSERT INTO app.delivery_attempts (
       id, outbox_event_id, stable_message_id, attempt_number, status
     ) VALUES ($1, $2, $3, $4, 'started')
     ON CONFLICT (outbox_event_id, attempt_number) DO NOTHING`,
    [input.attemptId, input.outboxEventId, input.stableMessageId, input.attemptNumber],
  );
  return result.rowCount === 1;
}

export async function recordDeliveryAttemptAccepted(
  executor: SqlExecutor,
  input: { attemptId: string; providerReference: string | null },
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE app.delivery_attempts
        SET status = 'accepted',
            provider_reference = $2,
            finished_at = statement_timestamp()
      WHERE id = $1 AND status = 'started'`,
    [input.attemptId, input.providerReference],
  );
  return result.rowCount === 1;
}

export async function recordDeliveryAttemptFailed(
  executor: SqlExecutor,
  input: {
    attemptId: string;
    failureClass: "permanent" | "retryable";
    failureCode: string;
    providerReference?: string;
  },
): Promise<boolean> {
  assertStableCode(input.failureCode, "delivery failure code");
  const result = await executor.query(
    `UPDATE app.delivery_attempts
        SET status = $2,
            provider_reference = $3,
            failure_class = $4,
            failure_code = $5,
            finished_at = statement_timestamp()
      WHERE id = $1 AND status = 'started'`,
    [
      input.attemptId,
      input.failureClass === "retryable" ? "retryable_failure" : "permanent_failure",
      input.providerReference ?? null,
      input.failureClass,
      input.failureCode,
    ],
  );
  return result.rowCount === 1;
}

export async function recordDeliveryAttemptSkipped(
  executor: SqlExecutor,
  input: DeliveryAttemptIdentity & {
    reason: "cancelled" | "consumed" | "expired" | "missing" | "superseded";
  },
): Promise<boolean> {
  assertDeliveryAttemptIdentity(input);
  const skipCode = `INTENT_${input.reason.toUpperCase()}`;
  const result = await executor.query(
    `INSERT INTO app.delivery_attempts (
       id, outbox_event_id, stable_message_id, attempt_number,
       status, skip_code, finished_at
     ) VALUES ($1, $2, $3, $4, 'skipped', $5, statement_timestamp())
     ON CONFLICT (outbox_event_id, attempt_number) DO NOTHING`,
    [input.attemptId, input.outboxEventId, input.stableMessageId, input.attemptNumber, skipCode],
  );
  return result.rowCount === 1;
}

export async function releaseOrExhaustOutboxLease(
  executor: SqlExecutor,
  input:
    | {
        eventId: string;
        failureCode: string;
        outcome: "exhausted";
        workerId: string;
      }
    | {
        eventId: string;
        failureCode: string;
        outcome: "retry";
        retryAt: Date;
        workerId: string;
      },
): Promise<boolean> {
  assertStableCode(input.failureCode, "outbox failure code");
  const result =
    input.outcome === "retry"
      ? await executor.query(
          `UPDATE app.outbox_events
              SET status = 'pending',
                  available_at = $3,
                  claimed_at = NULL,
                  claimed_by = NULL,
                  lease_expires_at = NULL,
                  failure_code = $4,
                  updated_at = statement_timestamp()
            WHERE event_id = $1
              AND status = 'claimed'
              AND claimed_by = $2
              AND $3 > statement_timestamp()`,
          [input.eventId, input.workerId, input.retryAt, input.failureCode],
        )
      : await executor.query(
          `UPDATE app.outbox_events
              SET status = 'exhausted',
                  claimed_at = NULL,
                  claimed_by = NULL,
                  lease_expires_at = NULL,
                  exhausted_at = statement_timestamp(),
                  failure_code = $3,
                  updated_at = statement_timestamp()
            WHERE event_id = $1 AND status = 'claimed' AND claimed_by = $2`,
          [input.eventId, input.workerId, input.failureCode],
        );
  return result.rowCount === 1;
}
