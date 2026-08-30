import { describe, expect, it, vi } from "vitest";

import { BetterAuthSessionTerminationSeam } from "../src/auth/session-termination.js";

describe("BetterAuthSessionTerminationSeam", () => {
  it("uses the official sign-out handler and returns only expiry cookies", async () => {
    const handler = vi.fn(async (request: Request) => {
      void request;
      const headers = new Headers();
      headers.append(
        "set-cookie",
        "better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      );
      headers.append(
        "set-cookie",
        "better-auth.session_data=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      );
      return new Response(JSON.stringify({ success: true }), { headers, status: 200 });
    });
    const seam = new BetterAuthSessionTerminationSeam({
      applicationOrigin: "http://localhost:8080",
      auth: { handler },
    });

    await expect(
      seam.expire({
        cookieHeader: "better-auth.session_token=signed-value",
        requestId: "request-logout",
      }),
    ).resolves.toEqual({
      setCookieHeaders: [
        "better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        "better-auth.session_data=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      ],
    });
    const request = handler.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (request === undefined) throw new Error("sign-out request was not captured");
    expect(request.url).toBe("http://localhost:8080/api/auth/sign-out");
    expect(request.method).toBe("POST");
    expect(request.headers.get("cookie")).toBe("better-auth.session_token=signed-value");
    expect(request.headers.get("origin")).toBe("http://localhost:8080");
  });

  it("fails closed if the handler does not return cookie expiry headers", async () => {
    const seam = new BetterAuthSessionTerminationSeam({
      applicationOrigin: "https://esmii.app",
      auth: { handler: async () => new Response("{}", { status: 200 }) },
    });

    await expect(
      seam.expire({ cookieHeader: "opaque", requestId: "request-logout" }),
    ).rejects.toThrow("did not return session cookie expiry headers");
  });
});
