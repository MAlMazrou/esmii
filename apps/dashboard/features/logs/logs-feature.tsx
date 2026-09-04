"use client";

import { useMemo, useState } from "react";

import { EmptyState, PageHeading, QueryBanner } from "../../design-system/primitives/index.ts";
import { LogRows } from "../../design-system/data/index.ts";
import { useMonitoring } from "../monitoring/index.ts";
import type { LogsResponse } from "../../lib/monitoring/types.ts";

export function LogsFeature() {
  const [search, setSearch] = useState("");
  const [service, setService] = useState("");
  const [severity, setSeverity] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const endpoint = useMemo(() => {
    const parameters = new URLSearchParams({ limit: "50" });
    if (search.trim() !== "") parameters.set("q", search.trim());
    if (service.trim() !== "") parameters.set("service", service.trim());
    if (severity !== "") parameters.set("severity", severity);
    if (cursor !== null) parameters.set("cursor", cursor);
    return `/api/monitoring/logs?${parameters.toString()}`;
  }, [cursor, search, service, severity]);
  const query = useMonitoring<LogsResponse>(endpoint);
  return (
    <div className="page">
      <PageHeading
        eyebrow="Sanitized events"
        subtitle="Warning and error records only; secrets and personal addresses are redacted at collection and read time."
        title="Operational logs"
      />
      <QueryBanner
        error={query.error}
        onRetry={query.refresh}
        refreshing={query.refreshing}
        stale={query.stale}
      />
      <div className="toolbar">
        <input
          aria-label="Search messages"
          className="field"
          maxLength={120}
          onChange={(event) => {
            setCursor(null);
            setSearch(event.target.value);
          }}
          placeholder="Search messages"
          type="search"
          value={search}
        />
        <input
          aria-label="Filter by service"
          className="field"
          maxLength={64}
          onChange={(event) => {
            setCursor(null);
            setService(event.target.value);
          }}
          placeholder="Service name"
          value={service}
        />
        <select
          aria-label="Filter by severity"
          className="select"
          onChange={(event) => {
            setCursor(null);
            setSeverity(event.target.value);
          }}
          value={severity}
        >
          <option value="">All severities</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
        </select>
      </div>
      <section className="panel table-panel">
        {query.loading && query.data === null ? (
          <div className="empty-state" role="status">
            Loading logs…
          </div>
        ) : query.data === null || query.data.logs.length === 0 ? (
          <EmptyState
            title="No matching events"
            description="No sanitized warning or error entries match these filters."
          />
        ) : (
          <LogRows logs={query.data.logs} />
        )}
      </section>
      <div className="pagination-actions">
        {query.data?.nextCursor === null || query.data?.nextCursor === undefined ? null : (
          <button
            className="button secondary"
            onClick={() => setCursor(query.data?.nextCursor ?? null)}
            type="button"
          >
            Older events
          </button>
        )}
        {cursor === null ? null : (
          <button className="button secondary" onClick={() => setCursor(null)} type="button">
            Newest events
          </button>
        )}
      </div>
    </div>
  );
}
