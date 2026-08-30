import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { applicationSchema } from "./namespace.js";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const organizations = applicationSchema.table(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: timestampWithTimezone("createdAt").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updatedAt").defaultNow(),
    deletedAt: timestampWithTimezone("deletedAt"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("organization_slug_unique").on(table.slug),
    check(
      "organization_name_check",
      sql`length(btrim(${table.name})) BETWEEN 1 AND 120 AND ${table.name} = btrim(${table.name})`,
    ),
    check(
      "organization_slug_normalized_check",
      sql`${table.slug} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    check("organization_version_check", sql`${table.version} > 0`),
  ],
);

export const members = applicationSchema.table(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: text("role").notNull().default("member"),
    createdAt: timestampWithTimezone("createdAt").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updatedAt").notNull().defaultNow(),
    status: text("status").notNull().default("active"),
    removedAt: timestampWithTimezone("removedAt"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("member_organization_user_unique").on(table.organizationId, table.userId),
    index("member_user_status_index").on(table.userId, table.status),
    index("member_organization_role_status_index").on(
      table.organizationId,
      table.role,
      table.status,
    ),
    check("member_role_check", sql`${table.role} IN ('owner', 'editor', 'member')`),
    check("member_status_check", sql`${table.status} IN ('active', 'removed', 'disabled')`),
    check(
      "member_removed_at_check",
      sql`(${table.status} = 'active' AND ${table.removedAt} IS NULL) OR (${table.status} <> 'active' AND ${table.removedAt} IS NOT NULL)`,
    ),
    check("member_version_check", sql`${table.version} > 0`),
  ],
);

export const invitations = applicationSchema.table(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestampWithTimezone("expiresAt").notNull(),
    createdAt: timestampWithTimezone("createdAt").notNull().defaultNow(),
    inviterId: text("inviterId")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestampWithTimezone("updatedAt").notNull().defaultNow(),
    acceptedAt: timestampWithTimezone("acceptedAt"),
    revokedAt: timestampWithTimezone("revokedAt"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("invitation_one_pending_per_recipient")
      .on(table.organizationId, table.email)
      .where(sql`${table.status} = 'pending'`),
    index("invitation_recipient_status_index").on(table.email, table.status),
    check(
      "invitation_email_canonical_check",
      sql`${table.email} = lower(btrim(${table.email})) AND ${table.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$' AND length(${table.email}) BETWEEN 3 AND 320`,
    ),
    check("invitation_role_check", sql`${table.role} IN ('editor', 'member')`),
    check(
      "invitation_status_check",
      sql`${table.status} IN ('pending', 'accepted', 'rejected', 'canceled', 'revoked', 'expired')`,
    ),
    check(
      "invitation_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
    ),
    check(
      "invitation_resolution_timestamp_check",
      sql`(${table.status} = 'accepted' AND ${table.acceptedAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.status} IN ('rejected', 'canceled', 'revoked') AND ${table.revokedAt} IS NOT NULL AND ${table.acceptedAt} IS NULL) OR (${table.status} IN ('pending', 'expired') AND ${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL)`,
    ),
    check("invitation_version_check", sql`${table.version} > 0`),
  ],
);
