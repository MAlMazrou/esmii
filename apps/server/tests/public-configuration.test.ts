import { describe, expect, it } from "vitest";

import { createPublicConfiguration } from "../src/auth/public-configuration.js";

describe("createPublicConfiguration", () => {
  it("exposes only validated OAuth or local mock providers as enabled", () => {
    expect(
      createPublicConfiguration({
        google: { clientId: "google-client", clientSecret: "google-secret" },
        mockProviders: [],
      }).providers,
    ).toEqual([{ enabled: true, id: "google", mode: "oauth" }]);
  });
});
