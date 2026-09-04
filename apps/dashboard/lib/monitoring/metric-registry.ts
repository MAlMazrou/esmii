import type { MetricId, MetricUnit, TimeRange } from "./types.ts";

export interface MetricDefinition {
  readonly id: MetricId;
  readonly label: string;
  readonly query: string;
  readonly unit: MetricUnit;
  readonly warningAbove?: number;
  readonly criticalAbove?: number;
}

const METRICS = {
  cpu_usage: {
    id: "cpu_usage",
    label: "CPU usage",
    query: '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
    unit: "percent",
    warningAbove: 85,
  },
  memory_usage: {
    id: "memory_usage",
    label: "Memory usage",
    query: "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100",
    unit: "percent",
    warningAbove: 80,
  },
  memory_available: {
    id: "memory_available",
    label: "Memory available",
    query: "node_memory_MemAvailable_bytes",
    unit: "bytes",
  },
  disk_usage: {
    id: "disk_usage",
    label: "Disk usage",
    query:
      '(1 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) * 100',
    unit: "percent",
    warningAbove: 60,
    criticalAbove: 80,
  },
  root_inode_usage: {
    id: "root_inode_usage",
    label: "Root inode usage",
    query:
      'max((1 - (node_filesystem_files_free{mountpoint="/"} / node_filesystem_files{mountpoint="/"})) * 100)',
    unit: "percent",
    warningAbove: 60,
    criticalAbove: 80,
  },
  swap_usage: {
    id: "swap_usage",
    label: "Swap usage",
    query: "node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes",
    unit: "bytes",
    warningAbove: 134217728,
  },
  disk_read: {
    id: "disk_read",
    label: "Disk read",
    query: 'sum(rate(node_disk_read_bytes_total{device!~"loop.*|ram.*"}[5m]))',
    unit: "bytes_per_second",
  },
  disk_write: {
    id: "disk_write",
    label: "Disk write",
    query: 'sum(rate(node_disk_written_bytes_total{device!~"loop.*|ram.*"}[5m]))',
    unit: "bytes_per_second",
  },
  load_average: {
    id: "load_average",
    label: "Load average",
    query: "node_load1",
    unit: "short",
    warningAbove: 4,
  },
  network_receive: {
    id: "network_receive",
    label: "Network received",
    query: 'sum(rate(node_network_receive_bytes_total{device!~"lo|veth.*|br-.*"}[5m]))',
    unit: "bytes_per_second",
  },
  network_transmit: {
    id: "network_transmit",
    label: "Network sent",
    query: 'sum(rate(node_network_transmit_bytes_total{device!~"lo|veth.*|br-.*"}[5m]))',
    unit: "bytes_per_second",
  },
  network_errors: {
    id: "network_errors",
    label: "Network errors",
    query:
      'sum(rate(node_network_receive_errs_total{device!~"lo|veth.*|br-.*"}[5m]) + rate(node_network_transmit_errs_total{device!~"lo|veth.*|br-.*"}[5m]))',
    unit: "count_per_second",
  },
  uptime: {
    id: "uptime",
    label: "Uptime",
    query: "time() - node_boot_time_seconds",
    unit: "seconds",
  },
} as const satisfies Record<MetricId, MetricDefinition>;

export const METRIC_IDS = Object.freeze(Object.keys(METRICS) as MetricId[]);

export function getMetricDefinition(id: MetricId): MetricDefinition {
  return METRICS[id];
}

export function parseMetricId(value: string | null): MetricId | null {
  return value !== null && Object.hasOwn(METRICS, value) ? (value as MetricId) : null;
}

const RANGE_SECONDS: Readonly<Record<TimeRange, number>> = {
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
};

export function parseTimeRange(value: string | null): TimeRange | null {
  return value !== null && Object.hasOwn(RANGE_SECONDS, value) ? (value as TimeRange) : null;
}

export function timeRangeWindow(
  range: TimeRange,
  now = new Date(),
): {
  readonly end: Date;
  readonly start: Date;
  readonly stepSeconds: number;
} {
  const seconds = RANGE_SECONDS[range];
  return {
    end: now,
    start: new Date(now.getTime() - seconds * 1_000),
    stepSeconds: Math.max(30, Math.ceil(seconds / 240)),
  };
}

export function metricState(
  definition: MetricDefinition,
  value: number | null,
): "critical" | "healthy" | "unknown" | "warning" {
  if (value === null) return "unknown";
  if (definition.criticalAbove !== undefined && value >= definition.criticalAbove)
    return "critical";
  if (definition.warningAbove !== undefined && value >= definition.warningAbove) return "warning";
  return "healthy";
}
