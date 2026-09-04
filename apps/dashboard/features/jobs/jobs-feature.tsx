"use client";

import {
  EmptyState,
  PageHeading,
  QueryBanner,
  StatusPill,
} from "../../design-system/primitives/index.ts";
import { relativeTime } from "../../design-system/data/index.ts";
import { useMonitoring } from "../monitoring/index.ts";
import type { JobsResponse } from "../../lib/monitoring/types.ts";

export function JobsFeature() {
  const query = useMonitoring<JobsResponse>("/api/monitoring/jobs");
  return (
    <div className="page">
      <PageHeading
        eyebrow="Automation"
        subtitle="Allowlisted host timers and their paired one-shot services."
        title="Jobs and deployments"
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
            <h2>Scheduled operations</h2>
            <p>Last exit, next trigger, and most recent result</p>
          </div>
        </div>
        {query.loading && query.data === null ? (
          <div className="empty-state" role="status">
            Loading jobs…
          </div>
        ) : query.data === null || query.data.jobs.length === 0 ? (
          <EmptyState
            title="No job metrics"
            description="No environment timer samples are available yet."
          />
        ) : (
          <div className="job-list">
            {query.data.jobs.map((job) => (
              <div className="job-row" key={job.id}>
                <div>
                  <strong>{job.name}</strong>
                  <span>{job.kind}</span>
                </div>
                <div>
                  <span className="cell-label">Last run</span>
                  <br />
                  <span className="mono">{relativeTime(job.lastRunAt)}</span>
                </div>
                <div>
                  <span className="cell-label">Next run</span>
                  <br />
                  <span className="mono">{relativeTime(job.nextRunAt)}</span>
                </div>
                <StatusPill label={job.status} state={job.state} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
