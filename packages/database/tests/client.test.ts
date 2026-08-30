import { describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  databaseSessionOptions,
  defaultPoolSizeForRole,
} from "../src/client.js";

describe("database role connection budgets", () => {
  it("keeps the migration identity one-shot and smallest", () => {
    expect(defaultPoolSizeForRole("migration")).toBe(1);
  });

  it("keeps worker and API pools inside the documented launch budget", () => {
    expect(defaultPoolSizeForRole("worker")).toBe(2);
    expect(defaultPoolSizeForRole("api")).toBe(5);
  });

  it("makes the application schema explicit for unqualified Better Auth queries", async () => {
    const client = createDatabaseClient({
      connectionString: "postgresql://unused:unused@127.0.0.1:1/unused",
      role: "api",
    });

    try {
      expect(client.pool.options.options).toBe(databaseSessionOptions);
    } finally {
      await client.close();
    }
  });
});
