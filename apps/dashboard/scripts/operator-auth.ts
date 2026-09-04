import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { hashPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";

import {
  openOperatorDatabase,
  revokeOperatorSessions,
  writeOperatorAudit,
  writeOperatorSecurityState,
  type OperatorDatabase,
} from "../lib/auth/database.ts";
import {
  buildOperatorAuthOptions,
  createOperatorAuthRealm,
  OPERATOR_AUTH_BASE_PATH,
} from "../lib/auth/server.ts";
import { parseDashboardAuthConfig } from "../lib/config/server.ts";

type Command = "migrate" | "provision" | "recover" | "retarget" | "revoke-sessions";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireCommand(value: string | undefined): Command {
  if (
    value !== "migrate" &&
    value !== "provision" &&
    value !== "recover" &&
    value !== "retarget" &&
    value !== "revoke-sessions"
  ) {
    fail("Usage: operator-auth.ts migrate|provision|recover|retarget|revoke-sessions");
  }
  return value;
}

function readFromFile(variable: string): string | null {
  const path = process.env[variable];
  if (path === undefined || path === "") return null;
  if (!isAbsolute(path)) fail(`${variable} must be an absolute path`);
  const value = readFileSync(path, "utf8").replace(/\r?\n$/u, "");
  if (
    value.length === 0 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    fail(`${variable} is invalid`);
  }
  return value;
}

async function readVisible(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("An input file is required without a TTY");
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Input cancelled"));
          return;
        }
        if (byte === 10 || byte === 13) {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32 && byte <= 126 && value.length < 512) {
          value += String.fromCharCode(byte);
        }
      }
    };
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function requiredInput(variable: string, prompt: string): Promise<string> {
  const fromFile = readFromFile(variable);
  const value = fromFile ?? (await readVisible(prompt));
  if (value.length === 0) fail(`${variable} is required`);
  return value;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    fail("Operator email is invalid");
  }
  return email;
}

function writeBootstrapOutput(value: string): void {
  const path = process.env.DASHBOARD_OPERATOR_BOOTSTRAP_OUTPUT_FILE;
  if (path !== undefined && path !== "") {
    if (!isAbsolute(path)) {
      fail("DASHBOARD_OPERATOR_BOOTSTRAP_OUTPUT_FILE must be an absolute path");
    }
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, value, { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
    process.stdout.write(`Bootstrap material written to ${path}. Remove it after use.\n`);
    return;
  }
  if (!process.stdout.isTTY) {
    fail("DASHBOARD_OPERATOR_BOOTSTRAP_OUTPUT_FILE is required without a TTY");
  }
  process.stdout.write(`\n${value}\n`);
}

function updateCookies(jar: Map<string, string>, response: Response): void {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0];
    const separator = pair?.indexOf("=") ?? -1;
    if (pair === undefined || separator <= 0) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (/max-age=0/iu.test(value)) jar.delete(name);
    else jar.set(name, cookieValue);
  }
}

async function callAuth(
  origin: string,
  handler: (request: Request) => Promise<Response>,
  jar: Map<string, string>,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const headers = new Headers({ "content-type": "application/json", origin });
  if (jar.size > 0) {
    headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  const response = await handler(
    new Request(`${origin}${OPERATOR_AUTH_BASE_PATH}${path}`, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    }),
  );
  updateCookies(jar, response);
  if (!response.ok) {
    throw new Error(`Operator authentication operation failed (${response.status})`);
  }
  return response.json();
}

async function migrate(database: OperatorDatabase): Promise<void> {
  const config = parseDashboardAuthConfig();
  const options = buildOperatorAuthOptions(config, database, { provisioning: true });
  const plan = await getMigrations(options);
  await plan.runMigrations();
}

function findUser(database: OperatorDatabase, email: string): { readonly id: string } | null {
  const row = database.prepare('SELECT id FROM "user" WHERE lower(email) = ?').get(email) as
    { readonly id: string } | undefined;
  return row ?? null;
}

function writeTemporaryCredential(email: string, password: string): void {
  const config = parseDashboardAuthConfig();
  writeBootstrapOutput(
    [
      `environment=${config.environment}`,
      `operator_email=${email}`,
      `temporary_password=${password}`,
      "second_factor=email_otp",
      "",
    ].join("\n"),
  );
}

async function provision(database: OperatorDatabase): Promise<void> {
  const email = normalizeEmail(
    await requiredInput("DASHBOARD_OPERATOR_EMAIL_FILE", "Operator email: "),
  );
  if (findUser(database, email) !== null) {
    fail("That operator already exists; use recover instead");
  }
  const temporaryPassword = randomBytes(24).toString("base64url");
  const config = parseDashboardAuthConfig();
  const realm = createOperatorAuthRealm({ config, database, provisioning: true });
  const jar = new Map<string, string>();
  await callAuth(config.origin, realm.auth.handler, jar, "/sign-up/email", {
    email,
    name: "Esmii operator",
    password: temporaryPassword,
  });
  const user = findUser(database, email);
  if (user === null) throw new Error("Provisioned operator was not found");
  writeOperatorSecurityState(database, user.id, { passwordChanged: false });
  revokeOperatorSessions(database, user.id);
  writeOperatorAudit(database, {
    action: "operator_provision",
    outcome: "email_otp_password_change_required",
    requestId: randomUUID(),
    subjectId: user.id,
  });
  writeTemporaryCredential(email, temporaryPassword);
  process.stdout.write(
    "Operator provisioned. Email OTP is required and the temporary password must be changed.\n",
  );
}

