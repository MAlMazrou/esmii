import { describe, expect, it } from "vitest";

import { getPublicRuntimeConfig } from "../../packages/config/src/public.js";
import { loadHttpServerConfig } from "../../packages/config/src/server.js";

const stagingDatabase = "postgresql://staging-runtime@staging-db/esmii";
const stagingValkey = "redis://staging-runtime@staging-cache/0";
const stagingMarker = ["INERT", "STAGING", "OPERATIONS", "SENTINEL", "0001"].join("_");
const stagingAuthMarker = ["INERT", "STAGING", "AUTH", "SENTINEL", "0001"].join("_");
const productionDatabase = "postgresql://production-runtime@production-db/esmii";
const productionValkey = "redis://production-runtime@production-cache/0";
const productionMarker = ["INERT", "PRODUCTION", "OPERATIONS", "SENTINEL", "0001"].join("_");
const productionAuthMarker = ["INERT", "PRODUCTION", "AUTH", "SENTINEL", "0001"].join("_");

describe("runtime configuration isolation", () => {
  it("keeps staging and production configuration independent", async () => {
    const staging = await loadHttpServerConfig({
      APP_DATABASE_URL: stagingDatabase,
      APP_ENV: "staging",
      APP_PUBLIC_ORIGIN: "https://staging.esmii.app",
      APP_VALKEY_URL: stagingValkey,
      AUTH_STAGING_TESTER_EMAILS: "synthetic-tester@example.test",
      BETTER_AUTH_SECRET: stagingAuthMarker,
      OPERATIONS_HEALTH_TOKEN: stagingMarker,
    });
    const production = await loadHttpServerConfig({
      APP_DATABASE_URL: productionDatabase,
      APP_ENV: "production",
      APP_PUBLIC_ORIGIN: "https://esmii.app",
      APP_VALKEY_URL: productionValkey,
      BETTER_AUTH_SECRET: productionAuthMarker,
      INITIAL_PUBLIC_SHELL_MODE: "true",
      OPERATIONS_HEALTH_TOKEN: productionMarker,
    });

    expect(staging.appEnvironment).toBe("staging");
    expect(production.appEnvironment).toBe("production");
    expect(staging.databaseUrl).not.toBe(production.databaseUrl);
    expect(staging.valkeyUrl).not.toBe(production.valkeyUrl);
    expect(staging.operationsHealthToken).not.toBe(production.operationsHealthToken);
  });

  it("exposes only the explicit browser-safe allowlist", () => {
    const serialized = JSON.stringify(getPublicRuntimeConfig());

    expect(JSON.parse(serialized)).toEqual({
      applicationName: "Esmii",
      applicationSlug: "esmii",
      providers: [],
    });
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("redis://");
    expect(serialized).not.toContain("OPERATIONS");
  });
});
