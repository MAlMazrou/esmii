"use client";

import { createContext, useContext } from "react";

import type { MonitoringEnvironment } from "../lib/monitoring/types.ts";

const EnvironmentContext = createContext<MonitoringEnvironment | null>(null);

export function EnvironmentProvider({
  children,
  environment,
}: Readonly<{ children: React.ReactNode; environment: MonitoringEnvironment }>) {
  return <EnvironmentContext value={environment}>{children}</EnvironmentContext>;
}

export function useDashboardEnvironment(): MonitoringEnvironment {
  const environment = useContext(EnvironmentContext);
  if (environment === null) throw new Error("Dashboard environment context is unavailable");
  return environment;
}
