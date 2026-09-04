import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getMigrations } from "better-auth/db/migration";

import {
  openOperatorDatabase,
  revokeOperatorSessions,
  writeOperatorSecurityState,
  type OperatorDatabase,
} from "../../lib/auth/database.ts";
import {
  buildOperatorAuthOptions,
  createOperatorAuthRealm,
  OPERATOR_AUTH_BASE_PATH,
} from "../../lib/auth/server.ts";
import type { DashboardAuthConfig } from "../../lib/config/server.ts";
import type { MonitoringEnvironment } from "../../lib/monitoring/types.ts";

interface FixtureMetadata {
  readonly authSecretFile: string;
  readonly databaseFile: string;
  readonly email: string;
  readonly emailOtpCodeFile: string;
  readonly environment: MonitoringEnvironment;
  readonly origin: string;
  readonly password: string;
  readonly peerOrigin: string;
  readonly themeFixture: "contract-test" | null;
}

const SERVER_TARGETS = {
  production: { peerPort: 3111, port: 3112, themeFixture: "contract-test" },
  staging: { peerPort: 3112, port: 3111, themeFixture: null },
} as const;

function requireTarget(
  environmentValue: string | undefined,
  portValue: string | undefined,
): {
  readonly environment: MonitoringEnvironment;
  readonly peerPort: number;
  readonly port: number;
  readonly themeFixture: "contract-test" | null;
} {
  if (environmentValue !== "staging" && environmentValue !== "production") {
    throw new Error("The dashboard fixture environment must be staging or production");
  }
  const target = SERVER_TARGETS[environmentValue];
  if (portValue !== String(target.port)) {
    throw new Error("The dashboard fixture port does not match the fixed environment target");
  }
  return { environment: environmentValue, ...target };
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
  config: DashboardAuthConfig,
  handler: (request: Request) => Promise<Response>,
  jar: Map<string, string>,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: config.origin,
    "x-forwarded-for": "127.0.0.1",
  });
  if (jar.size > 0) {
    headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  const response = await handler(
    new Request(`${config.origin}${OPERATOR_AUTH_BASE_PATH}${path}`, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    }),
  );
  updateCookies(jar, response);
  if (!response.ok) {
    const failure = (await response
      .clone()
      .json()
      .catch(() => null)) as { readonly code?: unknown } | null;
    const code = typeof failure?.code === "string" ? `, ${failure.code}` : "";
    throw new Error(
      `Synthetic operator provisioning failed at ${path} (${response.status}${code})`,
    );
  }
  return response.json();
}

async function migrate(config: DashboardAuthConfig, database: OperatorDatabase): Promise<void> {
  const plan = await getMigrations(
    buildOperatorAuthOptions(config, database, { provisioning: true }),
  );
  await plan.runMigrations();
}

async function provisionSyntheticOperator(options: {
  readonly config: DashboardAuthConfig;
  readonly database: OperatorDatabase;
  readonly email: string;
  readonly password: string;
}): Promise<void> {
  const realm = createOperatorAuthRealm({
    config: options.config,
    database: options.database,
    provisioning: true,
  });
  const jar = new Map<string, string>();
  await callAuth(options.config, realm.auth.handler, jar, "/sign-up/email", {
    email: options.email,
    name: "Synthetic dashboard operator",
    password: options.password,
  });
  const user = options.database
    .prepare('SELECT id FROM "user" WHERE lower(email) = ?')
    .get(options.email) as { readonly id: string } | undefined;
  if (user === undefined) throw new Error("Synthetic operator was not found after provisioning");
  writeOperatorSecurityState(options.database, user.id, {
    passwordChanged: true,
  });
  revokeOperatorSessions(options.database, user.id);
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000).unref();
}

const target = requireTarget(process.argv[2], process.argv[3]);
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const dashboardRoot = resolve(repositoryRoot, "apps/dashboard");
const runtimeRoot = resolve(repositoryRoot, "test-results/dashboard-e2e-runtime");
const runtimeDirectory = resolve(runtimeRoot, target.environment);
const databaseFile = resolve(runtimeDirectory, "auth.sqlite");
const authSecretFile = resolve(runtimeDirectory, "auth-secret");
const metadataFile = resolve(runtimeDirectory, "fixture.json");
const emailOtpCodeFile = resolve(runtimeDirectory, "email-otp-code");
const origin = `http://127.0.0.1:${target.port}`;
const peerOrigin = `http://127.0.0.1:${target.peerPort}`;
const email = `operator-${target.environment}@example.invalid`;
const password = randomBytes(24).toString("base64url");

rmSync(runtimeDirectory, { force: true, recursive: true });
mkdirSync(runtimeDirectory, { mode: 0o700, recursive: true });
writeFileSync(authSecretFile, `${randomBytes(48).toString("base64url")}\n`, { mode: 0o600 });

const config: DashboardAuthConfig = {
  databaseFile,
  emailOtpCaptureFile: emailOtpCodeFile,
  emailOtpFrom:
    target.environment === "staging" ? "monitoring-staging@esmii.app" : "monitoring@esmii.app",
  environment: target.environment,
  origin,
  peerOrigin,
  secret: readFileSync(authSecretFile, "utf8").trim(),
  smtpUrl: null,
  themeFixture: target.themeFixture,
};
const database = openOperatorDatabase(databaseFile);
await migrate(config, database);
await provisionSyntheticOperator({
  config,
  database,
  email,
  password,
});

const metadata: FixtureMetadata = {
  authSecretFile,
  databaseFile,
  email,
  emailOtpCodeFile,
  environment: target.environment,
  origin,
  password,
  peerOrigin,
  themeFixture: target.themeFixture,
};
writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });

const standaloneRoot = resolve(dashboardRoot, ".next/standalone/apps/dashboard");
const standaloneServer = resolve(standaloneRoot, "server.js");
const server = spawn(process.execPath, [standaloneServer], {
  cwd: standaloneRoot,
  env: {
    ...process.env,
    DASHBOARD_AUTH_DATABASE_FILE: databaseFile,
    DASHBOARD_AUTH_SECRET_FILE: authSecretFile,
    DASHBOARD_EMAIL_OTP_CAPTURE_FILE: emailOtpCodeFile,
    DASHBOARD_ENVIRONMENT: target.environment,
    DASHBOARD_ORIGIN: origin,
    DASHBOARD_PEER_ORIGIN: peerOrigin,
    ...(target.themeFixture === null
      ? { DASHBOARD_THEME_FIXTURE: undefined }
      : { DASHBOARD_THEME_FIXTURE: target.themeFixture }),
    MONITORING_FIXTURE_MODE: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(target.port),
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => stopChild(server));
}

const [exitCode, exitSignal] = (await once(server, "exit")) as [
  number | null,
  NodeJS.Signals | null,
];
database.close();
rmSync(runtimeDirectory, { force: true, recursive: true });

if (exitCode !== 0) {
  throw new Error(
    `Dashboard ${target.environment} fixture stopped unexpectedly (${exitSignal ?? exitCode ?? "unknown"})`,
  );
}
