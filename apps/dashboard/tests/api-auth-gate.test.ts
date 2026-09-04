import { describe, expect, it, vi } from "vitest";

import { withMonitoringAuth } from "../lib/http/api.ts";

describe("monitoring API authentication gate", () => {
  it("returns 401 and never invokes the data handler without a verified operator", async () => {
    const handler = vi.fn(async () => Response.json({ secretInfrastructureData: true }));
    const authenticate = vi.fn(async () => null);
    const response = await withMonitoringAuth(
      new Request("https://dashboard.esmii.app/api/monitoring/overview"),
      handler,
      authenticate,
    );
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
  });
});
