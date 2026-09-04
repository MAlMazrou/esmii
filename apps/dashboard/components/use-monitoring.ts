"use client";

import { useCallback, useEffect, useState } from "react";

export interface MonitoringQuery<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
  readonly refreshing: boolean;
  readonly stale: boolean;
}

export function useMonitoring<T extends { readonly generatedAt: string }>(
  endpoint: string,
): MonitoringQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load(): Promise<void> {
      setRefreshing(data !== null);
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!response.ok) throw new Error("The monitoring source did not respond");
        const next = (await response.json()) as T;
        if (active) {
          setData(next);
          setError(null);
        }
      } catch (caught) {
        if (active && !controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Monitoring data is unavailable");
        }
      } finally {
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [endpoint, revision]);

  useEffect(() => {
    const interval = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  return {
    data,
    error,
    loading,
    refresh,
    refreshing,
    stale: data !== null && Date.now() - Date.parse(data.generatedAt) > 90_000,
  };
}
