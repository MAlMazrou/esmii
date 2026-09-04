import type { MonitoringServerConfig } from "../config/server.ts";
import {
  decodeLogCursor,
  encodeLogCursor,
  readSanitizedLogs,
  type LogQuery,
} from "./log-source.ts";
import {
  applicationPlaceholder,
  fixtureHost,
  fixtureJobs,
  fixtureLogs,
  fixtureSeries,
  fixtureServices,
} from "./fixtures.ts";
import {
  getMetricDefinition,
  METRIC_IDS,
  metricState,
  timeRangeWindow,
} from "./metric-registry.ts";
import { PrometheusClient, type PrometheusSample } from "./prometheus-client.ts";
import type {
  ApplicationMonitoringResponse,
  DataFreshness,
  HostMetric,
  JobStatus,
  LogsResponse,
  MetricId,
  MetricSeries,
  MonitoringEnvironment,
  OverviewResponse,
  SanitizedLogEntry,
  ServiceStatus,
  TimeRange,
} from "./types.ts";

const SERVICE_CATALOG = {
  api: { kind: "api", name: "API" },
  caddy: { kind: "edge", name: "Caddy" },
  mailpit: { kind: "mail", name: "Mailpit" },
  postgres: { kind: "database", name: "PostgreSQL" },
  stalwart: { kind: "mail", name: "Stalwart Mail" },
  valkey: { kind: "cache", name: "Valkey" },
  web: { kind: "web", name: "Web application" },
  worker: { kind: "worker", name: "Background worker" },
} as const satisfies Readonly<
  Record<string, { readonly kind: ServiceStatus["kind"]; readonly name: string }>
>;

const SERVICE_QUERIES = {
  cpu: 'max by (service) (esmii_container_cpu_percent{service!=""})',
  healthConfigured: 'max by (service) (esmii_container_healthcheck_configured{service!=""})',
  healthStatus: 'max by (service) (esmii_container_health_status{service!=""})',
  heartbeat: 'max by (service) (esmii_worker_heartbeat_timestamp_seconds{service!=""})',
  instances: 'max by (service) (esmii_container_instance_count{service!=""})',
  lastRestart: 'max by (service) (esmii_container_last_restart_timestamp_seconds{service!=""})',
  memory: 'max by (service) (esmii_container_memory_usage_bytes{service!=""})',
  oom: 'max by (service) (esmii_container_oom_killed{service!=""})',
  restart: 'max by (service) (esmii_container_restart_count_current{service!=""})',
  rollingRestart: 'max by (service) (esmii_container_restart_count_rolling_24h{service!=""})',
  start: 'max by (service) (esmii_container_started_timestamp_seconds{service!=""})',
  up: 'max by (service) (esmii_container_running{service!=""})',
} as const;

const HOST_FRESHNESS_QUERY = "time() - max(timestamp(node_exporter_build_info))";
const COLLECTOR_FRESHNESS_QUERY =
  "time() - max(esmii_monitoring_collector_last_success_timestamp_seconds)";

const JOB_QUERIES = {
  active: "max by (unit) (esmii_systemd_timer_active)",
  lastExit: "max by (unit) (esmii_systemd_service_last_exit_timestamp_seconds)",
  lastTrigger: "max by (unit) (esmii_systemd_timer_last_trigger_timestamp_seconds)",
  nextTrigger: "max by (unit) (esmii_systemd_timer_next_trigger_timestamp_seconds)",
  success: "max by (unit) (esmii_systemd_service_last_run_success)",
} as const;

function latest(samples: readonly PrometheusSample[]): PrometheusSample | null {
  return samples.reduce<PrometheusSample | null>(
    (current, sample) =>
      current === null || sample.timestamp > current.timestamp ? sample : current,
    null,
  );
}

function sampleMap(
  samples: readonly PrometheusSample[],
  label: string,
): Map<string, PrometheusSample> {
  const map = new Map<string, PrometheusSample>();
  for (const sample of samples) {
    const key = sample.labels[label];
    if (key !== undefined) map.set(key, sample);
  }
  return map;
}

function numberAt(map: ReadonlyMap<string, PrometheusSample>, key: string): number | null {
  return map.get(key)?.value ?? null;
}

