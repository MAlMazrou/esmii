import { describe, expect, it } from "vitest";

import { canonicalizeEmail, isCanonicalEmail } from "../src/email.js";

describe("canonical email comparison", () => {
  it("normalizes case, surrounding space, and Unicode without rewriting mailbox syntax", () => {
    expect(canonicalizeEmail("  USER.Name+Tag@Example.TEST  ")).toBe("user.name+tag@example.test");
    expect(canonicalizeEmail("u\u0308ser@example.test")).toBe("üser@example.test");
  });

  it("rejects invalid or non-canonical persisted forms", () => {
    expect(() => canonicalizeEmail("invalid@@example.test")).toThrow(TypeError);
    expect(isCanonicalEmail("user@example.test")).toBe(true);
    expect(isCanonicalEmail("User@example.test")).toBe(false);
  });
});
