import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { applicationSchema } from "./namespace.js";
import { users } from "./auth.js";
import { invitations } from "./organizations.js";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const actionLinkIssuanceIntents = applicationSchema.table(
  "action_link_issuance_intents",
  {
    id: uuid("id").primaryKey(),
    environment: text("environment").notNull(),
    purpose: text("purpose").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    callbackIdentifier: text("callback_identifier").notNull(),
    invitationId: text("invitation_id").references(() => invitations.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    status: text("status").notNull().default("requested"),
    dispatchNotAfter: timestampWithTimezone("dispatch_not_after").notNull(),
    keyVersion: text("key_version"),
    tokenHash: text("token_hash"),
    stableMessageId: text("stable_message_id"),
    requestedAt: timestampWithTimezone("requested_at").notNull().defaultNow(),
    issuedAt: timestampWithTimezone("issued_at"),
    expiresAt: timestampWithTimezone("expires_at"),
    consumedAt: timestampWithTimezone("consumed_at"),
    supersededAt: timestampWithTimezone("superseded_at"),
    cancelledAt: timestampWithTimezone("cancelled_at"),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("action_intent_stable_message_unique").on(table.stableMessageId),
    uniqueIndex("action_intent_id_invitation_unique").on(table.id, table.invitationId),
    uniqueIndex("action_intent_current_magic_recipient_unique")
      .on(table.environment, table.purpose, table.recipientEmail)
      .where(sql`${table.purpose} = 'magic_login' AND ${table.status} IN ('requested', 'issued')`),
    uniqueIndex("action_intent_current_invitation_unique")
      .on(table.invitationId)
      .where(
        sql`${table.purpose} = 'invitation_accept' AND ${table.status} IN ('requested', 'issued')`,
      ),
    index("action_intent_dispatch_index").on(table.status, table.dispatchNotAfter),
    check(
      "action_intent_environment_check",
      sql`${table.environment} IN ('development', 'test', 'staging', 'production')`,
    ),
    check(
      "action_intent_purpose_check",
      sql`${table.purpose} IN ('magic_login', 'invitation_accept')`,
    ),
    check(
      "action_intent_callback_check",
      sql`(${table.purpose} = 'magic_login' AND ${table.callbackIdentifier} = 'magic_login_callback') OR (${table.purpose} = 'invitation_accept' AND ${table.callbackIdentifier} = 'invitation_accept_callback')`,
    ),
    check(
      "action_intent_subject_check",
      sql`(${table.purpose} = 'magic_login' AND ${table.invitationId} IS NULL) OR (${table.purpose} = 'invitation_accept' AND ${table.invitationId} IS NOT NULL)`,
    ),
    check(
      "action_intent_recipient_canonical_check",
      sql`${table.recipientEmail} = lower(btrim(${table.recipientEmail})) AND ${table.recipientEmail} ~ '^[^[:space:]@]+@[^[:space:]@]+$' AND length(${table.recipientEmail}) BETWEEN 3 AND 320`,
    ),
    check(
      "action_intent_status_check",
      sql`${table.status} IN ('requested', 'issued', 'consumed', 'expired', 'superseded', 'cancelled')`,
    ),
    check(
      "action_intent_key_version_check",
      sql`${table.keyVersion} IS NULL OR ${table.keyVersion} ~ '^[A-Za-z0-9._-]{1,64}$'`,
    ),
    check(
      "action_intent_message_id_check",
      sql`${table.stableMessageId} IS NULL OR ${table.stableMessageId} ~ '^<[A-Za-z0-9._-]{1,200}@[A-Za-z0-9.-]{1,253}>$'`,
    ),
    check("action_intent_generation_check", sql`${table.generation} > 0`),
    check(
      "action_intent_dispatch_window_check",
      sql`${table.dispatchNotAfter} > ${table.requestedAt}`,
    ),
    check(
      "action_intent_hash_check",
      sql`${table.tokenHash} IS NULL OR ${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "action_intent_issued_state_check",
      sql`(${table.status} = 'requested' AND ${table.tokenHash} IS NULL AND ${table.keyVersion} IS NULL AND ${table.issuedAt} IS NULL AND ${table.expiresAt} IS NULL AND ${table.stableMessageId} IS NULL) OR (${table.status} IN ('issued', 'consumed') AND ${table.tokenHash} IS NOT NULL AND ${table.keyVersion} IS NOT NULL AND ${table.issuedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.stableMessageId} IS NOT NULL) OR (${table.status} IN ('expired', 'superseded', 'cancelled'))`,
    ),
    check(
      "action_intent_consumed_state_check",
      sql`(${table.status} = 'consumed' AND ${table.consumedAt} IS NOT NULL) OR (${table.status} <> 'consumed' AND ${table.consumedAt} IS NULL)`,
    ),
    check(
      "action_intent_superseded_state_check",
      sql`(${table.status} = 'superseded' AND ${table.supersededAt} IS NOT NULL) OR (${table.status} <> 'superseded' AND ${table.supersededAt} IS NULL)`,
    ),
    check(
      "action_intent_cancelled_state_check",
      sql`(${table.status} = 'cancelled' AND ${table.cancelledAt} IS NOT NULL) OR (${table.status} <> 'cancelled' AND ${table.cancelledAt} IS NULL)`,
    ),
    check(
      "action_intent_expiry_check",
      sql`${table.expiresAt} IS NULL OR (${table.issuedAt} IS NOT NULL AND ${table.expiresAt} > ${table.issuedAt} AND ((${table.purpose} = 'magic_login' AND ${table.expiresAt} <= ${table.requestedAt} + interval '10 minutes') OR (${table.purpose} = 'invitation_accept' AND ${table.expiresAt} <= ${table.requestedAt} + interval '7 days')))`,
    ),
  ],
);

export const outboxEvents = applicationSchema.table(
  "outbox_events",
  {
    eventId: uuid("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateVersion: bigint("aggregate_version", { mode: "number" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    correlationId: text("correlation_id").notNull(),
    status: text("status").notNull().default("pending"),
    availableAt: timestampWithTimezone("available_at").notNull().defaultNow(),
    claimedAt: timestampWithTimezone("claimed_at"),
    claimedBy: text("claimed_by"),
    leaseExpiresAt: timestampWithTimezone("lease_expires_at"),
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    pgBossJobId: text("pg_boss_job_id"),
    dispatchedAt: timestampWithTimezone("dispatched_at"),
    exhaustedAt: timestampWithTimezone("exhausted_at"),
    failureCode: text("failure_code"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("outbox_idempotency_key_unique").on(table.idempotencyKey),
    index("outbox_dispatch_index").on(table.status, table.availableAt),
    check(
      "outbox_event_type_check",
      sql`${table.eventType} IN ('magic_link.requested', 'invitation.requested', 'notification.requested', 'authorization.invalidated')`,
    ),
    check("outbox_aggregate_version_check", sql`${table.aggregateVersion} > 0`),
    check(
      "outbox_status_check",
      sql`${table.status} IN ('pending', 'claimed', 'dispatched', 'exhausted')`,
    ),
    check(
      "outbox_payload_shape_check",
      sql`jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 8192 AND NOT app.jsonb_has_forbidden_key(${table.payload}, ARRAY['token', 'url', 'body', 'key', 'secret', 'password', 'authorization', 'cookie'])`,
    ),
    check("outbox_dispatch_attempts_check", sql`${table.dispatchAttempts} >= 0`),
    check(
      "outbox_failure_code_check",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
    ),
    check(
      "outbox_claim_state_check",
      sql`(${table.status} = 'claimed' AND ${table.claimedAt} IS NOT NULL AND ${table.claimedBy} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'claimed')`,
    ),
    check(
      "outbox_terminal_state_check",
      sql`(${table.status} = 'dispatched' AND ${table.dispatchedAt} IS NOT NULL AND ${table.pgBossJobId} IS NOT NULL) OR (${table.status} = 'exhausted' AND ${table.exhaustedAt} IS NOT NULL AND ${table.failureCode} IS NOT NULL) OR (${table.status} IN ('pending', 'claimed'))`,
    ),
  ],
);

export const deliveryAttempts = applicationSchema.table(
  "delivery_attempts",
  {
    id: uuid("id").primaryKey(),
    outboxEventId: uuid("outbox_event_id")
      .notNull()
      .references(() => outboxEvents.eventId, { onDelete: "restrict" }),
    stableMessageId: text("stable_message_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(),
    providerReference: text("provider_reference"),
    failureClass: text("failure_class"),
    failureCode: text("failure_code"),
    skipCode: text("skip_code"),
    startedAt: timestampWithTimezone("started_at").notNull().defaultNow(),
    finishedAt: timestampWithTimezone("finished_at"),
  },
  (table) => [
    uniqueIndex("delivery_attempt_event_attempt_unique").on(
      table.outboxEventId,
      table.attemptNumber,
    ),
    index("delivery_attempt_status_index").on(table.status, table.startedAt),
    check("delivery_attempt_number_check", sql`${table.attemptNumber} > 0`),
    check(
      "delivery_attempt_message_id_check",
      sql`${table.stableMessageId} ~ '^<[A-Za-z0-9._-]{1,200}@[A-Za-z0-9.-]{1,253}>$'`,
    ),
    check(
      "delivery_attempt_status_check",
      sql`${table.status} IN ('started', 'accepted', 'retryable_failure', 'permanent_failure', 'skipped')`,
    ),
    check(
      "delivery_attempt_failure_check",
      sql`(${table.status} IN ('retryable_failure', 'permanent_failure') AND ${table.failureClass} IS NOT NULL AND ${table.failureCode} IS NOT NULL) OR (${table.status} NOT IN ('retryable_failure', 'permanent_failure') AND ${table.failureClass} IS NULL AND ${table.failureCode} IS NULL)`,
    ),
    check(
      "delivery_attempt_failure_class_check",
      sql`${table.failureClass} IS NULL OR ${table.failureClass} IN ('retryable', 'permanent')`,
    ),
    check(
      "delivery_attempt_failure_code_check",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
    ),
    check(
      "delivery_attempt_skip_code_check",
      sql`(${table.status} = 'skipped' AND ${table.skipCode} ~ '^[A-Z][A-Z0-9_]{0,63}$') OR (${table.status} <> 'skipped' AND ${table.skipCode} IS NULL)`,
    ),
    check(
      "delivery_attempt_finished_check",
      sql`(${table.status} = 'started' AND ${table.finishedAt} IS NULL) OR (${table.status} <> 'started' AND ${table.finishedAt} IS NOT NULL)`,
    ),
  ],
);

export const operationIdempotency = applicationSchema.table(
  "operation_idempotency",
  {
    id: uuid("id").primaryKey(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("in_progress"),
    resultReference: text("result_reference"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    completedAt: timestampWithTimezone("completed_at"),
  },
  (table) => [
    uniqueIndex("operation_idempotency_actor_key_unique").on(
      table.actorUserId,
      table.operation,
      table.idempotencyKey,
    ),
    check("operation_idempotency_hash_check", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "operation_idempotency_status_check",
      sql`${table.status} IN ('in_progress', 'completed', 'failed')`,
    ),
    check(
      "operation_idempotency_completion_check",
      sql`(${table.status} = 'completed' AND ${table.resultReference} IS NOT NULL AND ${table.completedAt} IS NOT NULL) OR (${table.status} <> 'completed')`,
    ),
  ],
);
