import { describe, expect, it } from "vitest";

import { hasValidOperationsToken } from "../src/health/token.js";

describe("operations health token", () => {
  it("accepts only the exact Bearer token", () => {
    const token = "a".repeat(32);

    expect(hasValidOperationsToken(`Bearer ${token}`, token)).toBe(true);
    expect(hasValidOperationsToken(`Bearer ${token}x`, token)).toBe(false);
    expect(hasValidOperationsToken(token, token)).toBe(false);
    expect(hasValidOperationsToken(undefined, token)).toBe(false);
  });
});
