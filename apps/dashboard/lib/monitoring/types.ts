export type Environment = "production" | "staging";

export type MonitoringEnvironment = Environment;

export type HealthState = "degraded" | "down" | "healthy" | "unknown";

export type MetricState = "critical" | "healthy" | "unknown" | "warning";

export type SemanticTone = MetricState;

export type SemanticState = MetricState;

export type FreshnessState = "fresh" | "offline" | "stale";

export type MetricUnit =
  "bytes" | "bytes_per_second" | "count" | "count_per_second" | "percent" | "seconds" | "short";

export type MetricId =
  | "cpu_usage"
  | "disk_usage"
  | "disk_read"
  | "disk_write"
  | "load_average"
  | "memory_available"
  | "memory_usage"
  | "network_errors"
  | "network_receive"
  | "network_transmit"
  | "root_inode_usage"
  | "swap_usage"
  | "uptime";

export type Range = "1h" | "6h" | "24h" | "7d";

export type TimeRange = Range;

export interface MetricPoint {
  readonly timestamp: string;
  readonly value: number;
}

export interface MetricSeries {
  readonly id: string;
  readonly label: string;
  readonly points: readonly MetricPoint[];
  readonly state: SemanticState;
  readonly unit: MetricUnit;
}

export interface HostMetric {
  readonly id: MetricId;
  readonly label: string;
  readonly sampleAt: string | null;
  readonly state: SemanticState;
  readonly unit: MetricUnit;
  readonly value: number | null;
}

export interface DataFreshness {
  readonly ageSeconds: number | null;
  readonly label: string;
  readonly state: FreshnessState;
}

export interface ServiceStatus {
  readonly cpuPercent: number | null;
  readonly health: HealthState;
  readonly id: string;
  readonly kind: "api" | "cache" | "database" | "edge" | "mail" | "web" | "worker";
  readonly lastStartAt: string | null;
  readonly lastRestartAt: string | null;
  readonly memoryBytes: number | null;
  readonly name: string;
  readonly oomKilled: boolean | null;
  readonly revision: string | null;
  readonly restartCount: number | null;
  readonly rollingRestartCount: number | null;
  readonly status: "degraded" | "down" | "running" | "unknown";
  readonly workerHeartbeatAt: string | null;
}

export interface JobStatus {
  readonly attempts: number | null;
  readonly durationMs: number | null;
  readonly id: string;
  readonly kind: "deployment" | "queue" | "scheduled" | "worker";
  readonly lastRunAt: string | null;
  readonly name: string;
  readonly nextRunAt: string | null;
  readonly queueDepth: number | null;
  readonly state: SemanticState;
  readonly status: "failed" | "idle" | "running" | "scheduled" | "unknown";
}

export type LogSeverity = "error" | "warning";

export interface SanitizedLogEntry {
  readonly id: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly service: string;
  readonly severity: LogSeverity;
  readonly timestamp: string;
}

export interface ApplicationMetricPlaceholder {
  readonly description: string;
  readonly id: "error_rate" | "request_count" | "response_time_p95";
  readonly state: "not_instrumented";
  readonly title: string;
}

export interface ApplicationMetricAvailable {
  readonly description: string;
  readonly id: "error_rate" | "request_count" | "response_time_p95";
  readonly series: readonly MetricSeries[];
  readonly state: "available";
  readonly title: string;
  readonly unit: MetricUnit;
  readonly value: number;
}

export type ApplicationMetricCard = ApplicationMetricAvailable | ApplicationMetricPlaceholder;

export interface ApplicationMonitoringResponse {
  readonly environment: MonitoringEnvironment;
  readonly generatedAt: string;
  readonly metrics: readonly ApplicationMetricCard[];
  readonly status: "available" | "not_instrumented";
}

export interface OverviewResponse {
  readonly application: ApplicationMonitoringResponse;
  readonly environment: MonitoringEnvironment;
  readonly freshness: DataFreshness;
  readonly generatedAt: string;
  readonly host: readonly HostMetric[];
  readonly jobs: readonly JobStatus[];
  readonly recentLogs: readonly SanitizedLogEntry[];
  readonly resourceSeries: readonly MetricSeries[];
  readonly services: readonly ServiceStatus[];
}

export interface SeriesResponse {
  readonly environment: MonitoringEnvironment;
  readonly generatedAt: string;
  readonly metric: MetricId;
  readonly range: TimeRange;
  readonly series: readonly MetricSeries[];
}

export interface ServicesResponse {
  readonly environment: MonitoringEnvironment;
  readonly generatedAt: string;
  readonly services: readonly ServiceStatus[];
}

export interface JobsResponse {
  readonly environment: MonitoringEnvironment;
  readonly generatedAt: string;
  readonly jobs: readonly JobStatus[];
}

export interface LogsResponse {
  readonly environment: MonitoringEnvironment;
  readonly generatedAt: string;
  readonly logs: readonly SanitizedLogEntry[];
  readonly nextCursor: string | null;
}

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}
