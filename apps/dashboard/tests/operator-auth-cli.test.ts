import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runOperatorCommand(
  command: "provision" | "retarget",
  environment: Readonly<Record<string, string>>,
): void {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      resolve(import.meta.dirname, "../scripts/operator-auth.ts"),
      command,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...environment },
      timeout: 30_000,
    },
  );
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
}

describe("operator auth CLI", () => {
  it("retargets the sole operator, revokes sessions, and emits only protected bootstrap material", () => {
    const directory = mkdtempSync(join(tmpdir(), "esmii-operator-cli-"));
    temporaryDirectories.push(directory);
    const databaseFile = join(directory, "auth.sqlite");
    const secretFile = join(directory, "auth-secret");
    const emailFile = join(directory, "operator-email");
    const firstBootstrap = join(directory, "first-bootstrap");
    const secondBootstrap = join(directory, "second-bootstrap");
    const captureFile = join(directory, "otp-capture");
    writeFileSync(secretFile, `${"s".repeat(64)}\n`, { mode: 0o600 });
    writeFileSync(emailFile, "first-operator@example.invalid\n", { mode: 0o600 });

    const baseEnvironment = {
      DASHBOARD_AUTH_DATABASE_FILE: databaseFile,
      DASHBOARD_AUTH_SECRET_FILE: secretFile,
      DASHBOARD_EMAIL_OTP_CAPTURE_FILE: captureFile,
      DASHBOARD_ENVIRONMENT: "staging",
      DASHBOARD_OPERATOR_EMAIL_FILE: emailFile,
      DASHBOARD_ORIGIN: "http://127.0.0.1:3111",
      DASHBOARD_PEER_ORIGIN: "http://127.0.0.1:3112",
      MONITORING_FIXTURE_MODE: "true",
      NODE_ENV: "test",
    };
    runOperatorCommand("provision", {
      ...baseEnvironment,
      DASHBOARD_OPERATOR_BOOTSTRAP_OUTPUT_FILE: firstBootstrap,
    });
    const first = readFileSync(firstBootstrap, "utf8");
    expect(first).toContain("operator_email=first-operator@example.invalid");
    expect(first).toContain("second_factor=email_otp");
    expect(statSync(firstBootstrap).mode & 0o777).toBe(0o600);

    const database = new DatabaseSync(databaseFile);
    const user = database.prepare('SELECT id FROM "user"').get() as { readonly id: string };
    database.exec(
      'ALTER TABLE "user" ADD COLUMN twoFactorEnabled INTEGER NOT NULL DEFAULT 0; CREATE TABLE "twoFactor" (id TEXT PRIMARY KEY, userId TEXT NOT NULL) STRICT;',
    );
    database.prepare('UPDATE "user" SET twoFactorEnabled = 1 WHERE id = ?').run(user.id);
    database
      .prepare('INSERT INTO "twoFactor"(id, userId) VALUES (?, ?)')
      .run("legacy-two-factor", user.id);
    database
      .prepare(
        'INSERT INTO "session"(id, token, expiresAt, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)',
      )
      .run(
        "stale-session",
        "stale-token",
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        user.id,
      );
    database.close();

    writeFileSync(emailFile, "new-operator@example.invalid\n", { mode: 0o600 });
    runOperatorCommand("retarget", {
      ...baseEnvironment,
      DASHBOARD_OPERATOR_BOOTSTRAP_OUTPUT_FILE: secondBootstrap,
    });

    const second = readFileSync(secondBootstrap, "utf8");
    expect(second).toContain("operator_email=new-operator@example.invalid");
    expect(second).toContain("second_factor=email_otp");
    expect(second).not.toContain("first-operator@example.invalid");
    expect(statSync(secondBootstrap).mode & 0o777).toBe(0o600);

    const verification = new DatabaseSync(databaseFile, { readOnly: true });
    expect(verification.prepare('SELECT email FROM "user"').get()).toEqual({
      email: "new-operator@example.invalid",
    });
    expect(verification.prepare('SELECT count(*) AS count FROM "session"').get()).toEqual({
      count: 0,
    });
    expect(
      verification.prepare("SELECT password_changed FROM operator_security_state").get(),
    ).toEqual({ password_changed: 0 });
    expect(verification.prepare('SELECT twoFactorEnabled FROM "user"').get()).toEqual({
      twoFactorEnabled: 0,
    });
    expect(verification.prepare('SELECT count(*) AS count FROM "twoFactor"').get()).toEqual({
      count: 0,
    });
    verification.close();
  });
});
