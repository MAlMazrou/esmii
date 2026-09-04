import { describe, expect, it } from "vitest";

import { formatMetric } from "../design-system/data/format.ts";

describe("metric formatting", () => {
  it("renders byte units once with deterministic decimal scales", () => {
    expect(formatMetric(3_280_000_000, "bytes")).toBe("3.3GB");
    expect(formatMetric(384_000, "bytes_per_second")).toBe("384KB/s");
    expect(formatMetric(32, "bytes")).toBe("32B");
  });

  it("labels rate-valued counters as rates", () => {
    expect(formatMetric(4.7, "count_per_second")).toBe("4.7/s");
  });
});
