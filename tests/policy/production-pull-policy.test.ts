import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production pull policy", () => {
  it("polls main, waits for successful CI, and deploys immutable images", async () => {
    const script = await readFile("infra/production-pull/esmii-production-pull", "utf8");

    expect(script).toContain("/branches/main");
    expect(script).toContain("actions/runs?branch=main&event=push");
    expect(script).toContain('WEB_REVISION} == "${REMOTE_REVISION}');
    expect(script).toContain("@sha256:[0-9a-f]{64}");
    expect(script).toContain("esmii/web:sha-${REMOTE_REVISION}");
    expect(script).toContain("org.opencontainers.image.revision");
    expect(script).toContain("org.opencontainers.image.source");
    expect(script).not.toMatch(/\b(?:ssh|scp)\b/u);
    expect(script).not.toContain(":latest");
  });

  it("keeps staging in the full host composition and updates only named production services", async () => {
    const script = await readFile("infra/production-pull/esmii-production-pull", "utf8");

    expect(script).toContain('STAGING_OVERLAY_PATH="${RUNTIME_ROOT}/compose.staging.yaml"');
    expect(script).toContain('-f "${STAGING_OVERLAY_PATH}"');
    expect(script).toContain(
      "compose up -d --wait production-api production-worker production-web",
    );
    expect(script).not.toContain("compose down");
    expect(script).not.toContain("staging-api staging-worker staging-web caddy");
  });

  it("uses one host deployment lock shared with staging", async () => {
    const [staging, production] = await Promise.all([
      readFile("infra/staging-pull/esmii-staging-pull", "utf8"),
      readFile("infra/production-pull/esmii-production-pull", "utf8"),
    ]);

    expect(staging).toContain("/run/lock/esmii/host-pull.lock");
    expect(production).toContain("/run/lock/esmii/host-pull.lock");
  });

  it("schedules production polling after first enable and after every run", async () => {
    const timer = await readFile("infra/production-pull/esmii-production-pull.timer", "utf8");

    expect(timer).toContain("OnActiveSec=120s");
    expect(timer).toContain("OnUnitActiveSec=120s");
  });

  it("captures bounded API diagnostics before a failed activation rolls back", async () => {
    const script = await readFile("infra/production-pull/esmii-production-pull", "utf8");
    const diagnostic = "compose logs --no-color --tail 120 production-api";

    expect(script).toContain(diagnostic);
    expect(script.indexOf("diagnose_activation_failure\n  rollback")).toBeGreaterThan(
      script.indexOf(diagnostic),
    );
  });

  it("keeps capture and external production mail modes explicit while Google OAuth stays disabled", async () => {
    const [capture, external, pull, renderer] = await Promise.all([
      readFile("infra/production-pull/compose.production.capture.yaml", "utf8"),
      readFile("infra/templates/compose.production.external.yaml", "utf8"),
      readFile("infra/production-pull/esmii-production-pull", "utf8"),
      readFile("infra/production-pull/render-production.py", "utf8"),
    ]);

    expect(capture).toContain("smtp://production-mailpit:1025");
    expect(capture).not.toContain("SMTP_URL_FILE");
    expect(external).toContain("NODE_EXTRA_CA_CERTS");
    expect(external).toContain("host_ip: 0.0.0.0");
    expect(external).toContain('published: "25"');
    expect(pull).toContain("ESMII_PRODUCTION_MAIL_MODE");
    expect(pull).toContain("compose.production.external.yaml");
    expect(pull).toContain("docker rm --force esmii-production-mailpit-1");
    expect(pull).toContain("docker rm --force esmii-production-stalwart-1");
    expect(renderer).toContain("SMTP_URL_FILE");
    expect(renderer).toContain('choices=("capture", "external")');
    expect(renderer).toContain('replacements["@@PRODUCTION_MAIL_MODE@@"] == "capture"');
    expect(renderer).toContain("AUTH_GOOGLE_CLIENT_");
    expect(renderer).toContain("production_auth_google_client_");
    expect(renderer).toContain("INITIAL_PUBLIC_SHELL_MODE");
    expect(renderer).toContain("SECURITY_TOMBSTONE_JOURNAL_FILE");
  });

  it("initializes the capture recovery row needed by the explicit production shell", async () => {
    const migration = await readFile("apps/server/src/entrypoints/migrate.ts", "utf8");

    expect(migration).toContain(
      "await initializeCapturedTombstoneState(configuration.databaseUrl, configuration.appEnvironment);",
    );
    expect(migration).not.toContain('configuration.appEnvironment !== "production"');
  });

  it("keeps canonical production secrets root-only and mounts isolated runtime copies", async () => {
    const [renderer, preparer] = await Promise.all([
      readFile("infra/production-pull/render-production.py", "utf8"),
      readFile("infra/production-pull/prepare-production-runtime-secrets.py", "utf8"),
    ]);

    expect(renderer).toContain("/etc/myapp/runtime-secrets/production/");
    expect(preparer).toContain("source.chmod(0o600)");
    expect(preparer).toContain("temporary.chmod(0o444)");
  });

  it("assigns container-owned directories by numeric uid without requiring host users", async () => {
    const installer = await readFile("infra/production-pull/install.sh", "utf8");

    expect(installer).toContain("chown 10001:10001");
    expect(installer).toContain("chown 2000:2000");
    expect(installer).not.toMatch(/install .* -o (?:10001|2000)\b/u);
  });
});
