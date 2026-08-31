import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("staging pull policy", () => {
  it("polls outbound, requires matching dev revisions, and deploys digest references", async () => {
    const script = await readFile("infra/staging-pull/esmii-staging-pull", "utf8");

    expect(script).toContain("/branches/dev");
    expect(script).toContain("actions/runs?branch=dev&event=push");
    expect(script).toContain('WEB_REVISION} == "${REMOTE_REVISION}');
    expect(script).toContain("@sha256:[0-9a-f]{64}");
    expect(script).toContain("esmii/web:sha-${REMOTE_REVISION}");
    expect(script).toContain("org.opencontainers.image.revision");
    expect(script).toContain("org.opencontainers.image.source");
    expect(script).not.toMatch(/\b(?:ssh|scp)\b/u);
    expect(script).not.toContain(":latest");
  });

  it("keeps the production branch and production services outside this automation", async () => {
    const [script, configuration] = await Promise.all([
      readFile("infra/staging-pull/esmii-staging-pull", "utf8"),
      readFile("infra/staging-pull/staging-pull.conf", "utf8"),
    ]);
    const joined = `${script}\n${configuration}`;

    expect(joined).not.toContain("branches/main");
    expect(joined).not.toContain("production-web");
    expect(joined).not.toContain("production-api");
    expect(joined).not.toContain("production-worker");
  });

  it("reserves Caddy's fixed edge address before starting dynamic edge services", async () => {
    const script = await readFile("infra/staging-pull/esmii-staging-pull", "utf8");
    const caddyReservation = script.indexOf("compose up --no-start --no-deps caddy");
    const dependencyStart = script.indexOf(
      "compose up -d --wait staging-postgres staging-valkey staging-mailpit",
    );

    expect(caddyReservation).toBeGreaterThan(-1);
    expect(dependencyStart).toBeGreaterThan(caddyReservation);
  });

  it("waits for the temporary demo to release public ports before starting Caddy", async () => {
    const script = await readFile("infra/staging-pull/esmii-staging-pull", "utf8");
    const demoStop = script.indexOf("docker stop esmii-staging-demo");
    const portWait = script.indexOf("wait_for_public_ports || return 1");
    const caddyStart = script.indexOf("docker start esmii-caddy-1");
    const applicationStart = script.indexOf(
      "compose up -d --wait staging-api staging-worker staging-web",
    );

    expect(demoStop).toBeGreaterThan(-1);
    expect(portWait).toBeGreaterThan(demoStop);
    expect(caddyStart).toBeGreaterThan(portWait);
    expect(applicationStart).toBeGreaterThan(caddyStart);
  });

  it("keeps canonical staging secrets root-only and mounts only isolated runtime copies", async () => {
    const [compose, puller, preparer] = await Promise.all([
      readFile("infra/compose.staging.yaml", "utf8"),
      readFile("infra/staging-pull/esmii-staging-pull", "utf8"),
      readFile("infra/staging-pull/prepare-runtime-secrets.py", "utf8"),
    ]);

    expect(compose).toContain("/etc/myapp/runtime-secrets/staging/");
    expect(compose).not.toContain("file: /etc/myapp/secrets/staging/");
    expect(puller).toContain("prepare-runtime-secrets.py");
    expect(preparer).toContain("source.chmod(0o600)");
    expect(preparer).toContain("temporary.chmod(0o444)");
  });

  it("restricts staging explicitly and uses only its scoped Stalwart submission path", async () => {
    const [staging, production] = await Promise.all([
      readFile("infra/compose.staging.yaml", "utf8"),
      readFile("infra/compose.production.yaml", "utf8"),
    ]);

    expect(staging).toContain("AUTH_STAGING_ACCESS_MODE: allowlist");
    expect(staging).toContain(
      "AUTH_STAGING_TESTER_EMAILS_FILE: /run/secrets/staging_tester_allowlist",
    );
    expect(staging).toContain("SMTP_URL_FILE: /run/secrets/staging_stalwart_smtp_url");
    expect(staging).toContain("MAIL_FROM_ADDRESS: staging@esmii.app");
    expect(staging).toContain("NODE_EXTRA_CA_CERTS: /run/mail-ca/mail.esmii.app.pem");
    expect(staging).toContain(
      "/srv/myapp/staging/mail-ca/mail.esmii.app.pem:/run/mail-ca/mail.esmii.app.pem:ro",
    );
    expect(staging).toContain("- staging-mail-submit");
    expect(staging).not.toContain("- production-mail-submit");
    expect(production).toContain("staging-mail-submit:");
  });
});
