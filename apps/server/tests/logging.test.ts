import { describe, expect, it } from "vitest";

import { sanitizeRequestTarget, serializeRequestForLog } from "../src/observability/logger.js";

describe("request-log redaction", () => {
  it("drops every query string from logged request targets", () => {
    expect(sanitizeRequestTarget("/api/health/live?probe=INERT_QUERY_SENTINEL")).toBe(
      "/api/health/live",
    );
  });

  it("replaces action-link paths instead of logging token-bearing segments", () => {
    const serialized = JSON.stringify(
      serializeRequestForLog({
        headers: { host: "example.invalid" },
        method: "GET",
        socket: { remoteAddress: "127.0.0.1", remotePort: 12345 },
        url: "/api/auth/callback/INERT_PATH_SENTINEL?code=INERT_QUERY_SENTINEL",
      }),
    );

    expect(serialized).toContain("/[REDACTED_ACTION_ROUTE]");
    expect(serialized).not.toContain("INERT_PATH_SENTINEL");
    expect(serialized).not.toContain("INERT_QUERY_SENTINEL");
  });
});
