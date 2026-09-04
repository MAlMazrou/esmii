import { randomUUID } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOperatorRateLimitStorage,
  openOperatorDatabase,
  OPERATOR_AUDIT_MAX_ROWS,
  OPERATOR_RATE_LIMIT_MAX_ROWS,
  readOperatorSecurityState,
  revokeOperatorSessions,
  writeOperatorAudit,
  writeOperatorSecurityState,
} from "../lib/auth/database.ts";
import {
  buildOperatorAuthOptions,
  isPublicOperatorAuthRequestAllowed,
  normalizeOperatorPasswordChangeBody,
  normalizeOperatorSignInBody,
  normalizeOperatorTotpBody,
  OPERATOR_AUTH_BODY_LIMIT_BYTES,
  OPERATOR_SESSION_SECONDS,
  projectGenericAuthFailure,
  projectTokenFreeAuthSuccess,
  readBoundedOperatorAuthBody,
} from "../lib/auth/server.ts";
import type { DashboardAuthConfig } from "../lib/config/server.ts";

const files: string[] = [];

afterEach(() => {
  for (const file of files.splice(0)) {
    try {
      unlinkSync(file);
    } catch {
      /* SQLite sidecars may already be gone. */
    }
  }
});

function databaseFile(): string {
  const file = join(tmpdir(), `esmii-dashboard-auth-${randomUUID()}.sqlite`);
  files.push(file, `${file}-shm`, `${file}-wal`);
  return file;
}

const CONFIG: DashboardAuthConfig = {
  databaseFile: "/private/tmp/test.sqlite",
  environment: "production",
  origin: "https://dashboard.esmii.app",
  peerOrigin: "https://staging-dashboard.esmii.app",
  secret: "test-only-secret-material-with-more-than-thirty-two-characters",
  themeFixture: null,
};

