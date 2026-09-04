import { describe, expect, it } from "vitest";

import { DashboardMonitoringRepository } from "../lib/monitoring/repository.ts";
import type { PrometheusClient, PrometheusSample } from "../lib/monitoring/prometheus-client.ts";

const LIVE_CONFIG = {
  environment: "staging",
  fixtureMode: false,
  logFile: "/private/tmp/unused-monitoring-log.ndjson",
  logMaxBytes: 1_048_576,
  origin: "https://staging-dashboard.esmii.app",
  peerOrigin: "https://dashboard.esmii.app",
  prometheusTimeoutMs: 1_000,
  prometheusUrl: "http://staging-prometheus:9090",
  themeFixture: null,
} as const;

function sample(value: number, labels: Readonly<Record<string, string>> = {}): PrometheusSample {
  return { labels, timestamp: new Date("2026-09-02T12:00:00.000Z"), value };
}

function serviceClient(options: {
  readonly collectorAge: number;
  readonly rollingRestarts: number;
}) {
  return {
    async query(query: string): Promise<readonly PrometheusSample[]> {
      if (query.includes("esmii_monitoring_collector_last_success_timestamp_seconds")) {
        return [sample(options.collectorAge)];
      }
      if (query.includes("esmii_deployment_info")) {
        return [sample(1, { environment: "staging", revision: "a".repeat(40) })];
      }
      const metricValues: Readonly<Record<string, number>> = {
        esmii_container_cpu_percent: 4,
        esmii_container_healthcheck_configured: 1,
        esmii_container_health_status: 2,
        esmii_container_instance_count: 1,
        esmii_container_last_restart_timestamp_seconds: 0,
        esmii_container_memory_usage_bytes: 100,
        esmii_container_oom_killed: 0,
        esmii_container_restart_count_current: options.rollingRestarts,
        esmii_container_restart_count_rolling_24h: options.rollingRestarts,
        esmii_container_running: 1,
        esmii_container_started_timestamp_seconds: 1_788_350_000,
      };
      for (const [metric, value] of Object.entries(metricValues)) {
        if (query.includes(metric)) return [sample(value, { service: "staging-api" })];
      }
      return [];
    },
  } as unknown as PrometheusClient;
}

describe("fixture repository", () => {
  it("keeps synthetic data environment-fixed and preserves the future application contract", async () => {
    const repository = new DashboardMonitoringRepository({
      environment: "staging",
      fixtureMode: true,
      logFile: null,
      logMaxBytes: 1_048_576,
      origin: "http://127.0.0.1:3010",
      peerOrigin: "http://localhost:3011",
      prometheusTimeoutMs: 1_000,
      prometheusUrl: null,
      themeFixture: null,
    });
    const [overview, application] = await Promise.all([
      repository.overview(),
      repository.application(),
    ]);
    expect(overview.environment).toBe("staging");
    expect(overview.services.some((service) => service.id === "mailpit")).toBe(true);
    expect(overview.services.some((service) => service.id === "stalwart")).toBe(false);
    expect(application.status).toBe("not_instrumented");
    expect(application.metrics.map((metric) => metric.id)).toEqual([
      "response_time_p95",
      "error_rate",
      "request_count",
    ]);
  });

  it("uses explicit collector freshness and restart metrics for service state", async () => {
    const restarted = new DashboardMonitoringRepository(
      LIVE_CONFIG,
      serviceClient({ collectorAge: 10, rollingRestarts: 1 }),
    );
    expect((await restarted.services()).find((service) => service.id === "api")?.health).toBe(
      "degraded",
    );

    const stale = new DashboardMonitoringRepository(
      LIVE_CONFIG,
      serviceClient({ collectorAge: 91, rollingRestarts: 0 }),
    );
    expect((await stale.services()).find((service) => service.id === "api")?.health).toBe(
      "unknown",
    );
  });
});
