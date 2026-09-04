"use client";

import { PageHeading, PulseIcon, QueryBanner } from "../../design-system/primitives/index.ts";
import { formatMetric, LineChart } from "../../design-system/data/index.ts";
import { useMonitoring } from "../monitoring/index.ts";
import type { ApplicationMonitoringResponse } from "../../lib/monitoring/types.ts";

export function ApplicationFeature() {
  const query = useMonitoring<ApplicationMonitoringResponse>("/api/monitoring/application");
  return (
    <div className="page">
      <PageHeading
        eyebrow="Future instrumentation"
        subtitle="The UI and API boundary are ready without fabricating application telemetry."
        title="Application monitoring"
      />
      <QueryBanner
        error={query.error}
        onRetry={query.refresh}
        refreshing={query.refreshing}
        stale={query.stale}
      />
      {query.data?.status === "available" ? null : (
        <div className="banner">
          <span>
            <strong>Not instrumented yet.</strong> These cards activate when the web application
            exports the approved counters and histograms.
          </span>
        </div>
      )}
      <section className="placeholder-grid" aria-label="Application metrics">
        {(query.data?.metrics ?? []).map((metric) => (
          <article className="placeholder-card" key={metric.id}>
            <PulseIcon />
            <h2>{metric.title}</h2>
            <p>{metric.description}</p>
            {metric.state === "available" ? (
              <>
                <div className="metric-value">{formatMetric(metric.value, metric.unit)}</div>
                <LineChart series={metric.series} />
              </>
            ) : (
              <div aria-hidden="true" className="placeholder-graph">
                {Array.from({ length: 6 }, (_, index) => (
                  <span key={index} />
                ))}
              </div>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
