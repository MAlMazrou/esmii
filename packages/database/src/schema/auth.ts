import { sql } from "drizzle-orm";
import { boolean, check, index, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { applicationSchema } from "./namespace.js";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const users = applicationSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    image: text("image"),
    createdAt: timestampWithTimezone("createdAt").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updatedAt").notNull().defaultNow(),
    status: text("status").notNull().default("active"),
    statusChangedAt: timestampWithTimezone("statusChangedAt").notNull().defaultNow(),
    authorizationVersion: integer("authorizationVersion").notNull().default(1),
  },
  (table) => [
    uniqueIndex("user_email_unique").on(table.email),
    check(
      "user_email_canonical_check",
      sql`${table.email} = lower(btrim(${table.email})) AND ${table.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$' AND length(${table.email}) BETWEEN 3 AND 320`,
    ),
    check("user_status_check", sql`${table.status} IN ('active', 'disabled', 'deleted')`),
    check("user_authorization_version_check", sql`${table.authorizationVersion} > 0`),
  ],
);

export const accounts = applicationSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestampWithTimezone("accessTokenExpiresAt"),
    refreshTokenExpiresAt: timestampWithTimezone("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestampWithTimezone("createdAt").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("account_issuer_identity_unique").on(table.issuer, table.accountId),
    index("account_user_id_index").on(table.userId),
    check("account_password_disabled_check", sql`${table.password} IS NULL`),
  ],
);

export const verifications = applicationSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestampWithTimezone("expiresAt").notNull(),
    createdAt: timestampWithTimezone("createdAt").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updatedAt").notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_index").on(table.identifier)],
);
