import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "@esmii/database";

import { createRuntimeTombstoneOrchestrator } from "../src/services/runtime-tombstones.js";

function capturedDatabase(environment: "development" | "test" | "staging" | "production") {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          access_closed: false,
          closure_reason: null,
          contiguous_high_water: "0",
          environment,
          epoch: "synthetic-epoch",
          version: 1,
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [{ count: "0", maximum: "0" }] });
  return { pool: { query } } as unknown as DatabaseClient;
}

describe("runtime tombstone adapter selection", () => {
  it("allows the isolated capture adapter in staging", async () => {
    await expect(
      createRuntimeTombstoneOrchestrator({
        database: capturedDatabase("staging"),
        environment: "staging",
        mode: "capture",
      }),
    ).resolves.toBeDefined();
  });

  it("keeps production fail-closed without the external journal", async () => {
    await expect(
      createRuntimeTombstoneOrchestrator({
        database: capturedDatabase("staging"),
        environment: "production",
        mode: "capture",
      }),
    ).rejects.toThrow("external tombstone capture must be provisioned");
  });

  it("allows production capture only for the explicit initial public shell", async () => {
    await expect(
      createRuntimeTombstoneOrchestrator({
        allowProductionCapture: true,
        database: capturedDatabase("production"),
        environment: "production",
        mode: "capture",
      }),
    ).resolves.toBeDefined();
  });
});
