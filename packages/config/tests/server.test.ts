import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  getActionLinkKey,
  loadHttpServerConfig,
  loadWorkerConfig,
  readRuntimeValue,
} from "../src/server.js";

const validEnvironment = {
  APP_ENV: "test",
  APP_DATABASE_URL: "postgresql://api:local-only@postgres/app",
  APP_VALKEY_URL: "redis://api:local-only@valkey:6379/0",
  BETTER_AUTH_SECRET: "synthetic-better-auth-secret-value-0001",
  OPERATIONS_HEALTH_TOKEN: "x".repeat(32),
} as const;

describe("server configuration", () => {
  it("loads the explicit browser-invisible runtime values", async () => {
    const configuration = await loadHttpServerConfig(validEnvironment);

    expect(configuration).toMatchObject({
      appEnvironment: "test",
      host: "0.0.0.0",
      port: 3000,
    });
  });

  it("rejects ambiguous direct and file-backed values", async () => {
    await expect(
      readRuntimeValue(
        "APP_DATABASE_URL",
        {
          APP_DATABASE_URL: "sensitive-direct-value",
          APP_DATABASE_URL_FILE: "/sensitive/path",
        },
        async () => "sensitive-file-value",
      ),
    ).rejects.toThrow("set either APP_DATABASE_URL or APP_DATABASE_URL_FILE, not both");
  });

  it("never includes a supplied secret in validation errors", async () => {
    const sensitiveValue = "do-not-print-this-value";
    let caught: unknown;

    try {
      await loadHttpServerConfig({
        ...validEnvironment,
        OPERATIONS_HEALTH_TOKEN: sensitiveValue,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(String(caught)).not.toContain(sensitiveValue);
  });

  it("reads one-line Docker secrets without retaining their line ending", async () => {
    const value = await readRuntimeValue(
      "APP_DATABASE_URL",
      { APP_DATABASE_URL_FILE: "/run/secrets/database" },
      async () => "postgresql://api:local-only@postgres/app\n",
    );

    expect(value).toBe("postgresql://api:local-only@postgres/app");
  });

  it("loads the staging tester allowlist from its Docker secret file", async () => {
    const configuration = await loadHttpServerConfig(
      {
        ...validEnvironment,
        APP_ENV: "staging",
        APP_PUBLIC_ORIGIN: "https://staging.esmii.app",
        AUTH_STAGING_ACCESS_MODE: "allowlist",
        AUTH_STAGING_TESTER_EMAILS_FILE: "/run/secrets/staging_tester_allowlist",
      },
      async (path) => {
        if (path === "/run/secrets/staging_tester_allowlist") return "support@polytech.ae\n";
        throw new Error("unexpected secret path");
      },
    );

    expect(configuration.authentication.stagingTesterEmails).toEqual(
      new Set(["support@polytech.ae"]),
    );
    expect(configuration.authentication.stagingAccessMode).toBe("allowlist");
  });

  it("supports an explicit open staging registration mode without an allowlist", async () => {
    const configuration = await loadHttpServerConfig({
      ...validEnvironment,
      APP_ENV: "staging",
      APP_PUBLIC_ORIGIN: "https://staging.esmii.app",
      AUTH_STAGING_ACCESS_MODE: "open",
    });

    expect(configuration.authentication.stagingAccessMode).toBe("open");
    expect(configuration.authentication.stagingTesterEmails).toEqual(new Set());

    await expect(
      loadHttpServerConfig({
        ...validEnvironment,
        APP_ENV: "staging",
        APP_PUBLIC_ORIGIN: "https://staging.esmii.app",
      }),
    ).rejects.toThrow("staging requires an explicit open or allowlist mode");
  });

  it("enables mock social providers only in local/test environments", async () => {
    const configuration = await loadHttpServerConfig({
      ...validEnvironment,
      AUTH_MOCK_PROVIDERS: "true",
    });

    expect(configuration.authentication.providers.mockProviders).toEqual(["google"]);
    await expect(
      loadHttpServerConfig({
        ...validEnvironment,
        APP_ENV: "production",
        APP_PUBLIC_ORIGIN: "https://esmii.app",
        AUTH_MOCK_PROVIDERS: "true",
      }),
    ).rejects.toThrow("mock providers are local/test only");
  });

  it("requires an explicit provider-free initial shell for production capture", async () => {
    const productionEnvironment = {
      ...validEnvironment,
      APP_ENV: "production",
      APP_PUBLIC_ORIGIN: "https://esmii.app",
    } as const;

    await expect(loadHttpServerConfig(productionEnvironment)).rejects.toThrow(
      "production capture requires explicit initial public shell mode",
    );

    const configuration = await loadHttpServerConfig({
      ...productionEnvironment,
      INITIAL_PUBLIC_SHELL_MODE: "true",
    });
    expect(configuration.initialPublicShellMode).toBe(true);

    await expect(
      loadHttpServerConfig({
        ...productionEnvironment,
        AUTH_GOOGLE_CLIENT_ID: "synthetic-production-client-id",
        AUTH_GOOGLE_CLIENT_SECRET: "synthetic-production-client-secret",
        INITIAL_PUBLIC_SHELL_MODE: "true",
      }),
    ).rejects.toThrow("requires production capture mode with no authentication provider");
  });

  it("does not load worker-only derivation material in API configuration", async () => {
    const sentinel = "worker-only-key-sentinel";
    const configuration = await loadHttpServerConfig({
      ...validEnvironment,
      ACTION_LINK_DERIVATION_KEYRING: sentinel,
    });

    expect(JSON.stringify(configuration)).not.toContain(sentinel);
  });

  it("loads purpose-separated worker keys and rejects retired versions", async () => {
    const keyring = JSON.stringify({
      schemaVersion: 1,
      environment: "test",
      keys: [
        { purpose: "magic-link", version: 2, status: "active", key: "a".repeat(43) },
        { purpose: "magic-link", version: 1, status: "retired", key: "b".repeat(43) },
        { purpose: "invitation", version: 4, status: "active", key: "c".repeat(43) },
      ],
    });
    const configuration = await loadWorkerConfig({
      APP_ENV: "test",
      APP_DATABASE_URL: validEnvironment.APP_DATABASE_URL,
      APP_VALKEY_URL: validEnvironment.APP_VALKEY_URL,
      SMTP_URL: "smtp://mailpit:1025",
      ACTION_LINK_DERIVATION_KEYRING: keyring,
    });

    expect(configuration.mailFromAddress).toBe("noreply@localhost");
    expect(configuration.messageIdDomain).toBe("messages.localhost");

    expect(getActionLinkKey(configuration.actionLinkKeyring, "magic-link").version).toBe(2);
    expect(() => getActionLinkKey(configuration.actionLinkKeyring, "magic-link", 1)).toThrow(
      "unavailable or retired",
    );
  });

  it("accepts an explicit worker sender while keeping the public link origin separate", async () => {
    const keyring = JSON.stringify({
      schemaVersion: 1,
      environment: "staging",
      keys: [
        { purpose: "magic-link", version: 1, status: "active", key: "f".repeat(43) },
        { purpose: "invitation", version: 1, status: "active", key: "g".repeat(43) },
      ],
    });
    const configuration = await loadWorkerConfig({
      APP_ENV: "staging",
      APP_PUBLIC_ORIGIN: "https://staging.esmii.app",
      APP_DATABASE_URL: validEnvironment.APP_DATABASE_URL,
      APP_VALKEY_URL: validEnvironment.APP_VALKEY_URL,
      SMTP_URL: "smtp://mail.esmii.app:587",
      MAIL_FROM_ADDRESS: "staging@esmii.app",
      ACTION_LINK_DERIVATION_KEYRING: keyring,
    });

    expect(configuration.mailFromAddress).toBe("staging@esmii.app");
    expect(configuration.publicOrigin).toBe("https://staging.esmii.app");
  });

  it("keeps pg-boss schema creation and migration disabled in the worker", async () => {
    const keyring = JSON.stringify({
      schemaVersion: 1,
      environment: "test",
      keys: [
        { purpose: "magic-link", version: 1, status: "active", key: "d".repeat(43) },
        { purpose: "invitation", version: 1, status: "active", key: "e".repeat(43) },
      ],
    });
    await expect(
      loadWorkerConfig({
        APP_ENV: "test",
        APP_DATABASE_URL: validEnvironment.APP_DATABASE_URL,
        APP_VALKEY_URL: validEnvironment.APP_VALKEY_URL,
        SMTP_URL: "smtp://mailpit:1025",
        ACTION_LINK_DERIVATION_KEYRING: keyring,
        PGBOSS_MIGRATE: "true",
      }),
    ).rejects.toThrow("must remain false");
  });
});
