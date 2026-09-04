import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const dashboardRoot = resolve(repositoryRoot, "apps/dashboard");
const runtimeRoot = resolve(repositoryRoot, "test-results/dashboard-e2e-build");
const secretFile = resolve(runtimeRoot, "auth-secret");
const databaseFile = resolve(runtimeRoot, "auth.sqlite");
const nextBinary = resolve(dashboardRoot, "node_modules/next/dist/bin/next");

rmSync(runtimeRoot, { force: true, recursive: true });
mkdirSync(runtimeRoot, { mode: 0o700, recursive: true });
writeFileSync(secretFile, `${randomBytes(48).toString("base64url")}\n`, { mode: 0o600 });

const build = spawn(process.execPath, [nextBinary, "build"], {
  cwd: dashboardRoot,
  env: {
    ...process.env,
    DASHBOARD_AUTH_DATABASE_FILE: databaseFile,
    DASHBOARD_AUTH_SECRET_FILE: secretFile,
    DASHBOARD_ENVIRONMENT: "staging",
    DASHBOARD_ORIGIN: "http://127.0.0.1:3111",
    DASHBOARD_PEER_ORIGIN: "http://127.0.0.1:3112",
    MONITORING_FIXTURE_MODE: "true",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: "inherit",
});

const [code, signal] = (await once(build, "exit")) as [number | null, NodeJS.Signals | null];
rmSync(runtimeRoot, { force: true, recursive: true });

if (code !== 0) {
  throw new Error(`Dashboard browser-acceptance build failed (${signal ?? code ?? "unknown"})`);
}

cpSync(
  resolve(dashboardRoot, ".next/static"),
  resolve(dashboardRoot, ".next/standalone/apps/dashboard/.next/static"),
  { recursive: true },
);
