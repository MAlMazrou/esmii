"use client";

import { EmptyState, PageHeading, QueryBanner } from "../../design-system/primitives/index.ts";
import { relativeTime, ServiceRows } from "../../design-system/data/index.ts";
import { useMonitoring } from "../monitoring/index.ts";
import type { ServicesResponse } from "../../lib/monitoring/types.ts";

export function ServicesFeature() {
  const query = useMonitoring<ServicesResponse>("/api/monitoring/services");
  return (
    <div className="page">
      <PageHeading
        eyebrow="Runtime"
        subtitle="Only allowlisted services for this environment are shown."
        title="Service health"
      />
      <QueryBanner
        error={query.error}
        onRetry={query.refresh}
        refreshing={query.refreshing}
        stale={query.stale}
      />
      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h2>Environment services</h2>
            <p>Health, CPU, memory, OOM state, restarts, heartbeat, and revision</p>
          </div>
        </div>
        {query.loading && query.data === null ? (
          <div className="empty-state" role="status">
            Loading services…
          </div>
        ) : query.data === null || query.data.services.length === 0 ? (
          <EmptyState
            title="No services reported"
            description="The allowlisted collector has not emitted a current service sample."
          />
        ) : (
          <ServiceRows services={query.data.services} />
        )}
      </section>
      {query.data === null ? null : (
        <section className="service-detail-grid section-top">
          {query.data.services.map((service) => (
            <article
              className="metric-card service-detail-card"
              data-state={
                service.health === "down"
                  ? "critical"
                  : service.health === "degraded"
                    ? "warning"
                    : service.health
              }
              key={service.id}
            >
              <div className="metric-label">
                <span>{service.name}</span>
                <span>
                  {service.oomKilled === true
                    ? "OOM detected"
                    : service.oomKilled === false
                      ? "No OOM"
                      : "OOM unknown"}
                </span>
              </div>
              <dl className="service-details">
                <div>
                  <dt>Current restarts</dt>
                  <dd>{service.restartCount ?? "—"}</dd>
                </div>
                <div>
                  <dt>Rolling 24h</dt>
                  <dd>{service.rollingRestartCount ?? "—"}</dd>
                </div>
                <div>
                  <dt>Last start</dt>
                  <dd>{relativeTime(service.lastStartAt)}</dd>
                </div>
                <div>
                  <dt>Last restart</dt>
                  <dd>{relativeTime(service.lastRestartAt)}</dd>
                </div>
                <div>
                  <dt>Worker heartbeat</dt>
                  <dd>
                    {service.workerHeartbeatAt === null
                      ? "Not applicable"
                      : relativeTime(service.workerHeartbeatAt)}
                  </dd>
                </div>
                <div>
                  <dt>OOM state</dt>
                  <dd>
                    {service.oomKilled === true
                      ? "Killed"
                      : service.oomKilled === false
                        ? "Clear"
                        : "Unknown"}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
