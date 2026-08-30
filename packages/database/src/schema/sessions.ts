import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { applicationSchema } from "./namespace.js";
import { organizations } from "./organizations.js";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const sessions = applicationSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestampWithTimezone("expiresAt").notNull(),
    token: text("token").notNull(),
    createdAt: timestampWithTimezone("createdAt").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updatedAt").notNull().defaultNow(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrganizationId: text("activeOrganizationId").references(() => organizations.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("session_token_unique").on(table.token),
    index("session_user_expiry_index").on(table.userId, table.expiresAt),
    index("session_active_organization_index").on(table.activeOrganizationId),
    check("session_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);