describe("operator authentication boundary", () => {
  it("caps auth bodies before JSON parsing and strips trusted-device requests", async () => {
    const validRequest = new Request(
      "https://dashboard.esmii.app/api/operator-auth/two-factor/verify-totp",
      {
        body: JSON.stringify({ code: "123456", trustDevice: true }),
        method: "POST",
      },
    );
    const validBody = await readBoundedOperatorAuthBody(validRequest);
    expect(JSON.parse(new TextDecoder().decode(normalizeOperatorTotpBody(validBody)))).toEqual({
      code: "123456",
      trustDevice: false,
    });

    const oversized = new Request(
      "https://dashboard.esmii.app/api/operator-auth/two-factor/verify-totp",
      {
        body: "x".repeat(OPERATOR_AUTH_BODY_LIMIT_BYTES + 1),
        method: "POST",
      },
    );
    expect(await readBoundedOperatorAuthBody(oversized)).toBeNull();
    expect(JSON.parse(new TextDecoder().decode(normalizeOperatorTotpBody(null)))).toEqual({
      code: "",
      trustDevice: false,
    });
  });

  it("forces remembered sign-in so TOTP cannot inherit Better Auth's 24-hour temporary session", () => {
    const attackerBody = new TextEncoder().encode(
      JSON.stringify({
        callbackURL: "https://attacker.invalid/",
        email: "operator@example.test",
        password: "temporary-password",
        rememberMe: false,
      }),
    );
    expect(JSON.parse(new TextDecoder().decode(normalizeOperatorSignInBody(attackerBody)))).toEqual(
      {
        email: "operator@example.test",
        password: "temporary-password",
        rememberMe: true,
      },
    );
    expect(JSON.parse(new TextDecoder().decode(normalizeOperatorSignInBody(null)))).toEqual({
      email: "",
      password: "",
      rememberMe: true,
    });
  });

  it("rejects password reuse and forces revocation of other sessions", () => {
    const samePassword = new TextEncoder().encode(
      JSON.stringify({
        currentPassword: "same-password-value",
        newPassword: "same-password-value",
        revokeOtherSessions: false,
      }),
    );
    expect(
      JSON.parse(new TextDecoder().decode(normalizeOperatorPasswordChangeBody(samePassword))),
    ).toEqual({ currentPassword: "", newPassword: "", revokeOtherSessions: true });

    const valid = new TextEncoder().encode(
      JSON.stringify({
        callbackURL: "https://attacker.invalid/",
        currentPassword: "test-temporary-password-value",
        newPassword: "test-different-permanent-password",
        revokeOtherSessions: false,
      }),
    );
    expect(
      JSON.parse(new TextDecoder().decode(normalizeOperatorPasswordChangeBody(valid))),
    ).toEqual({
      currentPassword: "test-temporary-password-value",
      newPassword: "test-different-permanent-password",
      revokeOtherSessions: true,
    });
  });

  it("rejects an oversized declared body without consuming it", async () => {
    const request = new Request("https://dashboard.esmii.app/api/operator-auth/sign-in/email", {
      body: "{}",
      headers: { "content-length": String(OPERATOR_AUTH_BODY_LIMIT_BYTES + 1) },
      method: "POST",
    });
    expect(await readBoundedOperatorAuthBody(request)).toBeNull();
    expect(request.bodyUsed).toBe(false);
  });

  it("exposes only sign-in, TOTP, bootstrap change, and sign-out", () => {
    expect(isPublicOperatorAuthRequestAllowed("POST", "/api/operator-auth/sign-in/email")).toBe(
      true,
    );
    expect(
      isPublicOperatorAuthRequestAllowed("POST", "/api/operator-auth/two-factor/verify-totp"),
    ).toBe(true);
    expect(isPublicOperatorAuthRequestAllowed("GET", "/api/operator-auth/get-session")).toBe(false);
    expect(isPublicOperatorAuthRequestAllowed("POST", "/api/operator-auth/sign-up/email")).toBe(
      false,
    );
    expect(
      isPublicOperatorAuthRequestAllowed("POST", "/api/operator-auth/request-password-reset"),
    ).toBe(false);
    expect(
      isPublicOperatorAuthRequestAllowed(
        "POST",
        "/api/operator-auth/two-factor/verify-backup-code",
      ),
    ).toBe(false);
    expect(
      isPublicOperatorAuthRequestAllowed("POST", "/api/operator-auth/two-factor/disable"),
    ).toBe(false);
  });

  it("projects successful auth responses without exposing Better Auth tokens", async () => {
    const upstream = Response.json(
      {
        session: { token: "test-nested-session-token" },
        token: "test-top-level-session-token",
        user: { email: "operator@example.test" },
      },
      {
        headers: {
          "set-cookie":
            "esmii-dashboard-production.session_token=opaque; Path=/; HttpOnly; Secure; SameSite=Strict",
        },
      },
    );
    const response = projectTokenFreeAuthSuccess(
      upstream,
      "POST /two-factor/verify-totp",
      "request-1",
    );
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toBe('{"authenticated":true}');
    expect(serialized).not.toContain("token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("maps Better Auth's bounded limiter delay to the standard Retry-After header", async () => {
    const response = projectGenericAuthFailure(
      new Response("limited", { headers: { "x-retry-after": "37" }, status: 429 }),
      "request-2",
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(response.headers.get("x-retry-after")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        code: "AUTHENTICATION_FAILED",
        message: "Authentication failed",
        requestId: "request-2",
      },
    });
    expect(
      projectGenericAuthFailure(
        new Response("limited", { headers: { "x-retry-after": "9999" }, status: 429 }),
        "request-3",
      ).headers.get("retry-after"),
    ).toBeNull();
  });

  it("uses environment-prefixed host cookies, eight-hour DB sessions, and DB rate limits", () => {
    const file = databaseFile();
    const database = openOperatorDatabase(file);
    const options = buildOperatorAuthOptions(CONFIG, database);
    expect(
      options.advanced && "cookiePrefix" in options.advanced ? options.advanced.cookiePrefix : null,
    ).toBe("esmii-dashboard-production");
    expect(options.session?.expiresIn).toBe(OPERATOR_SESSION_SECONDS);
    expect(options.session?.disableSessionRefresh).toBe(true);
    expect(options.rateLimit?.storage).toBe("database");
    expect(options.rateLimit?.customStorage).toBeDefined();
    expect(options.rateLimit?.customRules?.["/sign-in/email"]).toEqual({ max: 5, window: 900 });
    expect(options.emailAndPassword?.disableSignUp).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    database.close();
  });

  it("requires both TOTP enrollment and temporary-password replacement", () => {
    const database = openOperatorDatabase(databaseFile());
    writeOperatorSecurityState(database, "operator-1", { totpEnrollmentVerified: true });
    expect(readOperatorSecurityState(database, "operator-1")).toEqual({
      passwordChanged: false,
      totpEnrollmentVerified: true,
    });
    writeOperatorSecurityState(database, "operator-1", { passwordChanged: true });
    expect(readOperatorSecurityState(database, "operator-1")).toEqual({
      passwordChanged: true,
      totpEnrollmentVerified: true,
    });
    database.close();
  });

  it("keeps staging and production cookies and security state isolated", () => {
    const stagingFile = databaseFile();
    const productionFile = databaseFile();
    const staging = openOperatorDatabase(stagingFile);
    const production = openOperatorDatabase(productionFile);
    const stagingOptions = buildOperatorAuthOptions(
      {
        ...CONFIG,
        databaseFile: stagingFile,
        environment: "staging",
        origin: "https://staging-dashboard.esmii.app",
        peerOrigin: "https://dashboard.esmii.app",
      },
      staging,
    );
    const productionOptions = buildOperatorAuthOptions(
      { ...CONFIG, databaseFile: productionFile },
      production,
    );
    expect(
      stagingOptions.advanced && "cookiePrefix" in stagingOptions.advanced
        ? stagingOptions.advanced.cookiePrefix
        : null,
    ).toBe("esmii-dashboard-staging");
    expect(
      productionOptions.advanced && "cookiePrefix" in productionOptions.advanced
        ? productionOptions.advanced.cookiePrefix
        : null,
    ).toBe("esmii-dashboard-production");
    writeOperatorSecurityState(staging, "same-operator-id", {
      passwordChanged: true,
      totpEnrollmentVerified: true,
    });
    expect(readOperatorSecurityState(staging, "same-operator-id")?.passwordChanged).toBe(true);
    expect(readOperatorSecurityState(production, "same-operator-id")).toBeNull();
    staging.close();
    production.close();
  });

  it("revokes every persisted session for only the selected operator", () => {
    const database = openOperatorDatabase(databaseFile());
    database.exec('CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT NOT NULL) STRICT');
    const insert = database.prepare('INSERT INTO "session"(id, userId) VALUES (?, ?)');
    insert.run("s1", "operator-1");
    insert.run("s2", "operator-1");
    insert.run("s3", "operator-2");
    expect(revokeOperatorSessions(database, "operator-1")).toBe(2);
    expect(
      database
        .prepare('SELECT count(*) AS count FROM "session" WHERE userId = ?')
        .get("operator-1"),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare('SELECT count(*) AS count FROM "session" WHERE userId = ?')
        .get("operator-2"),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("bounds the 30-day operator audit by age and a hard row ceiling", () => {
    const database = openOperatorDatabase(databaseFile());
    const insert = database.prepare(
      `INSERT INTO operator_audit(created_at, request_id, action, outcome, subject_id)
       VALUES (?, ?, ?, ?, NULL)`,
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      insert.run("2020-01-01T00:00:00.000Z", "expired", "sign-in", "rejected");
      const currentTimestamp = new Date().toISOString();
      for (let index = 0; index < OPERATOR_AUDIT_MAX_ROWS + 50; index += 1) {
        insert.run(currentTimestamp, `request-${index}`, "sign-in", "rejected");
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    writeOperatorAudit(database, {
      action: "sign-in",
      outcome: "success",
      requestId: "latest",
    });
    const count = database.prepare("SELECT count(*) AS count FROM operator_audit").get() as {
      readonly count: number;
    };
    expect(count.count).toBe(OPERATOR_AUDIT_MAX_ROWS);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM operator_audit WHERE request_id = ?")
        .get("expired"),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM operator_audit WHERE request_id = ?")
        .get("latest"),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("bounds unique active rate-limit keys without weakening an existing limit", async () => {
    const database = openOperatorDatabase(databaseFile());
    database.exec(`
      CREATE TABLE "rateLimit" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "key" TEXT NOT NULL UNIQUE,
        "count" INTEGER NOT NULL,
        "lastRequest" INTEGER NOT NULL
      ) STRICT
    `);
    const now = Date.now();
    const insert = database.prepare(
      'INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?, ?, ?, ?)',
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < OPERATOR_RATE_LIMIT_MAX_ROWS; index += 1) {
        insert.run(randomUUID(), `active-${index}`, index === 0 ? 2 : 1, now);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const storage = createOperatorRateLimitStorage(database);
    await expect(storage.consume("new-key", { max: 5, window: 900 })).resolves.toEqual({
      allowed: false,
      retryAfter: 900,
    });
    await expect(storage.consume("active-0", { max: 5, window: 900 })).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(
      database.prepare('SELECT "count" FROM "rateLimit" WHERE "key" = ?').get("active-0"),
    ).toEqual({ count: 3 });

    database
      .prepare('UPDATE "rateLimit" SET "lastRequest" = ? WHERE "key" = ?')
      .run(now - 901_000, "active-1");
    await expect(storage.consume("new-key", { max: 5, window: 900 })).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(database.prepare('SELECT count(*) AS "count" FROM "rateLimit"').get()).toEqual({
      count: OPERATOR_RATE_LIMIT_MAX_ROWS,
    });
    expect(
      database
        .prepare('SELECT count(*) AS "count" FROM "rateLimit" WHERE "key" = ?')
        .get("active-1"),
    ).toEqual({ count: 0 });
    database.close();
  });
});