function resetCredential(
  database: OperatorDatabase,
  input: { readonly email: string; readonly userId: string },
  passwordHash: string,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        'UPDATE "account" SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = ?',
      )
      .run(passwordHash, new Date().toISOString(), input.userId, "credential");
    if (result.changes !== 1) throw new Error("Operator credential account was not found");
    database.prepare("DELETE FROM operator_email_otp_session WHERE user_id = ?").run(input.userId);
    database.prepare('DELETE FROM "session" WHERE userId = ?').run(input.userId);
    database
      .prepare('DELETE FROM "verification" WHERE identifier = ?')
      .run(`email-verification-otp-${input.email}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  writeOperatorSecurityState(database, input.userId, { passwordChanged: false });
}

async function recover(database: OperatorDatabase): Promise<void> {
  const email = normalizeEmail(
    await requiredInput("DASHBOARD_OPERATOR_EMAIL_FILE", "Operator email: "),
  );
  const user = findUser(database, email);
  if (user === null) fail("Operator was not found");
  const temporaryPassword = randomBytes(24).toString("base64url");
  resetCredential(database, { email, userId: user.id }, await hashPassword(temporaryPassword));
  writeOperatorAudit(database, {
    action: "operator_recovery",
    outcome: "email_otp_password_change_required",
    requestId: randomUUID(),
    subjectId: user.id,
  });
  writeTemporaryCredential(email, temporaryPassword);
  process.stdout.write("Operator recovery completed. The temporary password must be changed.\n");
}

async function retarget(database: OperatorDatabase): Promise<void> {
  const email = normalizeEmail(
    await requiredInput("DASHBOARD_OPERATOR_EMAIL_FILE", "New operator email: "),
  );
  const users = database
    .prepare('SELECT id, lower(email) AS email FROM "user" LIMIT 2')
    .all() as Array<{
    readonly email: string;
    readonly id: string;
  }>;
  if (users.length !== 1) fail("Retarget requires exactly one existing operator");
  const user = users[0];
  if (user === undefined) fail("Retarget requires one existing operator");
  const duplicate = findUser(database, email);
  if (duplicate !== null && duplicate.id !== user.id) fail("The new operator email already exists");
  const temporaryPassword = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(temporaryPassword);
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const userColumns = database.prepare('PRAGMA table_info("user")').all() as Array<{
      readonly name: string;
    }>;
    if (userColumns.some((column) => column.name === "twoFactorEnabled")) {
      database
        .prepare(
          'UPDATE "user" SET email = ?, emailVerified = 1, twoFactorEnabled = 0, updatedAt = ? WHERE id = ?',
        )
        .run(email, now, user.id);
    } else {
      database
        .prepare('UPDATE "user" SET email = ?, emailVerified = 1, updatedAt = ? WHERE id = ?')
        .run(email, now, user.id);
    }
    const credential = database
      .prepare(
        'UPDATE "account" SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = ?',
      )
      .run(passwordHash, now, user.id, "credential");
    if (credential.changes !== 1) throw new Error("Operator credential account was not found");
    database.prepare("DELETE FROM operator_email_otp_session WHERE user_id = ?").run(user.id);
    database.prepare('DELETE FROM "session" WHERE userId = ?').run(user.id);
    database
      .prepare('DELETE FROM "verification" WHERE identifier IN (?, ?)')
      .run(`email-verification-otp-${user.email}`, `email-verification-otp-${email}`);
    const twoFactorTable = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'twoFactor'")
      .get() as { readonly present: number } | undefined;
    if (twoFactorTable?.present === 1) {
      database.prepare('DELETE FROM "twoFactor" WHERE userId = ?').run(user.id);
    }
    database
      .prepare(
        `INSERT INTO operator_security_state(
           user_id, password_changed, totp_enrollment_verified, updated_at
         ) VALUES (?, 0, 0, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           password_changed = 0,
           totp_enrollment_verified = 0,
           updated_at = excluded.updated_at`,
      )
      .run(user.id, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  writeOperatorAudit(database, {
    action: "operator_retarget",
    outcome: "email_otp_password_change_required",
    requestId: randomUUID(),
    subjectId: user.id,
  });
  writeTemporaryCredential(email, temporaryPassword);
  process.stdout.write(
    "Operator email changed, sessions revoked, and a new temporary password generated.\n",
  );
}

async function revokeSessions(database: OperatorDatabase): Promise<void> {
  const email = normalizeEmail(
    await requiredInput("DASHBOARD_OPERATOR_EMAIL_FILE", "Operator email: "),
  );
  const user = findUser(database, email);
  if (user === null) fail("Operator was not found");
  const revoked = revokeOperatorSessions(database, user.id);
  writeOperatorAudit(database, {
    action: "operator_revoke_sessions",
    outcome: `revoked_${revoked}`,
    requestId: randomUUID(),
    subjectId: user.id,
  });
  process.stdout.write(`Revoked ${revoked} operator session(s).\n`);
}

async function main(): Promise<void> {
  if (process.argv.length > 3) {
    fail("Secret or identity values must not be passed as command arguments");
  }
  const command = requireCommand(process.argv[2]);
  const config = parseDashboardAuthConfig();
  const database = openOperatorDatabase(config.databaseFile);
  try {
    await migrate(database);
    if (command === "migrate") {
      process.stdout.write("Operator authentication database is current.\n");
    } else if (command === "provision") {
      await provision(database);
    } else if (command === "recover") {
      await recover(database);
    } else if (command === "retarget") {
      await retarget(database);
    } else {
      await revokeSessions(database);
    }
  } finally {
    database.close();
  }
}

await main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "Operator authentication command failed");
});
