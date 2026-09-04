"use client";

import type {
  HealthState,
  HostMetric,
  MetricSeries,
  SemanticTone,
  SanitizedLogEntry,
  ServiceStatus,
} from "../lib/monitoring/types.ts";
import { formatMetric } from "../design-system/data/format.ts";
import { AlertIcon, DatabaseIcon, ServerIcon } from "./icons.tsx";
import { useDashboardEnvironment } from "./environment-context.tsx";

export function PageHeading({
  eyebrow,
  subtitle,
  title,
}: Readonly<{ eyebrow: string; subtitle: string; title: string }>) {
  const environment = useDashboardEnvironment();
  return (
    <header className="page-heading">
      <div>
        <p className="eyebrow">
          {environment} · {eyebrow}
        </p>
        <h1>{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <StatusPill label={`${environment} realm`} state="unknown" />
    </header>
  );
}

export function QueryBanner({
  error,
  refreshing,
  stale,
  onRetry,
}: Readonly<{ error: string | null; refreshing: boolean; stale: boolean; onRetry: () => void }>) {
  if (error === null && !stale && !refreshing) return null;
  const tone = error === null ? "warning" : "critical";
  const message =
    error ?? (stale ? "The displayed snapshot is older than 90 seconds." : "Refreshing metrics…");
  return (
    <div className="banner" data-tone={tone} role={error === null ? "status" : "alert"}>
      <span>{message}</span>
      {error === null ? null : (
        <button className="button secondary" onClick={onRetry} type="button">
          Retry
        </button>
      )}
    </div>
  );
}

export function StatusPill({ label, state }: Readonly<{ label: string; state: SemanticTone }>) {
  const symbol =
    state === "healthy" ? "●" : state === "warning" ? "▲" : state === "critical" ? "◆" : "■";
  return (
    <span aria-label={`${label}, ${state} state`} className="status-pill" data-state={state}>
      <span aria-hidden="true" className="status-symbol">
        {symbol}
      </span>
      {label}
    </span>
  );
}

function healthTone(state: HealthState): SemanticTone {
  return state === "down" ? "critical" : state === "degraded" ? "warning" : state;
}

export { formatMetric } from "../design-system/data/format.ts";

export function relativeTime(value: string | null): string {
  if (value === null) return "Never";
  const difference = Date.now() - Date.parse(value);
  if (!Number.isFinite(difference)) return "Unknown";
  const seconds = Math.max(0, Math.round(difference / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function MetricCard({ metric }: Readonly<{ metric: HostMetric }>) {
  return (
    <article className="metric-card" data-state={metric.state}>
      <div className="metric-label">
        <span>{metric.label}</span>
        <StatusPill label={metric.state} state={metric.state} />
      </div>
      <div className="metric-value">{formatMetric(metric.value, metric.unit)}</div>
      <div className="metric-note">Sample {relativeTime(metric.sampleAt)}</div>
    </article>
  );
}

export function MetricSkeletons({ count = 8 }: Readonly<{ count?: number }>) {
  return (
    <div className="metric-grid" aria-label="Loading metrics">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton skeleton-card" key={index} />
      ))}
    </div>
  );
}

export function LineChart({ series }: Readonly<{ series: readonly MetricSeries[] }>) {
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const width = 720;
  const height = 230;
  const inset = 28;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, 1);
  const points = series[0]?.points ?? [];
  const coordinates = points.map((point, index) => ({
    x: inset + (index / Math.max(points.length - 1, 1)) * (width - inset * 2),
    y: height - inset - ((point.value - minimum) / range) * (height - inset * 2),
  }));
  const line = coordinates
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const area =
    coordinates.length === 0
      ? ""
      : `${line} L${coordinates.at(-1)?.x ?? inset} ${height - inset} L${coordinates[0]?.x ?? inset} ${height - inset} Z`;
  if (points.length === 0)
    return (
      <EmptyState
        title="No samples yet"
        description="Prometheus returned no samples for this interval."
      />
    );
  return (
    <div className="chart-wrap">
      <svg className="chart" role="img" viewBox={`0 0 ${width} ${height}`}>
        <title>{series[0]?.label ?? "Metric"} over time</title>
        <desc>
          {points.length} samples, from {formatMetric(minimum, series[0]?.unit ?? "short")} to{" "}
          {formatMetric(maximum, series[0]?.unit ?? "short")}.
        </desc>
        {[0, 1, 2, 3].map((lineIndex) => {
          const y = inset + lineIndex * ((height - inset * 2) / 3);
          return (
            <line
              className="chart-grid"
              key={lineIndex}
              x1={inset}
              x2={width - inset}
              y1={y}
              y2={y}
            />
          );
        })}
        <path className="chart-area" d={area} />
        <path className="chart-line" d={line} />
        <text className="chart-axis" x={inset} y={height - 6}>
          {new Date(points[0]?.timestamp ?? "").toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </text>
        <text className="chart-axis" textAnchor="end" x={width - inset} y={height - 6}>
          {new Date(points.at(-1)?.timestamp ?? "").toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </text>
      </svg>
      <dl className="sr-only">
        {points.map((point) => (
          <div key={point.timestamp}>
            <dt>{new Date(point.timestamp).toLocaleString()}</dt>
            <dd>{formatMetric(point.value, series[0]?.unit ?? "short")}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ServiceRows({ services }: Readonly<{ services: readonly ServiceStatus[] }>) {
  return (
    <div className="service-list">
      {services.map((service) => (
        <div className="service-row" key={service.id}>
          <div className="service-name">
            <span className="service-icon">
              {service.kind === "database" ? <DatabaseIcon /> : <ServerIcon />}
            </span>
            <div>
              <strong>{service.name}</strong>
              <span>
                {service.kind} · {service.status} ·{" "}
                {service.revision === null ? "revision unavailable" : service.revision.slice(0, 9)}
              </span>
            </div>
          </div>
          <StatusPill label={service.health} state={healthTone(service.health)} />
          <div className="service-cell">
            <span className="cell-label">CPU</span>
            <br />
            {formatMetric(service.cpuPercent, "percent")}
          </div>
          <div className="service-cell">
            <span className="cell-label">Memory</span>
            <br />
            {formatMetric(service.memoryBytes, "bytes")}
          </div>
          <div className="service-cell">
            <span className="cell-label">Last restart</span>
            <br />
            {relativeTime(service.lastRestartAt)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function LogRows({ logs }: Readonly<{ logs: readonly SanitizedLogEntry[] }>) {
  return (
    <div className="log-list">
      {logs.map((log) => (
        <div className="log-row" key={log.id}>
          <StatusPill
            label={log.severity}
            state={log.severity === "error" ? "critical" : "warning"}
          />
          <span className="mono">{log.service}</span>
          <span className="log-message" title={log.message}>
            {log.message}
          </span>
          <span className="log-time">{relativeTime(log.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  description,
  title,
}: Readonly<{ description: string; title: string }>) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <AlertIcon />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}
