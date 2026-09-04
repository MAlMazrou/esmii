import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OperatorDatabase = DatabaseSync;

export const OPERATOR_AUDIT_MAX_ROWS = 20_000;
export const OPERATOR_RATE_LIMIT_MAX_ROWS = 20_000;
export const OPERATOR_RATE_LIMIT_MAX_WINDOW_SECONDS = 15 * 60;
const OPERATOR_AUDIT_WAL_PAGES = 256;

export interface OperatorRateLimitStorage {
  readonly consume: (
    key: string,
    rule: Readonly<{ max: number; window: number }>,
  ) => Promise<{ readonly allowed: boolean; readonly retryAfter: number | null }>;
}

const validatedRateLimitSchemas = new WeakSet<OperatorDatabase>();

function requireRateLimitSchema(database: OperatorDatabase): void {
  if (validatedRateLimitSchemas.has(database)) return;
  const columns = database.prepare('PRAGMA table_info("rateLimit")').all() as Array<{
    readonly name: string;
    readonly notnull: number;
  }>;
  const required = new Set(["id", "key", "count", "lastRequest"]);
  if (
    columns.length === 0 ||
    [...required].some(
      (name) => !columns.some((column) => column.name === name && column.notnull === 1),
    )
  ) {
    throw new Error("The operator rate-limit table is absent or incompatible");
  }

  const indexes = database.prepare('PRAGMA index_list("rateLimit")').all() as Array<{
    readonly name: string;
    readonly unique: number;
  }>;
  const hasUniqueKey = indexes.some((index) => {
    if (index.unique !== 1 || !/^[A-Za-z0-9_]+$/u.test(index.name)) return false;
    const fields = database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
      readonly name: string;
    }>;
    return fields.length === 1 && fields[0]?.name === "key";
  });
  if (!hasUniqueKey) {
    throw new Error("The operator rate-limit key must have a unique database index");
  }
  validatedRateLimitSchemas.add(database);
}

function validateRateLimitInput(
  key: string,
  rule: Readonly<{ max: number; window: number }>,
): boolean {
  const containsControlCharacter = [...key].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  return (
    key.length > 0 &&
    key.length <= 512 &&
    !containsControlCharacter &&
    Number.isSafeInteger(rule.max) &&
    rule.max > 0 &&
    rule.max <= 1_000 &&
    Number.isSafeInteger(rule.window) &&
    rule.window > 0 &&
    rule.window <= OPERATOR_RATE_LIMIT_MAX_WINDOW_SECONDS
  );
}

/**
 * Better Auth's stock database limiter retains every brand-new key until that
 * same key is used after expiry. This bounded adapter keeps active limits
 * intact, prunes only globally expired rows, and refuses new keys at capacity.
 */
export function createOperatorRateLimitStorage(
  database: OperatorDatabase,
): OperatorRateLimitStorage {
  return {
    async consume(key, rule) {
      if (!validateRateLimitInput(key, rule)) {
        return { allowed: false, retryAfter: OPERATOR_RATE_LIMIT_MAX_WINDOW_SECONDS };
      }
      requireRateLimitSchema(database);
      const now = Date.now();
      const windowMilliseconds = rule.window * 1_000;
      let transactionOpen = false;
      try {
        database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        database
          .prepare('DELETE FROM "rateLimit" WHERE "lastRequest" < ?')
          .run(now - OPERATOR_RATE_LIMIT_MAX_WINDOW_SECONDS * 1_000);
        const current = database
          .prepare('SELECT "count", "lastRequest" FROM "rateLimit" WHERE "key" = ?')
          .get(key) as { readonly count: number; readonly lastRequest: number } | undefined;

        let result: { readonly allowed: boolean; readonly retryAfter: number | null };
        if (current === undefined) {
          const total = database.prepare('SELECT count(*) AS value FROM "rateLimit"').get() as {
            readonly value: number;
          };
          if (!Number.isSafeInteger(total.value) || total.value < 0) {
            throw new Error("The operator rate-limit row count is invalid");
          }
          if (total.value >= OPERATOR_RATE_LIMIT_MAX_ROWS) {
            result = {
              allowed: false,
              retryAfter: OPERATOR_RATE_LIMIT_MAX_WINDOW_SECONDS,
            };
          } else {
            database
              .prepare(
                'INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?, ?, 1, ?)',
              )
              .run(randomUUID(), key, now);
            result = { allowed: true, retryAfter: null };
          }
        } else {
          if (
            !Number.isSafeInteger(current.count) ||
            current.count < 0 ||
            !Number.isSafeInteger(current.lastRequest) ||
            current.lastRequest < 0
          ) {
            throw new Error("The operator rate-limit row is invalid");
          }
          if (now - current.lastRequest >= windowMilliseconds) {
            database
              .prepare('UPDATE "rateLimit" SET "count" = 1, "lastRequest" = ? WHERE "key" = ?')
              .run(now, key);
            result = { allowed: true, retryAfter: null };
          } else if (current.count >= rule.max) {
            result = {
              allowed: false,
              retryAfter: Math.max(
                1,
                Math.ceil((current.lastRequest + windowMilliseconds - now) / 1_000),
              ),
            };
          } else {
            database
              .prepare(
                'UPDATE "rateLimit" SET "count" = "count" + 1, "lastRequest" = ? WHERE "key" = ?',
              )
              .run(now, key);
            result = { allowed: true, retryAfter: null };
          }
        }
        database.exec("COMMIT");
        transactionOpen = false;
        return result;
      } catch (error) {
        if (transactionOpen) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // Preserve the original fail-closed storage error.
          }
        }
        throw error;
      }
    },
  };
}

