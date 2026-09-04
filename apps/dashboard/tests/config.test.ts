import { describe, expect, it } from "vitest";

import {
  parseDashboardAuthConfig,
  parseMonitoringServerConfig,
  parsePublicDashboardConfig,
} from "../lib/config/server.ts";

const BASE = {
  DASHBOARD_AUTH_DATABASE_FILE: "/private/tmp/dashboard-auth.sqlite",
  DASHBOARD_AUTH_SECRET: "local-only-test-secret-with-more-than-thirty-two-characters",
  DASHBOARD_ENVIRONMENT: "staging",
  DASHBOARD_LOG_FILE: "/private/tmp/dashboard.ndjson",
  DASHBOARD_ORIGIN: "http://127.0.0.1:3010",
  DASHBOARD_PEER_ORIGIN: "http://localhost:3011",
  DASHBOARD_PROMETHEUS_URL: "http://staging-prometheus:9090",
  NODE_ENV: "test",
} as const;

describe("dashboard configuration", () => {
  it("fixes the environment and peer origin at the server boundary", () => {
    expect(parsePublicDashboardConfig(BASE)).toEqual({
      environment: "staging",
      origin: "http://127.0.0.1:3010",
      peerOrigin: "http://localhost:3011",
      themeFixture: null,
    });
    expect(() => parsePublicDashboardConfig({ ...BASE, DASHBOARD_ENVIRONMENT: "preview" })).toThrow(
      /production or staging/u,
    );
    expect(() =>
      parsePublicDashboardConfig({
        ...BASE,
        DASHBOARD_ORIGIN: "https://alternate.example.test",
        NODE_ENV: "production",
      }),
    ).toThrow(/fixed environment hostnames/u);
  });

  it("allows fixtures only on loopback and accepts the approved 20 MiB log window", () => {
    const fixture = parseMonitoringServerConfig({
      ...BASE,
      DASHBOARD_LOG_MAX_BYTES: "20971520",
      DASHBOARD_PROMETHEUS_URL: undefined,
      MONITORING_FIXTURE_MODE: "true",
    });
    expect(fixture.fixtureMode).toBe(true);
    expect(fixture.logMaxBytes).toBe(20_971_520);
    expect(() =>
      parseMonitoringServerConfig({
        ...BASE,
        DASHBOARD_ORIGIN: "https://staging-dashboard.esmii.app",
        MONITORING_FIXTURE_MODE: "true",
      }),
    ).toThrow(/loopback/u);
    expect(
      parsePublicDashboardConfig({ ...BASE, DASHBOARD_THEME_FIXTURE: "contract-test" })
        .themeFixture,
    ).toBe("contract-test");
    expect(() =>
      parsePublicDashboardConfig({
        ...BASE,
        DASHBOARD_ORIGIN: "https://staging-dashboard.esmii.app",
        DASHBOARD_THEME_FIXTURE: "contract-test",
      }),
    ).toThrow(/loopback/u);
  });

  it("rejects arbitrary Prometheus destinations and cross-environment backends", () => {
    expect(() =>
      parseMonitoringServerConfig({
        ...BASE,
        DASHBOARD_PROMETHEUS_URL: "http://example.test:9090",
      }),
    ).toThrow(/private staging-prometheus/u);
    expect(() =>
      parseMonitoringServerConfig({
        ...BASE,
        DASHBOARD_PROMETHEUS_URL: "http://production-prometheus:9090",
      }),
    ).toThrow(/private staging-prometheus/u);
  });

  it("requires production authentication secrets to come from a file", () => {
    const production = {
      ...BASE,
      DASHBOARD_ENVIRONMENT: "production",
      DASHBOARD_ORIGIN: "https://dashboard.esmii.app",
      DASHBOARD_PEER_ORIGIN: "https://staging-dashboard.esmii.app",
      NODE_ENV: "production",
    } as const;
    expect(() => parseDashboardAuthConfig(production)).toThrow(/SECRET_FILE/u);
    const config = parseDashboardAuthConfig(
      {
        ...production,
        DASHBOARD_AUTH_SECRET: undefined,
        DASHBOARD_AUTH_SECRET_FILE: "/run/secrets/dashboard-auth-secret",
      },
      () => "production-test-secret-material-over-thirty-two-characters\n",
    );
    expect(config.secret).toBe("production-test-secret-material-over-thirty-two-characters");
  });
});
