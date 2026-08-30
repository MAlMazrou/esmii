import { describe, expect, it, vi } from "vitest";

import {
  HashedAbuseRateLimiter,
  canonicalRateLimitEmail,
  type AbuseRateLimitStore,
} from "../src/security/rate-limiter.js";

function store(): AbuseRateLimitStore {
  return {
    close: vi.fn(async () => undefined),
    increment: vi.fn(async () => ({ count: 1, remainingMilliseconds: 59_250 })),
  };
}

describe("HashedAbuseRateLimiter", () => {
  it("uses environment- and bucket-separated opaque keys", async () => {
    const backend = store();
    const limiter = new HashedAbuseRateLimiter({
      environment: "development",
      key: new Uint8Array(32).fill(7),
      store: backend,
    });

    await limiter.consume({
      bucket: "magic-email",
      limit: 5,
      subject: "person@example.test",
      windowSeconds: 600,
    });

    expect(backend.increment).toHaveBeenCalledOnce();
    const key = vi.mocked(backend.increment).mock.calls[0]?.[0].key ?? "";
    expect(key).toMatch(/^esmii:api:development:rate:magic-email:[A-Za-z0-9_-]{43}$/u);
    expect(key).not.toContain("person@example.test");
  });

  it("denies only after the configured count and returns a bounded retry delay", async () => {
    const backend = store();
    vi.mocked(backend.increment).mockResolvedValue({
      count: 6,
      remainingMilliseconds: 59_250,
    });
    const limiter = new HashedAbuseRateLimiter({
      environment: "test",
      key: new Uint8Array(32).fill(8),
      store: backend,
    });

    await expect(
      limiter.consume({
        bucket: "magic-network",
        limit: 5,
        subject: "192.0.2.1",
        windowSeconds: 60,
      }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("canonicalizes email without throwing for an invalid public input", () => {
    expect(canonicalRateLimitEmail(" Person@Example.Test ")).toBe("person@example.test");
    expect(canonicalRateLimitEmail("not-an-email")).toBeNull();
  });
});
