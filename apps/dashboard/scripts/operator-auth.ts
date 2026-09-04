import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { hashPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";

import { parseDashboardAuthConfig } from "../lib/config/server.ts";
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

type Command = "migrate" | "provision" | "recover" | "revoke-sessions";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireCommand(value: string | undefined): Command {
  if (
    value !== "migrate" &&
    value !== "provision" &&
    value !== "recover" &&
    value !== "revoke-sessions"
  ) {
    fail("Usage: operator-auth.ts migrate|provision|recover|revoke-sessions");
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
  )
    fail(`${variable} is invalid`);
  return value;
}

async function readVisible(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    fail("An input file is required without a TTY");
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
        if (byte >= 32 && byte <= 126 && value.length < 512) value += String.fromCharCode(byte);
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
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
    fail("Operator email is invalid");
  return email;
}

function writeBootstrapOutput(value: string): void {
  const path = process.env.DASHBOARD_OPERATOR_BOOTSTRAP_OUTPUT_FILE;
  if (path !== undefined && path !== "") {
    if (!isAbsolute(path))
      fail("DASHBOARD_OPERATOR_BOOTSTRAP_OUTPUT_FILE must be an absolute path");
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, value, { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
    process.stdout.write(`Bootstrap material written to ${path}. Remove it after enrollment.\n`);
    return;
  }
  if (!process.stdout.isTTY)
    fail("DASHBOARD_OPERATOR_BOOTSTRAP_OUTPUT_FILE is required without a TTY");
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
  const headers = new Headers({
    "content-type": "application/json",
    origin,
  });
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
  if (!response.ok)
    throw new Error(`Operator authentication operation failed (${response.status})`);
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

async function enrollTotp(options: {
  readonly database: OperatorDatabase;
  readonly email: string;
  readonly password: string;
  readonly signUp: boolean;
}): Promise<string> {
  const config = parseDashboardAuthConfig();
  const realm = createOperatorAuthRealm({ config, database: options.database, provisioning: true });
  const jar = new Map<string, string>();
  if (options.signUp) {
    await callAuth(config.origin, realm.auth.handler, jar, "/sign-up/email", {
      email: options.email,
      name: "Esmii operator",
      password: options.password,
    });
  } else {
    await callAuth(config.origin, realm.auth.handler, jar, "/sign-in/email", {
      email: options.email,
      password: options.password,
    });
  }
  const enrollment = (await callAuth(config.origin, realm.auth.handler, jar, "/two-factor/enable", {
    method: "totp",
    password: options.password,
  })) as { readonly totpURI?: unknown };
  if (typeof enrollment.totpURI !== "string" || !enrollment.totpURI.startsWith("otpauth://")) {
    throw new Error("TOTP enrollment did not return an authenticator URI");
  }
  writeBootstrapOutput(
    [
      `environment=${config.environment}`,
      `operator_email=${options.email}`,
      `temporary_password=${options.password}`,
      `totp_uri=${enrollment.totpURI}`,
      "",
    ].join("\n"),
  );
  const code = await requiredInput("DASHBOARD_OPERATOR_TOTP_CODE_FILE", "Authenticator code: ");
  if (!/^\d{6}$/u.test(code)) fail("Authenticator code must contain six digits");
  await callAuth(config.origin, realm.auth.handler, jar, "/two-factor/verify-totp", {
    code,
    trustDevice: false,
  });
  const user = findUser(options.database, options.email);
  if (user === null) throw new Error("Provisioned operator was not found");
  writeOperatorSecurityState(options.database, user.id, {
    passwordChanged: false,
    totpEnrollmentVerified: true,
  });
  revokeOperatorSessions(options.database, user.id);
  writeOperatorAudit(options.database, {
    action: options.signUp ? "operator_provision" : "operator_recovery",
    outcome: "totp_enrolled_password_change_required",
    requestId: crypto.randomUUID(),
    subjectId: user.id,
  });
  return user.id;
}

async function provision(database: OperatorDatabase): Promise<void> {
  const email = normalizeEmail(
    await requiredInput("DASHBOARD_OPERATOR_EMAIL_FILE", "Operator email: "),
  );
  if (findUser(database, email) !== null) fail("That operator already exists; use recover instead");
  const temporaryPassword = randomBytes(18).toString("base64url");
  await enrollTotp({ database, email, password: temporaryPassword, signUp: true });
  process.stdout.write(
    "Operator enrolled. The temporary password must be changed after first sign-in.\n",
  );
}

async function recover(database: OperatorDatabase): Promise<void> {
  const email = normalizeEmail(
    await requiredInput("DASHBOARD_OPERATOR_EMAIL_FILE", "Operator email: "),
  );
  const user = findUser(database, email);
  if (user === null) fail("Operator was not found");
  const temporaryPassword = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(temporaryPassword);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        'UPDATE "account" SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = ?',
      )
      .run(passwordHash, new Date().toISOString(), user.id, "credential");
    if (result.changes !== 1) throw new Error("Operator credential account was not found");
    revokeOperatorSessions(database, user.id);
    database.prepare('DELETE FROM "twoFactor" WHERE userId = ?').run(user.id);
    database
      .prepare('UPDATE "user" SET twoFactorEnabled = 0, updatedAt = ? WHERE id = ?')
      .run(new Date().toISOString(), user.id);
    writeOperatorSecurityState(database, user.id, {
      passwordChanged: false,
      totpEnrollmentVerified: false,
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  await enrollTotp({ database, email, password: temporaryPassword, signUp: false });
  process.stdout.write("Operator recovery completed. The temporary password must be changed.\n");
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
    requestId: crypto.randomUUID(),
    subjectId: user.id,
  });
  process.stdout.write(`Revoked ${revoked} operator session(s).\n`);
}

async function main(): Promise<void> {
  if (process.argv.length > 3)
    fail("Secret or identity values must not be passed as command arguments");
  const command = requireCommand(process.argv[2]);
  const config = parseDashboardAuthConfig();
  const database = openOperatorDatabase(config.databaseFile);
  try {
    await migrate(database);
    if (command === "migrate")
      process.stdout.write("Operator authentication database is current.\n");
    else if (command === "provision") await provision(database);
    else if (command === "recover") await recover(database);
    else await revokeSessions(database);
  } finally {
    database.close();
  }
}

await main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "Operator authentication command failed");
});