export function openOperatorDatabase(filePath: string): OperatorDatabase {
  mkdirSync(dirname(filePath), { mode: 0o700, recursive: true });
  const database = new DatabaseSync(filePath, { timeout: 5_000 });
  chmodSync(filePath, 0o600);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA journal_size_limit = 1048576");
  database.exec(`PRAGMA wal_autocheckpoint = ${OPERATOR_AUDIT_WAL_PAGES}`);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS operator_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      subject_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS operator_audit_created_at_idx
      ON operator_audit(created_at);
    CREATE TABLE IF NOT EXISTS operator_security_state (
      user_id TEXT PRIMARY KEY,
      password_changed INTEGER NOT NULL DEFAULT 0 CHECK(password_changed IN (0, 1)),
      totp_enrollment_verified INTEGER NOT NULL DEFAULT 0 CHECK(totp_enrollment_verified IN (0, 1)),
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  return database;
}

export function writeOperatorAudit(
  database: OperatorDatabase,
  event: {
    readonly action: string;
    readonly outcome: string;
    readonly requestId: string;
    readonly subjectId?: string | null;
  },
): void {
  const inserted = database
    .prepare(
      `INSERT INTO operator_audit(created_at, request_id, action, outcome, subject_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      event.requestId.slice(0, 96),
      event.action.slice(0, 64),
      event.outcome.slice(0, 64),
      event.subjectId?.slice(0, 128) ?? null,
    );
  const insertedId = Number(inserted.lastInsertRowid);
  database
    .prepare("DELETE FROM operator_audit WHERE created_at < ? OR id <= ?")
    .run(
      new Date(Date.now() - 30 * 86_400_000).toISOString(),
      Math.max(0, insertedId - OPERATOR_AUDIT_MAX_ROWS),
    );
  if (insertedId % OPERATOR_AUDIT_WAL_PAGES === 0) {
    database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
}

export interface OperatorSecurityState {
  readonly passwordChanged: boolean;
  readonly totpEnrollmentVerified: boolean;
}

export function readOperatorSecurityState(
  database: OperatorDatabase,
  userId: string,
): OperatorSecurityState | null {
  const row = database
    .prepare(
      `SELECT password_changed AS passwordChanged,
              totp_enrollment_verified AS totpEnrollmentVerified
       FROM operator_security_state WHERE user_id = ?`,
    )
    .get(userId) as
    { readonly passwordChanged: number; readonly totpEnrollmentVerified: number } | undefined;
  return row === undefined
    ? null
    : {
        passwordChanged: row.passwordChanged === 1,
        totpEnrollmentVerified: row.totpEnrollmentVerified === 1,
      };
}

export function writeOperatorSecurityState(
  database: OperatorDatabase,
  userId: string,
  state: Partial<OperatorSecurityState>,
): void {
  const current = readOperatorSecurityState(database, userId) ?? {
    passwordChanged: false,
    totpEnrollmentVerified: false,
  };
  database
    .prepare(
      `INSERT INTO operator_security_state(
         user_id, password_changed, totp_enrollment_verified, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         password_changed = excluded.password_changed,
         totp_enrollment_verified = excluded.totp_enrollment_verified,
         updated_at = excluded.updated_at`,
    )
    .run(
      userId,
      (state.passwordChanged ?? current.passwordChanged) ? 1 : 0,
      (state.totpEnrollmentVerified ?? current.totpEnrollmentVerified) ? 1 : 0,
      new Date().toISOString(),
    );
}

export function revokeOperatorSessions(database: OperatorDatabase, userId: string): number {
  return Number(database.prepare('DELETE FROM "session" WHERE userId = ?').run(userId).changes);
}
