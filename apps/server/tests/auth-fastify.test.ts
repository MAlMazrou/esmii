import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { BetterAuthAuthenticationSeam, registerBetterAuthRoutes } from "../src/auth/fastify.js";

const operationsHealthToken = "a".repeat(32);

describe("Better Auth Fastify boundary", () => {
  it("forwards only the approved social route and preserves response cookies", async () => {
    const observed: Request[] = [];
    const app = buildApp({ logger: false, operationsHealthToken });
    registerBetterAuthRoutes(app, {
      applicationOrigin: "http://localhost:8080",
      auth: {
        api: { getSession: async () => null } as never,
        async handler(request) {
          observed.push(request);
          const headers = new Headers({ "content-type": "application/json" });
          headers.append("set-cookie", "__Host-esmii.one=1; Path=/; HttpOnly");
          headers.append("set-cookie", "__Host-esmii.two=2; Path=/; HttpOnly");
          return new Response(JSON.stringify({ url: "https://accounts.google.com/example" }), {
            headers,
            status: 200,
          });
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      payload: { callbackURL: "/app", provider: "google" },
      url: "/api/auth/sign-in/social",
    });
    expect(response.statusCode).toBe(200);
    expect(observed).toHaveLength(1);
    await expect(observed[0]?.json()).resolves.toEqual({
      callbackURL: "/app",
      provider: "google",
    });
    expect(response.headers["set-cookie"]).toHaveLength(2);
    await app.close();
  });

  it("terminates OAuth query secrets and preserves auth cookies on a clean app redirect", async () => {
    const sentinel = "OAUTH_CODE_MUST_NOT_REACH_BROWSER";
    const observed: Request[] = [];
    const app = buildApp({ logger: false, operationsHealthToken });
    registerBetterAuthRoutes(app, {
      applicationOrigin: "https://esmii.app",
      auth: {
        api: { getSession: async () => null } as never,
        async handler(request) {
          observed.push(request);
          const headers = new Headers({
            location: "https://esmii.app/app",
            "x-provider-debug": sentinel,
          });
          headers.append(
            "set-cookie",
            "__Host-esmii.session=one; Path=/; HttpOnly; SameSite=Lax; Secure",
          );
          headers.append(
            "set-cookie",
            "__Host-esmii.secondary=two; Path=/; HttpOnly; SameSite=Lax; Secure",
          );
          return new Response(sentinel, { headers, status: 302 });
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/auth/callback/google?code=${sentinel}&state=opaque-state`,
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.url).toContain(`code=${sentinel}`);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/app");
    expect(response.headers["set-cookie"]).toEqual([
      "__Host-esmii.session=one; Path=/; HttpOnly; SameSite=Lax; Secure",
      "__Host-esmii.secondary=two; Path=/; HttpOnly; SameSite=Lax; Secure",
    ]);
    expect(response.headers["x-provider-debug"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(`${response.headers.location} ${response.body}`).not.toContain(sentinel);
    await app.close();
  });

  it("allows the clean account target for provider-link callbacks", async () => {
    const app = buildApp({ logger: false, operationsHealthToken });
    registerBetterAuthRoutes(app, {
      applicationOrigin: "https://esmii.app",
      auth: {
        api: { getSession: async () => null } as never,
        async handler() {
          return new Response(null, {
            headers: { location: "/app/account" },
            status: 307,
          });
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      payload: "code=opaque-code&state=opaque-state",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      url: "/api/auth/callback/apple",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/app/account");
    await app.close();
  });

  it("replaces unsafe or failed callback responses with one non-sensitive result cookie", async () => {
    const sentinel = "PROVIDER_FAILURE_DETAILS_MUST_NOT_REACH_BROWSER";
    const app = buildApp({ logger: false, operationsHealthToken });
    registerBetterAuthRoutes(app, {
      applicationOrigin: "https://esmii.app",
      auth: {
        api: { getSession: async () => null } as never,
        async handler() {
          const headers = new Headers({
            location: `https://attacker.example/sign-in?error=${sentinel}`,
            "x-provider-debug": sentinel,
          });
          headers.append("set-cookie", `provider-raw=${sentinel}; Path=/`);
          return new Response(sentinel, { headers, status: 302 });
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/auth/callback/microsoft?error=${sentinel}&state=opaque-state`,
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/sign-in/result");
    expect(response.headers["set-cookie"]).toBe(
      "__Host-esmii.auth-result=provider_failed; Path=/api/auth/result; HttpOnly; SameSite=Lax; Max-Age=120; Secure",
    );
    expect(response.headers["x-provider-debug"]).toBeUndefined();
    expect(
      `${response.headers.location} ${response.headers["set-cookie"]} ${response.body}`,
    ).not.toContain(sentinel);
    await app.close();
  });

  it("uses the same clean failure redirect when the provider handler throws", async () => {
    const app = buildApp({ logger: false, operationsHealthToken });
    registerBetterAuthRoutes(app, {
      applicationOrigin: "http://localhost:8080",
      auth: {
        api: { getSession: async () => null } as never,
        async handler() {
          throw new Error("provider exception with raw details");
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/callback/google?code=raw-code&state=raw-state",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/sign-in/result");
    expect(response.headers["set-cookie"]).toBe(
      "esmii.auth-result=provider_failed; Path=/api/auth/result; HttpOnly; SameSite=Lax; Max-Age=120",
    );
    expect(response.body).not.toContain("provider exception");
    await app.close();
  });

  it("never forwards stock password or stock organization routes", async () => {
    let calls = 0;
    const app = buildApp({ logger: false, operationsHealthToken });
    registerBetterAuthRoutes(app, {
      applicationOrigin: "http://localhost:8080",
      auth: {
        api: { getSession: async () => null } as never,
        async handler() {
          calls += 1;
          return new Response(null, { status: 204 });
        },
      },
    });
    for (const url of [
      "/api/auth/sign-in/email",
      "/api/auth/list-sessions",
      "/api/auth/organization/create",
    ]) {
      const response = await app.inject({ method: "POST", payload: {}, url });
      expect(response.statusCode).toBe(404);
    }
    expect(calls).toBe(0);
    await app.close();
  });

  it("maps only durable Better Auth session identity", async () => {
    const seam = new BetterAuthAuthenticationSeam({
      api: {
        getSession: async () => ({
          session: { id: "session-synthetic", token: "must-not-cross", userId: "user-synthetic" },
          user: { id: "user-synthetic" },
        }),
      } as never,
    });
    await expect(
      seam.authenticate({ cookieHeader: "esmii.session=fake", requestId: "request-synthetic" }),
    ).resolves.toEqual({ sessionId: "session-synthetic", userId: "user-synthetic" });
    await expect(seam.authenticate({ requestId: "request-anonymous" })).resolves.toBeNull();
  });
});
