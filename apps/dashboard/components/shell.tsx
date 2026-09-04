"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import type { MonitoringEnvironment } from "../lib/monitoring/types.ts";
import type { OverviewResponse } from "../lib/monitoring/types.ts";
import { Brand } from "./brand.tsx";
import { EnvironmentProvider } from "./environment-context.tsx";
import { JobsIcon, LogsIcon, OverviewIcon, PulseIcon, ServerIcon } from "./icons.tsx";
import { useMonitoring } from "./use-monitoring.ts";

const NAVIGATION = [
  { href: "/overview", icon: OverviewIcon, label: "Overview" },
  { href: "/services", icon: ServerIcon, label: "Services" },
  { href: "/jobs", icon: JobsIcon, label: "Jobs" },
  { href: "/logs", icon: LogsIcon, label: "Logs" },
  { href: "/application", icon: PulseIcon, label: "Application" },
] as const;

function Navigation({ mobile = false }: Readonly<{ mobile?: boolean }>) {
  const pathname = usePathname();
  return (
    <nav aria-label="Monitoring" className={mobile ? "mobile-nav" : "side-nav"}>
      {NAVIGATION.map(({ href, icon: Icon, label }) => (
        <Link className="side-link" data-active={pathname === href} href={href} key={href}>
          <Icon />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function EnvironmentSwitch({
  environment,
  peerOrigin,
}: Readonly<{ environment: MonitoringEnvironment; peerOrigin: string }>) {
  return (
    <div className="env-switch" aria-label="Environment">
      <a
        data-current={environment === "staging"}
        data-environment="staging"
        href={environment === "staging" ? "/overview" : peerOrigin}
      >
        STAGING
      </a>
      <a
        data-current={environment === "production"}
        data-environment="production"
        href={environment === "production" ? "/overview" : peerOrigin}
      >
        PRODUCTION
      </a>
    </div>
  );
}

export function Shell({
  children,
  environment,
  operatorLabel,
  peerOrigin,
}: Readonly<{
  children: React.ReactNode;
  environment: MonitoringEnvironment;
  operatorLabel: string;
  peerOrigin: string;
}>) {
  const [signingOut, setSigningOut] = useState(false);
  const freshness = useMonitoring<OverviewResponse>("/api/monitoring/overview");
  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await fetch("/api/operator-auth/sign-out", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <EnvironmentProvider environment={environment}>
      <div className="app-shell" data-environment={environment}>
        <aside className="sidebar">
          <Brand />
          <p className="side-section-label">Infrastructure</p>
          <Navigation />
          <div className="sidebar-bottom">
            <div className="environment-summary">
              <strong>{environment}</strong>
              <span>{freshness.data?.freshness.label ?? "Checking metrics"}</span>
              <span className="operator-label" title={operatorLabel}>
                {operatorLabel}
              </span>
            </div>
            <button
              className="sign-out"
              disabled={signingOut}
              onClick={() => void signOut()}
              type="button"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </aside>
        <header className="mobile-header">
          <div className="mobile-header-top">
            <Brand />
            <span className="sr-only">
              Signed in as {operatorLabel}. {freshness.data?.freshness.label ?? "Checking metrics"}.
            </span>
            <EnvironmentSwitch environment={environment} peerOrigin={peerOrigin} />
          </div>
          <div className="mobile-session">
            <span className="mobile-freshness">
              {freshness.data?.freshness.label ?? "Checking metrics"}
            </span>
            <span className="mobile-operator" title={operatorLabel}>
              {operatorLabel}
            </span>
            <button
              className="mobile-sign-out"
              disabled={signingOut}
              onClick={() => void signOut()}
              type="button"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
          <Navigation mobile />
        </header>
        <main className="main">{children}</main>
        <div className="environment-rail" data-environment={environment} aria-hidden="true">
          {environment.toUpperCase()}
        </div>
      </div>
    </EnvironmentProvider>
  );
}
