import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
}

describe("dashboard UI contract", () => {
  it("keeps literal colors in the token source only", () => {
    expect(source("design-system/tokens.css")).toContain("--blue-500: #3b73ff");
    expect(source("design-system/theme-default.css")).toContain("--surface-primary");
    expect(source("design-system/theme-default.css")).toContain("--status-critical");
    expect(source("app/globals.css")).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it("supports a central contract-remapping fixture without feature overrides", () => {
    const fixture = source("design-system/theme-contract-fixture.css");
    expect(fixture).toContain(':root[data-theme="contract-test"]');
    expect(fixture).toContain("--surface-primary:");
    expect(fixture).toContain("--text-primary:");
    expect(fixture).toContain("--action-primary-surface:");
    expect(source("app/layout.tsx")).toContain("data-theme={config.themeFixture");
    for (const feature of ["application", "jobs", "logs", "overview", "services"]) {
      expect(source(`features/${feature}/${feature}-feature.tsx`)).not.toContain("contract-test");
    }
  });

  it("publishes typed tone, size, state, density, and chart roles", () => {
    const contract = source("design-system/contracts.ts");
    for (const role of ["DesignTone", "DesignSize", "DesignState", "DesignDensity", "ChartRole"]) {
      expect(contract).toContain(`type ${role}`);
    }
  });

  it("keeps semantic status copy and controls on contrast-safe text tokens", () => {
    const styles = source("app/globals.css");
    expect(styles).toMatch(
      /\.status-pill\[data-state="warning"\]\s*\{\s*--status-accent:\s*var\(--warning\)/u,
    );
    expect(styles).toMatch(/\.status-pill\s*\{[^}]*color:\s*var\(--text-primary\)/su);
    expect(styles).toContain("background: var(--action-primary-surface);");
    expect(source("design-system/theme-default.css")).toContain(
      "--border-strong: var(--neutral-500)",
    );
  });

  it("provides accessible historical ranges and non-color status symbols", () => {
    const overview = source("features/overview/overview-feature.tsx");
    const primitives = source("components/dashboard-ui.tsx");
    expect(overview).toContain('["1h", "6h", "24h", "7d"]');
    expect(overview).toContain('aria-label="Time range"');
    expect(overview).toContain('aria-label="Trend metric"');
    for (const metric of ["cpu_usage", "memory_usage", "disk_usage", "network_receive"]) {
      expect(overview).toContain(`id: "${metric}"`);
    }
    expect(primitives).toContain("status-symbol");
    expect(primitives).toContain("aria-label={`${label}, ${state} state`}");
  });

  it("keeps health, runtime state, and operational context visible on mobile", () => {
    const primitives = source("components/dashboard-ui.tsx");
    const styles = source("app/globals.css");
    expect(primitives).toContain("label={service.health}");
    expect(primitives).toContain("{service.kind} · {service.status}");
    expect(styles).toContain(".service-row .service-cell:nth-of-type(4)");
    expect(styles).toMatch(/\.log-row > \.mono,[\s\S]*display: block/u);
    expect(styles).toContain(".job-row > div:nth-child(3)");
  });

  it("renders production as solid and staging as segmented at desktop and mobile", () => {
    const styles = source("app/globals.css");
    expect(styles).toContain('.environment-rail[data-environment="staging"]');
    expect(styles).toContain("border-left: 3px dashed");
    expect(styles).toContain('.env-switch a[data-environment="staging"][data-current="true"]');
  });

  it("repeats fixed environment identity and the authenticated operator", () => {
    const layout = source("app/layout.tsx");
    expect(layout).toContain('export const dynamic = "force-dynamic"');
    expect(layout).toContain("generateMetadata");
    expect(layout).toContain("environment-icon.svg");
    expect(source("app/environment-icon.svg/route.ts")).toContain('environment === "production"');
    expect(source("components/dashboard-ui.tsx")).toContain("{environment} · {eyebrow}");
    expect(source("components/shell.tsx")).toContain("operatorLabel");
    expect(source("components/shell.tsx")).toContain('className="mobile-operator"');
    expect(source("components/shell.tsx")).toContain('className="mobile-freshness"');
    expect(source("components/shell.tsx")).toContain('className="mobile-sign-out"');
  });

  it("guards every monitoring data route before repository access", () => {
    for (const route of ["application", "jobs", "logs", "overview", "series", "services"]) {
      expect(source(`app/api/monitoring/${route}/route.ts`)).toContain("withMonitoringAuth");
    }
    expect(source("app/api/monitoring/series/route.ts")).not.toContain('searchParams.get("query")');
  });
});
