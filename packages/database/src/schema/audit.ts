import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { applicationSchema } from "./namespace.js";
import { organizations } from "./organizations.js";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const auditEvents = applicationSchema.table(
  "audit_events",
  {
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity(),
    eventId: uuid("event_id").primaryKey(),
    occurredAt: timestampWithTimezone("occurred_at").notNull().defaultNow(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    result: text("result").notNull(),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    uniqueIndex("audit_sequence_unique").on(table.sequence),
    index("audit_organization_sequence_index").on(table.organizationId, table.sequence),
    index("audit_actor_sequence_index").on(table.actorUserId, table.sequence),
    check("audit_action_check", sql`${table.action} ~ '^[a-z][a-z0-9_.]{1,127}$'`),
    check("audit_target_type_check", sql`${table.targetType} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check("audit_result_check", sql`${table.result} IN ('success', 'denied', 'failed')`),
    check(
      "audit_metadata_shape_check",
      sql`jsonb_typeof(${table.metadata}) = 'object' AND octet_length(${table.metadata}::text) <= 4096 AND NOT app.jsonb_has_forbidden_key(${table.metadata}, ARRAY['token', 'url', 'body', 'key', 'secret', 'password', 'authorization', 'cookie', 'claims'])`,
    ),
  ],
);
