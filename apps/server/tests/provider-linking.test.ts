import { describe, expect, it, vi } from "vitest";

import {
  BetterAuthProviderLinkingSeam,
  validateProviderAuthorizationUrl,
} from "../src/auth/provider-linking.js";

describe("BetterAuthProviderLinkingSeam", () => {
  it("starts only an authenticated linking flow with clean application callbacks", async () => {
    const linkSocialAccount = vi.fn(async (input: { body: unknown; headers: Headers }) => {
      void input;
      return {
        redirect: true,
        url: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state&client_id=client",
      };
    });
    const seam = new BetterAuthProviderLinkingSeam({
      applicationOrigin: "https://esmii.app",
      auth: { api: { linkSocialAccount } } as never,
    });

    await expect(
      seam.begin({
        cookieHeader: "__Host-esmii.session=opaque",
        idempotencyKey: "link-google-request-0001",
        provider: "google",
        requestId: "request-provider-link",
        sessionId: "session-synthetic",
        userId: "user-synthetic",
      }),
    ).resolves.toEqual({
      redirectUrl:
        "https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state&client_id=client",
    });
    expect(linkSocialAccount).toHaveBeenCalledWith({
      body: {
        callbackURL: "/app/account",
        disableRedirect: true,
        errorCallbackURL: "/sign-in/result",
        provider: "google",
        requestSignUp: false,
      },
      headers: expect.any(Headers),
    });
    const headers = linkSocialAccount.mock.calls[0]?.[0].headers;
    expect(headers).toBeDefined();
    if (headers === undefined) throw new Error("linking headers were not captured");
    expect(headers.get("cookie")).toBe("__Host-esmii.session=opaque");
    expect(headers.get("origin")).toBe("https://esmii.app");
  });

  it("rejects an unexpected provider host, path, protocol, or missing state", () => {
    for (const candidate of [
      "https://attacker.example/o/oauth2/v2/auth?state=opaque",
      "https://accounts.google.com/ServiceLogin?state=opaque",
      "http://accounts.google.com/o/oauth2/v2/auth?state=opaque",
      "https://accounts.google.com/o/oauth2/v2/auth",
    ]) {
      expect(() => validateProviderAuthorizationUrl("google", candidate)).toThrow(
        "unsafe authorization URL",
      );
    }
  });
});
