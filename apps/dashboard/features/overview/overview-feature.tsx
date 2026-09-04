"use client";

import Link from "next/link";
import { useState } from "react";

import { EmptyState, PageHeading, QueryBanner } from "../../design-system/primitives/index.ts";
import {
  LineChart,
  LogRows,
  MetricCard,
  MetricSkeletons,
  ServiceRows,
} from "../../design-system/data/index.ts";
import { useMonitoring } from "../monitoring/index.ts";
import type {
  MetricId,
  OverviewResponse,
  SeriesResponse,
  TimeRange,
} from "../../lib/monitoring/types.ts";

const RANGES: readonly TimeRange[] = ["1h", "6h", "24h", "7d"];
const TREND_METRICS = [
  { id: "cpu_usage", label: "CPU usage" },
  { id: "memory_usage", label: "Memory usage" },
  { id: "disk_usage", label: "Root disk usage" },
  { id: "network_receive", label: "Network received" },
] as const satisfies ReadonlyArray<{ readonly id: MetricId; readonly label: string }>;

function ResourceTrend() {
  const [range, setRange] = useState<TimeRange>("6h");
  const [metric, setMetric] = useState<MetricId>("cpu_usage");
  const metricLabel = TREND_METRICS.find((item) => item.id === metric)?.label ?? "Host resource";
  const query = useMonitoring<SeriesResponse>(
    `/api/monitoring/series?metric=${metric}&range=${range}`,
  );
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Resource trend</h2>
          <p>{metricLabel} through the allowlisted Prometheus range API</p>
        </div>
        <div className="trend-controls">
          <select
            aria-label="Trend metric"
            className="select trend-select"
            onChange={(event) => setMetric(event.target.value as MetricId)}
            value={metric}
          >
            {TREND_METRICS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div aria-label="Time range" className="range-group" role="group">
            {RANGES.map((value) => (
              <button
                aria-pressed={range === value}
                data-active={range === value}
                key={value}
                onClick={() => setRange(value)}
                type="button"
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>
      {query.loading && query.data === null ? (
        <div className="skeleton chart-wrap" role="status">
          <span className="sr-only">Loading chart</span>
        </div>
      ) : query.data === null ? (
        <EmptyState title="Trend unavailable" description="No range samples could be loaded." />
      ) : (
        <LineChart series={query.data.series} />
      )}
      <QueryBanner
        error={query.error}
        onRetry={query.refresh}
        refreshing={query.refreshing}
        stale={query.stale}
      />
    </section>
  );
}

export function OverviewFeature() {
  const query = useMonitoring<OverviewResponse>("/api/monitoring/overview");
  const data = query.data;
  return (
    <div className="page">
      <PageHeading
        eyebrow="Infrastructure"
        subtitle="Host, service, job, and sanitized log health in one private view."
        title="System overview"
      />
      <QueryBanner
        error={query.error}
        onRetry={query.refresh}
        refreshing={query.refreshing}
        stale={query.stale || data?.freshness.state === "stale"}
      />
      {query.loading && data === null ? (
        <MetricSkeletons count={12} />
      ) : data === null ? (
        <EmptyState
          title="Overview unavailable"
          description="No monitoring snapshot could be loaded."
        />
      ) : (
        <>
          <section aria-label="Host metrics" className="metric-grid">
            {data.host.map((metric) => (
              <MetricCard key={metric.id} metric={metric} />
            ))}
          </section>
          <div className="grid-two">
            <ResourceTrend />
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Recent warnings</h2>
                  <p>Sanitized, bounded operational events</p>
                </div>
                <Link className="mono" href="/logs">
                  View all
                </Link>
              </div>
              {data.recentLogs.length === 0 ? (
                <EmptyState
                  title="Quiet window"
                  description="No warning or error events are present."
                />
              ) : (
                <LogRows logs={data.recentLogs} />
              )}
            </section>
          </div>
          <section className="panel section-top">
            <div className="panel-heading">
              <div>
                <h2>Services</h2>
                <p>Runtime state, resource use, restarts, and deployment revision</p>
              </div>
              <Link className="mono" href="/services">
                Inspect services
              </Link>
            </div>
            {data.services.length === 0 ? (
              <EmptyState
                title="No service samples"
                description="The environment collector has not emitted service metrics yet."
              />
            ) : (
              <ServiceRows services={data.services} />
            )}
          </section>
        </>
      )}
    </div>
  );
}
