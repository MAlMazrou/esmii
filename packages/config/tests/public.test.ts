import { describe, expect, it } from "vitest";

import { getPublicRuntimeConfig } from "../src/public.js";

describe("public runtime configuration", () => {
  it("contains only the application identity and safe provider availability", () => {
    const value = getPublicRuntimeConfig([
      { id: "google", enabled: true, mode: "mock" },
      { id: "apple", enabled: false, mode: "oauth" },
    ]);

    expect(value).toEqual({
      applicationName: "Esmii",
      applicationSlug: "esmii",
      providers: [
        { id: "google", enabled: true, mode: "mock" },
        { id: "apple", enabled: false, mode: "oauth" },
      ],
    });
    expect(JSON.stringify(value)).not.toMatch(/secret|database|valkey|smtp|keyring/iu);
  });
});
