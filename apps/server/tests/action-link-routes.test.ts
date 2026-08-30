import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { parseInvitationContinuationCookie } from "../src/http/action-link-routes.js";

const operationsHealthToken = "a".repeat(32);
const continuationId = "8f014a53-4719-4ec8-a1af-2af504f6b9d4";
const continuationSecret = "a".repeat(43);

describe("action-link HTTP exchange boundary", () => {
  it("converts only a strict continuation cookie into a one-way presentation", () => {
    expect(
      parseInvitationContinuationCookie(
        `unrelated=1; esmii.invitation=${continuationId}.${continuationSecret}`,
        "development",
      ),
    ).toEqual({
      continuationId,
      presentedSecretHash: createHash("sha256").update(continuationSecret, "utf8").digest("hex"),
    });
    expect(
      parseInvitationContinuationCookie(
        `esmii.invitation=${continuationId}.${continuationSecret}`,
        "production",
      ),
    ).toBeNull();
    expect(
      parseInvitationContinuationCookie(
        `__Host-esmii.invitation=${continuationId}.${continuationSecret}.extra`,
        "production",
      ),
    ).toBeNull();
  });

  it("rejects malformed token URLs before database or auth access and redirects cleanly", async () => {
    let authCalls = 0;
    const app = buildApp({
      actionLinks: {
        auth: {
          async handler() {
            authCalls += 1;
            return new Response(null, { status: 204 });
          },
        },
        database: { pool: {} as never },
        environment: "test",
        publicOrigin: "http://localhost:8080",
      },
      logger: false,
      operationsHealthToken,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/magic-link/verify?intent=bad&token=sentinel-token-value",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/sign-in/result");
    expect(response.body).not.toContain("sentinel-token-value");
    expect(authCalls).toBe(0);
    await app.close();
  });
});
