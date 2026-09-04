import { getMetricDefinition, metricState } from "./metric-registry.ts";
import type {
  ApplicationMonitoringResponse,
  HostMetric,
  JobStatus,
  MetricId,
  MetricSeries,
  MonitoringEnvironment,
  SanitizedLogEntry,
  ServiceStatus,
  TimeRange,
} from "./types.ts";

const HOST_VALUES: Readonly<Record<MetricId, number>> = {
  cpu_usage: 28.4,
  disk_read: 384_000,
  disk_usage: 41.8,
  disk_write: 172_000,
  load_average: 0.82,
  memory_available: 3_280_000_000,
  memory_usage: 57.3,
  network_errors: 0,
  network_receive: 812_000,
  network_transmit: 336_000,
  root_inode_usage: 11.6,
  swap_usage: 32_000_000,
  uptime: 1_428_360,
};

function environmentOffset(environment: MonitoringEnvironment): number {
  return environment === "staging" ? 4.7 : 0;
}

export function fixtureHost(
  environment: MonitoringEnvironment,
  at = new Date(),
): readonly HostMetric[] {
  return (Object.keys(HOST_VALUES) as MetricId[]).map((id) => {
    const definition = getMetricDefinition(id);
    const raw = HOST_VALUES[id] + (id === "uptime" ? 0 : environmentOffset(environment));
    return {
      id,
      label: definition.label,
      sampleAt: at.toISOString(),
      state: metricState(definition, raw),
      unit: definition.unit,
      value: raw,
    };
  });
}

export function fixtureSeries(
  environment: MonitoringEnvironment,
  id: MetricId,
  range: TimeRange,
  at = new Date(),
): readonly MetricSeries[] {
  const definition = getMetricDefinition(id);
  const rangeHours = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 }[range];
  const pointCount = 48;
  const baseline = HOST_VALUES[id] + (id === "uptime" ? 0 : environmentOffset(environment));
  const amplitude =
    definition.unit === "percent" ? Math.max(2, baseline * 0.12) : Math.max(0.4, baseline * 0.18);
  const points = Array.from({ length: pointCount }, (_, index) => {
    const progress = index / (pointCount - 1);
    const value = Math.max(0, baseline + Math.sin(progress * Math.PI * 3.2) * amplitude);
    return {
      timestamp: new Date(at.getTime() - (1 - progress) * rangeHours * 3_600_000).toISOString(),
      value,
    };
  });
  return [
    {
      id,
      label: definition.label,
      points,
      state: metricState(definition, points.at(-1)?.value ?? null),
      unit: definition.unit,
    },
  ];
}

export function fixtureServices(
  environment: MonitoringEnvironment,
  at = new Date(),
): readonly ServiceStatus[] {
  const common: readonly Omit<ServiceStatus, "id" | "kind" | "name">[] = [
    {
      cpuPercent: 3.6,
      health: "healthy",
      lastRestartAt: new Date(at.getTime() - 7 * 86_400_000).toISOString(),
      lastStartAt: new Date(at.getTime() - 7 * 86_400_000).toISOString(),
      memoryBytes: 182_000_000,
      oomKilled: false,
      restartCount: 1,
      revision: "fixture-4f91a2c",
      rollingRestartCount: 0,
      status: "running",
      workerHeartbeatAt: null,
    },
  ];
  const base = common[0];
  if (base === undefined) return [];
  const rows: Array<Pick<ServiceStatus, "id" | "kind" | "name">> = [
    { id: "web", kind: "web", name: "Web application" },
    { id: "api", kind: "api", name: "API" },
    { id: "worker", kind: "worker", name: "Background worker" },
    { id: "postgres", kind: "database", name: "PostgreSQL" },
    { id: "valkey", kind: "cache", name: "Valkey" },
    { id: "caddy", kind: "edge", name: "Caddy" },
    {
      id: environment === "staging" ? "mailpit" : "stalwart",
      kind: "mail",
      name: environment === "staging" ? "Mailpit" : "Stalwart Mail",
    },
  ];
  return rows.map((row, index) => ({
    ...base,
    ...row,
    cpuPercent: base.cpuPercent === null ? null : base.cpuPercent + index * 0.7,
    memoryBytes: base.memoryBytes === null ? null : base.memoryBytes + index * 11_000_000,
    restartCount: index === 2 ? 2 : base.restartCount,
    workerHeartbeatAt: row.kind === "worker" ? new Date(at.getTime() - 18_000).toISOString() : null,
  }));
}

export function fixtureJobs(at = new Date()): readonly JobStatus[] {
  return [
    {
      attempts: 1,
      durationMs: 1_840,
      id: "outbound-mail",
      kind: "queue",
      lastRunAt: new Date(at.getTime() - 82_000).toISOString(),
      name: "Outbound mail",
      nextRunAt: null,
      queueDepth: 0,
      state: "healthy",
      status: "idle",
    },
    {
      attempts: 1,
      durationMs: 12_200,
      id: "backup-verification",
      kind: "scheduled",
      lastRunAt: new Date(at.getTime() - 21_600_000).toISOString(),
      name: "Backup verification",
      nextRunAt: new Date(at.getTime() + 64_800_000).toISOString(),
      queueDepth: null,
      state: "healthy",
      status: "scheduled",
    },
    {
      attempts: 1,
      durationMs: null,
      id: "recent-migration",
      kind: "deployment",
      lastRunAt: new Date(at.getTime() - 2 * 86_400_000).toISOString(),
      name: "Recent database migration",
      nextRunAt: null,
      queueDepth: null,
      state: "healthy",
      status: "idle",
    },
  ];
}

export function fixtureLogs(at = new Date()): readonly SanitizedLogEntry[] {
  return [
    {
      id: "fixture-log-1",
      message: "Upstream request retried after a transient connection reset",
      requestId: "fixture-req-a1",
      service: "api",
      severity: "warning",
      timestamp: new Date(at.getTime() - 7 * 60_000).toISOString(),
    },
    {
      id: "fixture-log-2",
      message: "Scheduled job reached its retry threshold and will run again",
      requestId: null,
      service: "worker",
      severity: "error",
      timestamp: new Date(at.getTime() - 42 * 60_000).toISOString(),
    },
  ];
}

export function applicationPlaceholder(
  environment: MonitoringEnvironment,
  at = new Date(),
): ApplicationMonitoringResponse {
  return {
    environment,
    generatedAt: at.toISOString(),
    metrics: [
      {
        description: "Ready for server-side request duration histograms.",
        id: "response_time_p95",
        state: "not_instrumented",
        title: "P95 response time",
      },
      {
        description: "Ready for request outcome counters.",
        id: "error_rate",
        state: "not_instrumented",
        title: "Error rate",
      },
      {
        description: "Ready for normalized HTTP request counters.",
        id: "request_count",
        state: "not_instrumented",
        title: "Request volume",
      },
    ],
    status: "not_instrumented",
  };
}
