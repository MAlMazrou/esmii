import { describe, expect, it } from "vitest";

import {
  getMetricDefinition,
  metricState,
  parseMetricId,
  parseTimeRange,
} from "../lib/monitoring/metric-registry.ts";

describe("metric registry", () => {
  it("accepts identifiers rather than user PromQL", () => {
    expect(parseMetricId("cpu_usage")).toBe("cpu_usage");
    expect(parseMetricId("up or on() vector(1)")).toBeNull();
    expect(parseTimeRange("7d")).toBe("7d");
    expect(parseTimeRange("30d")).toBeNull();
  });

  it("uses the approved host thresholds and root mount", () => {
    const cpu = getMetricDefinition("cpu_usage");
    const disk = getMetricDefinition("disk_usage");
    const swap = getMetricDefinition("swap_usage");
    expect(metricState(cpu, 84.9)).toBe("healthy");
    expect(metricState(cpu, 85)).toBe("warning");
    expect(disk.query).toContain('mountpoint="/"');
    expect(metricState(disk, 60)).toBe("warning");
    expect(metricState(disk, 80)).toBe("critical");
    expect(swap.unit).toBe("bytes");
    expect(metricState(swap, 134_217_728)).toBe("warning");
  });
});