function dateFromSeconds(value: number | null): string | null {
  if (value === null || value <= 0) return null;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function freshnessFromMetrics(metrics: readonly HostMetric[], now = new Date()): DataFreshness {
  const latestTime = Math.max(
    ...metrics.map((metric) =>
      metric.sampleAt === null ? Number.NaN : Date.parse(metric.sampleAt),
    ),
  );
  if (!Number.isFinite(latestTime))
    return { ageSeconds: null, label: "Metrics unavailable", state: "offline" };
  const ageSeconds = Math.max(0, Math.round((now.getTime() - latestTime) / 1_000));
  if (ageSeconds > 300) return { ageSeconds, label: "Metrics offline", state: "offline" };
  if (ageSeconds > 90) return { ageSeconds, label: "Metrics delayed", state: "stale" };
  return { ageSeconds, label: "Live metrics", state: "fresh" };
}

export interface MonitoringRepository {
  application(): Promise<ApplicationMonitoringResponse>;
  jobs(): Promise<readonly JobStatus[]>;
  logs(query: LogQuery): Promise<LogsResponse>;
  overview(): Promise<OverviewResponse>;
  series(id: MetricId, range: TimeRange): Promise<readonly MetricSeries[]>;
  services(): Promise<readonly ServiceStatus[]>;
}

export class DashboardMonitoringRepository implements MonitoringRepository {
  readonly #client: PrometheusClient | null;
  readonly #config: MonitoringServerConfig;

  constructor(config: MonitoringServerConfig, injectedClient?: PrometheusClient) {
    this.#config = config;
    this.#client = config.fixtureMode
      ? null
      : (injectedClient ??
        new PrometheusClient({
          baseUrl: config.prometheusUrl ?? "",
          timeoutMs: config.prometheusTimeoutMs,
        }));
  }

  get environment(): MonitoringEnvironment {
    return this.#config.environment;
  }

  async #host(): Promise<readonly HostMetric[]> {
    if (this.#config.fixtureMode) return fixtureHost(this.environment);
    const client = this.#client;
    if (client === null) return [];
    let scrapeAgeSeconds: number | null;
    try {
      scrapeAgeSeconds = latest(await client.query(HOST_FRESHNESS_QUERY))?.value ?? null;
    } catch {
      scrapeAgeSeconds = null;
    }
    const stale = scrapeAgeSeconds === null || scrapeAgeSeconds > 90;
    const sampleAt =
      scrapeAgeSeconds === null
        ? null
        : new Date(Date.now() - Math.max(0, scrapeAgeSeconds) * 1_000).toISOString();
    return Promise.all(
      METRIC_IDS.map(async (id): Promise<HostMetric> => {
        const definition = getMetricDefinition(id);
        try {
          const sample = latest(await client.query(definition.query));
          const value = sample?.value ?? null;
          return {
            id,
            label: definition.label,
            sampleAt,
            state: stale ? "unknown" : metricState(definition, value),
            unit: definition.unit,
            value,
          };
        } catch {
          return {
            id,
            label: definition.label,
            sampleAt: null,
            state: "unknown",
            unit: definition.unit,
            value: null,
          };
        }
      }),
    );
  }

  async series(id: MetricId, range: TimeRange): Promise<readonly MetricSeries[]> {
    if (this.#config.fixtureMode) return fixtureSeries(this.environment, id, range);
    const client = this.#client;
    if (client === null) return [];
    const definition = getMetricDefinition(id);
    const window = timeRangeWindow(range);
    const result = await client.queryRange({ ...window, query: definition.query });
    return result.map((item, index) => ({
      id: item.labels.instance ?? `${id}-${index + 1}`,
      label: item.labels.instance ?? definition.label,
      points: item.samples.map((sample) => ({
        timestamp: sample.timestamp.toISOString(),
        value: sample.value,
      })),
      state: metricState(definition, item.samples.at(-1)?.value ?? null),
      unit: definition.unit,
    }));
  }

  async services(): Promise<readonly ServiceStatus[]> {
    if (this.#config.fixtureMode) return fixtureServices(this.environment);
    const client = this.#client;
    if (client === null) return [];
    const [results, deploymentSamples, collectorFreshnessSamples] = await Promise.all([
      Promise.all(
        Object.entries(SERVICE_QUERIES).map(async ([name, query]) => {
          try {
            return [name, await client.query(query)] as const;
          } catch {
            return [name, []] as const;
          }
        }),
      ),
      client.query(`esmii_deployment_info{environment="${this.environment}"}`).catch(() => []),
      client.query(COLLECTOR_FRESHNESS_QUERY).catch(() => []),
    ]);
    const deploymentRevision = latest(deploymentSamples)?.labels.revision?.slice(0, 64) ?? null;
    const collectorAge = latest(collectorFreshnessSamples)?.value ?? null;
    const maps = Object.fromEntries(
      results.map(([name, samples]) => [name, sampleMap(samples, "service")]),
    ) as Record<keyof typeof SERVICE_QUERIES, Map<string, PrometheusSample>>;
    const ids = Object.keys(SERVICE_CATALOG).filter((id) => {
      if (id === "mailpit") return this.environment === "staging";
      if (id === "stalwart") return this.environment === "production";
      return true;
    });
    return ids.map((id): ServiceStatus => {
      const catalog = SERVICE_CATALOG[id as keyof typeof SERVICE_CATALOG];
      const metricId = id === "caddy" ? id : `${this.environment}-${id}`;
      const up = numberAt(maps.up, metricId);
      const stale = collectorAge === null || collectorAge > 90;
      const heartbeat = dateFromSeconds(numberAt(maps.heartbeat, metricId));
      const heartbeatAge = heartbeat === null ? null : (Date.now() - Date.parse(heartbeat)) / 1_000;
      const healthConfigured = numberAt(maps.healthConfigured, metricId);
      const healthStatus = numberAt(maps.healthStatus, metricId);
      const instances = numberAt(maps.instances, metricId);
      const oomKilled = numberAt(maps.oom, metricId);
      const rollingRestartCount = numberAt(maps.rollingRestart, metricId);
      const status: ServiceStatus["status"] = (() => {
        if (stale || up === null) return "unknown";
        if (up < 1) return "down";
        if (
          instances === null ||
          oomKilled === null ||
          rollingRestartCount === null ||
          healthConfigured === null ||
          healthStatus === null
        ) {
          return "unknown";
        }
        if (
          instances !== 1 ||
          oomKilled === 1 ||
          rollingRestartCount >= 1 ||
          (healthConfigured === 1 && healthStatus !== 2) ||
          (id === "worker" && (heartbeatAge === null || heartbeatAge > 180))
        ) {
          return "degraded";
        }
        return "running";
      })();
      return {
        cpuPercent: numberAt(maps.cpu, metricId),
        health:
          status === "running"
            ? "healthy"
            : status === "down"
              ? "down"
              : status === "degraded"
                ? "degraded"
                : "unknown",
        id,
        kind: catalog.kind,
        lastRestartAt: dateFromSeconds(numberAt(maps.lastRestart, metricId)),
        lastStartAt: dateFromSeconds(numberAt(maps.start, metricId)),
        memoryBytes: numberAt(maps.memory, metricId),
        name: catalog.name,
        oomKilled: oomKilled === null ? null : oomKilled > 0,
        restartCount: numberAt(maps.restart, metricId),
        revision: id === "caddy" ? null : deploymentRevision,
        rollingRestartCount,
        status,
        workerHeartbeatAt: heartbeat,
      };
    });
  }

  async jobs(): Promise<readonly JobStatus[]> {
    if (this.#config.fixtureMode) return fixtureJobs();
    const client = this.#client;
    if (client === null) return [];
    const [results, migrationSamples, collectorFreshnessSamples] = await Promise.all([
      Promise.all(
        Object.entries(JOB_QUERIES).map(async ([name, query]) => {
          try {
            return [name, await client.query(query)] as const;
          } catch {
            return [name, []] as const;
          }
        }),
      ),
      client
        .query(`esmii_migration_last_success_timestamp_seconds{environment="${this.environment}"}`)
        .catch(() => []),
      client.query(COLLECTOR_FRESHNESS_QUERY).catch(() => []),
    ]);
    const collectorAge = latest(collectorFreshnessSamples)?.value ?? null;
    const collectorStale = collectorAge === null || collectorAge > 90;
    const maps = Object.fromEntries(
      results.map(([name, samples]) => [name, sampleMap(samples, "unit")]),
    ) as Record<keyof typeof JOB_QUERIES, Map<string, PrometheusSample>>;
    const timers = [...maps.active.entries()].map(([id, sample]): JobStatus => {
      const active = sample.value;
      const success = numberAt(maps.success, id);
      const status: JobStatus["status"] = collectorStale
        ? "unknown"
        : active < 1
          ? "failed"
          : success === 0
            ? "failed"
            : "scheduled";
      const lastTrigger = numberAt(maps.lastTrigger, id);
      const lastExit = numberAt(maps.lastExit, id);
      const durationMs =
        lastTrigger !== null && lastExit !== null && lastExit >= lastTrigger
          ? (lastExit - lastTrigger) * 1_000
          : null;
      return {
        attempts: null,
        durationMs,
        id: id.slice(0, 64),
        kind: id.includes("pull") || id.includes("reconciler") ? "deployment" : "scheduled",
        lastRunAt: dateFromSeconds(lastExit ?? lastTrigger),
        name: id
          .replace(/^esmii-/u, "")
          .replace(/\.timer$/u, "")
          .replaceAll("-", " ")
          .slice(0, 96),
        nextRunAt: dateFromSeconds(numberAt(maps.nextTrigger, id)),
        queueDepth: null,
        state: status === "failed" ? "critical" : status === "unknown" ? "unknown" : "healthy",
        status,
      };
    });
    const migration = latest(migrationSamples);
    return [
      ...timers,
      {
        attempts: null,
        durationMs: null,
        id: "recent-migration",
        kind: "deployment",
        lastRunAt: dateFromSeconds(migration?.value ?? null),
        name: "Recent database migration",
        nextRunAt: null,
        queueDepth: null,
        state: collectorStale || migration === null || migration.value <= 0 ? "unknown" : "healthy",
        status: collectorStale || migration === null || migration.value <= 0 ? "unknown" : "idle",
      },
    ];
  }

  async logs(query: LogQuery): Promise<LogsResponse> {
    let entries: readonly SanitizedLogEntry[];
    if (this.#config.fixtureMode) {
      const cursor = query.cursor;
      entries = fixtureLogs()
        .filter((entry) => {
          if (cursor !== null && entry.timestamp >= cursor.timestamp) return false;
          if (query.service !== null && entry.service !== query.service) return false;
          if (query.severity !== null && entry.severity !== query.severity) return false;
          if (
            query.search !== null &&
            !entry.message.toLowerCase().includes(query.search.toLowerCase())
          )
            return false;
          return true;
        })
        .slice(0, query.limit);
    } else {
      if (this.#config.logFile === null) throw new Error("Log source is unavailable");
      entries = await readSanitizedLogs(this.#config.logFile, this.#config.logMaxBytes, query);
    }
    const last = entries.at(-1);
    return {
      environment: this.environment,
      generatedAt: new Date().toISOString(),
      logs: entries,
      nextCursor:
        entries.length === query.limit && last !== undefined ? encodeLogCursor(last) : null,
    };
  }

  async application(): Promise<ApplicationMonitoringResponse> {
    return applicationPlaceholder(this.environment);
  }

  async overview(): Promise<OverviewResponse> {
    const now = new Date();
    const [host, services, jobs, logs, cpuSeries, memorySeries, application] = await Promise.all([
      this.#host(),
      this.services(),
      this.jobs(),
      this.logs({ cursor: null, limit: 5, search: null, service: null, severity: null }),
      this.series("cpu_usage", "6h").catch(() => []),
      this.series("memory_usage", "6h").catch(() => []),
      this.application(),
    ]);
    return {
      application,
      environment: this.environment,
      freshness: freshnessFromMetrics(host, now),
      generatedAt: now.toISOString(),
      host,
      jobs,
      recentLogs: logs.logs,
      resourceSeries: [...cpuSeries, ...memorySeries],
      services,
    };
  }
}

export function parseCursor(value: string | null): ReturnType<typeof decodeLogCursor> {
  return decodeLogCursor(value);
}
