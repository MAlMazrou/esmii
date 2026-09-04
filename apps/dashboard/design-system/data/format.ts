import type { MetricUnit } from "../../lib/monitoring/types.ts";

export function formatMetric(value: number | null, unit: MetricUnit): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (unit === "percent") return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
  if (unit === "bytes" || unit === "bytes_per_second") {
    const absolute = Math.abs(value);
    const scale =
      absolute >= 1_000_000_000_000
        ? { divisor: 1_000_000_000_000, suffix: "TB" }
        : absolute >= 1_000_000_000
          ? { divisor: 1_000_000_000, suffix: "GB" }
          : absolute >= 1_000_000
            ? { divisor: 1_000_000, suffix: "MB" }
            : absolute >= 1_000
              ? { divisor: 1_000, suffix: "KB" }
              : { divisor: 1, suffix: "B" };
    const scaled = value / scale.divisor;
    const digits = Math.abs(scaled) >= 10 || scale.divisor === 1 ? 0 : 1;
    const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: digits }).format(scaled);
    return `${formatted}${scale.suffix}${unit === "bytes_per_second" ? "/s" : ""}`;
  }
  if (unit === "count_per_second") {
    return `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value)}/s`;
  }
  if (unit === "seconds") {
    const days = Math.floor(value / 86_400);
    const hours = Math.floor((value % 86_400) / 3_600);
    return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  }
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
}
