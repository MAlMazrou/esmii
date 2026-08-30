import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { claimOutboxBatch } from "../src/repositories/delivery.js";

describe("outbox claim boundaries", () => {
  it("rejects an empty event-type allowlist before acquiring a database connection", async () => {
    await expect(
      claimOutboxBatch({} as Pool, {
        allowedEventTypes: [],
        leaseSeconds: 30,
        limit: 10,
        workerId: "synthetic-worker",
      }),
    ).rejects.toThrow("at least one allowed event type");
  });

  it("passes the explicit event allowlist into the claim predicate", async () => {
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(text: string, values?: unknown[]) {
        statements.push(values === undefined ? { text } : { text, values });
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };
    const pool = {
      async connect() {
        return client;
      },
    } as unknown as Pool;

    await expect(
      claimOutboxBatch(pool, {
        allowedEventTypes: ["magic_link.requested", "invitation.requested"],
        leaseSeconds: 30,
        limit: 10,
        workerId: "synthetic-worker",
      }),
    ).resolves.toEqual([]);

    const claim = statements.find((statement) => statement.text.includes("WITH claimable"));
    expect(claim?.text).toContain("event_type = ANY($4::text[])");
    expect(claim?.values?.[3]).toEqual(["magic_link.requested", "invitation.requested"]);
  });
});
