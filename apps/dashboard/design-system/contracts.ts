export type DesignTone = "critical" | "healthy" | "info" | "neutral" | "warning";
export type DesignSize = "large" | "medium" | "small";
export type DesignState = "disabled" | "error" | "idle" | "loading" | "selected";
export type DesignDensity = "comfortable" | "compact";
export type ChartRole = "grid" | "primary" | "threshold-critical" | "threshold-warning";

export interface DesignComponentContract {
  readonly chartRole: ChartRole;
  readonly density: DesignDensity;
  readonly size: DesignSize;
  readonly state: DesignState;
  readonly tone: DesignTone;
}

export type {
  FreshnessState,
  HealthState,
  MetricState,
  SemanticTone,
} from "../lib/monitoring/types.ts";
