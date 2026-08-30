"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiRequestError, apiPaths, apiRequest } from "./api";
import { organizationRefetchEvent } from "./events";

export type ResourceStatus = "loading" | "ready" | "error";

export interface ResourceState<T> {
  data: T | null;
  error: ApiRequestError | null;
  reload: () => void;
  status: ResourceStatus;
}

function normalizeError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) return error;
  return new ApiRequestError(0, "NETWORK_ERROR", "The service could not be reached.", null);
}

export function useApiResource<T>(path: string | null): ResourceState<T> {
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [status, setStatus] = useState<ResourceStatus>("loading");

  const reload = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setError(null);
      setStatus("ready");
      return;
    }

    const controller = new AbortController();
    setStatus("loading");
    setError(null);

    void apiRequest<T>(path, { signal: controller.signal })
      .then((response) => {
        setData(response);
        setStatus("ready");
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(normalizeError(requestError));
        setStatus("error");
      });

    return () => {
      controller.abort();
    };
  }, [path, revision]);

  useEffect(() => {
    if (path === null || (path !== apiPaths.viewer && !path.startsWith(apiPaths.organization))) {
      return;
    }

    window.addEventListener(organizationRefetchEvent, reload);
    return () => {
      window.removeEventListener(organizationRefetchEvent, reload);
    };
  }, [path, reload]);

  return { data, error, reload, status };
}

export function useMutationState(): {
  begin: () => void;
  clear: () => void;
  error: ApiRequestError | null;
  fail: (error: unknown) => void;
  pending: boolean;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const begin = useCallback(() => {
    setPending(true);
    setError(null);
  }, []);
  const clear = useCallback(() => {
    setPending(false);
    setError(null);
  }, []);
  const fail = useCallback((failure: unknown) => {
    setPending(false);
    setError(normalizeError(failure));
  }, []);

  return { begin, clear, error, fail, pending };
}
