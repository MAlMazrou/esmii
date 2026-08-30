import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { actionLinkIssuanceIntents } from "./delivery.js";
import { applicationSchema } from "./namespace.js";
import { invitations, members, organizations } from "./organizations.js";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const securityTombstoneMutations = applicationSchema.table(
  "security_tombstone_mutations",
  {
    eventId: uuid("event_id").primaryKey(),
    environment: text("environment").notNull(),
    operation: text("operation").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeDigest: text("scope_digest").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "restrict" }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    membershipId: text("membership_id").references(() => members.id, { onDelete: "restrict" }),
    accountId: text("account_id"),
    prepareSequence: bigint("prepare_sequence", { mode: "number" }).notNull(),
    resolutionSequence: bigint("resolution_sequence", { mode: "number" }),
    status: text("status").notNull().default("prepared"),
    preparedAt: timestampWithTimezone("prepared_at").notNull(),
    localAppliedAt: timestampWithTimezone("local_applied_at"),
    resolvedAt: timestampWithTimezone("resolved_at"),
    failureCode: text("failure_code"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("tombstone_status_prepared_index").on(table.status, table.preparedAt),
    index("tombstone_organization_index").on(table.organizationId, table.prepareSequence),
    uniqueIndex("tombstone_environment_prepare_sequence_unique").on(
      table.environment,
      table.prepareSequence,
    ),
    check(
      "tombstone_environment_check",
      sql`${table.environment} IN ('development', 'test', 'staging', 'production')`,
    ),
    check(
      "tombstone_scope_kind_check",
      sql`${table.scopeKind} IN ('user', 'account', 'provider', 'membership', 'ownership', 'organization')`,
    ),
    check("tombstone_scope_digest_check", sql`${table.scopeDigest} ~ '^[0-9a-f]{64}$'`),
    check("tombstone_prepare_sequence_check", sql`${table.prepareSequence} > 0`),
    check(
      "tombstone_resolution_sequence_check",
      sql`${table.resolutionSequence} IS NULL OR ${table.resolutionSequence} > ${table.prepareSequence}`,
    ),
    check(
      "tombstone_status_check",
      sql`${table.status} IN ('prepared', 'local_applied', 'committed', 'cancelled')`,
    ),
    check(
      "tombstone_state_timestamp_check",
      sql`(${table.status} = 'prepared' AND ${table.localAppliedAt} IS NULL AND ${table.resolvedAt} IS NULL AND ${table.resolutionSequence} IS NULL AND ${table.failureCode} IS NULL) OR (${table.status} = 'local_applied' AND ${table.localAppliedAt} IS NOT NULL AND ${table.resolvedAt} IS NULL AND ${table.resolutionSequence} IS NULL AND ${table.failureCode} IS NULL) OR (${table.status} = 'committed' AND ${table.localAppliedAt} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.resolutionSequence} IS NOT NULL AND ${table.failureCode} IS NULL) OR (${table.status} = 'cancelled' AND ${table.localAppliedAt} IS NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.resolutionSequence} IS NOT NULL AND ${table.failureCode} IS NOT NULL)`,
    ),
  ],
);

export const securityTombstoneState = applicationSchema.table(
  "security_tombstone_state",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    environment: text("environment").notNull(),
    epoch: uuid("epoch").notNull(),
    contiguousHighWater: bigint("contiguous_high_water", { mode: "number" }).notNull().default(0),
    accessClosed: boolean("access_closed").notNull().default(false),
    closureReason: text("closure_reason"),
    version: integer("version").notNull().default(1),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("tombstone_state_singleton_check", sql`${table.singleton}`),
    check(
      "tombstone_state_environment_check",
      sql`${table.environment} IN ('development', 'test', 'staging', 'production')`,
    ),
    check("tombstone_high_water_check", sql`${table.contiguousHighWater} >= 0`),
    check("tombstone_state_version_check", sql`${table.version} > 0`),
    check(
      "tombstone_closure_reason_check",
      sql`(${table.accessClosed} AND ${table.closureReason} IS NOT NULL) OR (NOT ${table.accessClosed} AND ${table.closureReason} IS NULL)`,
    ),
  ],
);

export const invitationContinuations = applicationSchema.table(
  "invitation_continuations",
  {
    id: uuid("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "restrict" }),
    actionIntentId: uuid("action_intent_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    consumedAt: timestampWithTimezone("consumed_at"),
  },
  (table) => [
    uniqueIndex("invitation_continuation_action_intent_unique").on(table.actionIntentId),
    index("invitation_continuation_invitation_index").on(table.invitationId),
    foreignKey({
      columns: [table.actionIntentId, table.invitationId],
      foreignColumns: [actionLinkIssuanceIntents.id, actionLinkIssuanceIntents.invitationId],
      name: "invitation_continuation_exact_intent_fk",
    }).onDelete("restrict"),
    check("invitation_continuation_hash_check", sql`${table.secretHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "invitation_continuation_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
    check(
      "invitation_continuation_consumed_check",
      sql`${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.createdAt} AND ${table.consumedAt} <= ${table.expiresAt})`,
    ),
  ],
);
