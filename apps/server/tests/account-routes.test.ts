import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { AccountHttpError, type AccountHttpService } from "../src/http/account-routes.js";
import type { AbuseRateLimiter } from "../src/security/rate-limiter.js";

const requestMagicLink = vi.fn(async () => undefined);
const createOrganization = vi.fn(async () => undefined);
const createInvitation = vi.fn(async () => undefined);
const resendInvitation = vi.fn(async () => undefined);
const consumeRateLimit = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 60 }));
const allowingRateLimiter: AbuseRateLimiter = { consume: consumeRateLimit };
const genericMagicResponse = {
  status: "accepted",
  message: "If this email can sign in, a link will arrive shortly.",
};

const service: AccountHttpService = {
  acceptInvitation: async () => undefined,
  createInvitation,
  createOrganization,
  deleteOrganization: async () => undefined,
  getAuthResult: async () => ({ state: "invalid" }),
  getInvitation: async () => ({ state: "needs_authentication" }),
  getOrganization: async () => ({
    id: "org-synthetic-1",
    displayName: "Synthetic Organization",
    locator: "synthetic-organization",
    role: "owner",
  }),
  getPublicConfiguration: async () => ({
    applicationName: "Esmii",
    applicationSlug: "esmii",
    providers: [{ id: "google", enabled: true, mode: "mock" }],
  }),
  getViewer: async () => ({
    user: {
      id: "user-synthetic-1",
      displayName: "Synthetic User",
      email: "synthetic.user@example.test",
      emailVerified: true,
    },
    activeOrganization: null,
    organizations: [],
  }),
  grantOwner: async () => undefined,
  linkProvider: async (_context, provider) => ({
    redirectUrl:
      provider === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth"
        : "http://localhost:8080/app/account",
  }),
  listInvitations: async () => ({ items: [], total: 0, pendingCount: 0, nextCursor: null }),
  listMembers: async () => ({ items: [], total: 0, nextCursor: null }),
  listProviders: async () => ({ items: [] }),
  listSessions: async () => ({
    items: [
      {
        id: "session-synthetic-1",
        current: true,
        createdAt: "2026-08-30T00:00:00.000Z",
        lastSeenAt: "2026-08-30T00:00:00.000Z",
        clientLabel: "Synthetic browser",
      },
    ],
  }),
  logout: async () => ({
    setCookieHeaders: ["better-auth.session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
  }),
  removeMember: async () => undefined,
  requestMagicLink,
  resendInvitation,
  revokeInvitation: async () => undefined,
  revokeOtherSessions: async () => undefined,
  revokeProvider: async () => undefined,
  revokeSession: async () => undefined,
  switchOrganization: async () => undefined,
  updateMemberRole: async () => undefined,
  updateOrganization: async () => undefined,
  updateProfile: async () => undefined,
};

function app(
  overrides: Partial<AccountHttpService> = {},
  rateLimiter: AbuseRateLimiter = allowingRateLimiter,
) {
  return buildApp({
    logger: false,
    operationsHealthToken: "x".repeat(32),
    account: {
      authentication: {
        async authenticate(request) {
          return request.cookieHeader?.includes("authenticated=yes") === true
            ? { sessionId: "session-synthetic-1", userId: "user-synthetic-1" }
            : null;
        },
      },
      abuseRateLimiter: rateLimiter,
      service: { ...service, ...overrides },
    },
  });
}

describe("Prompt 03 account HTTP contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes only safe provider availability in public configuration", async () => {
    const instance = app();
    const response = await instance.inject({ method: "GET", url: "/api/public/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      applicationName: "Esmii",
      applicationSlug: "esmii",
      providers: [{ id: "google", enabled: true, mode: "mock" }],
    });
    expect(response.body).not.toMatch(/clientSecret|database|valkey|keyring|smtp/iu);
    await instance.close();
  });

  it("returns the identical non-enumerating magic-link request response", async () => {
    const instance = app();
    for (const [index, email] of ["known@example.test", "unknown@example.test"].entries()) {
      const response = await instance.inject({
        method: "POST",
        url: "/api/auth/magic-link/request",
        headers: {
          "idempotency-key": `magic-link-request:00000000-0000-0000-0000-00000000000${index}`,
        },
        payload: { email },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(genericMagicResponse);
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(requestMagicLink).toHaveBeenCalledTimes(2);
    expect(consumeRateLimit).toHaveBeenCalledTimes(4);
    expect(consumeRateLimit).toHaveBeenCalledWith({
      bucket: "magic-email",
      limit: 5,
      subject: "known@example.test",
      windowSeconds: 600,
    });
    expect(consumeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "magic-network", limit: 30, windowSeconds: 600 }),
    );
    await instance.close();
  });

  it("keeps malformed, denied, and unavailable magic-link requests indistinguishable", async () => {
    const cases: Array<{ email: string; limiter: AbuseRateLimiter }> = [
      { email: "x", limiter: allowingRateLimiter },
      {
        email: "limited@example.test",
        limiter: {
          consume: vi.fn(async (input) => ({
            allowed: input.bucket !== "magic-email",
            retryAfterSeconds: 600,
          })),
        },
      },
      {
        email: "unavailable@example.test",
        limiter: {
          consume: vi.fn(async () => {
            throw new Error("Synthetic Valkey failure");
          }),
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const instance = app({}, testCase.limiter);
      const response = await instance.inject({
        method: "POST",
        url: "/api/auth/magic-link/request",
        headers: {
          "idempotency-key": `magic-link-failure:00000000-0000-0000-0000-00000000000${index}`,
        },
        payload: { email: testCase.email },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(genericMagicResponse);
      expect(response.body).not.toContain(testCase.email);
      await instance.close();
    }
    expect(requestMagicLink).not.toHaveBeenCalled();
  });

  it("requires authentication without disclosing tenant existence", async () => {
    const instance = app();
    const response = await instance.inject({ method: "GET", url: "/api/viewer" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
    await instance.close();
  });

  it("expires the Better Auth session cookie on application logout", async () => {
    const instance = app();
    const response = await instance.inject({
      method: "POST",
      url: "/api/account/logout",
      headers: { cookie: "authenticated=yes" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(JSON.stringify(response.headers["set-cookie"])).toContain("Max-Age=0");
    expect(response.body).not.toContain("synthetic-session-cookie");
    await instance.close();
  });

  it("requires an idempotency key for mutation routes", async () => {
    const instance = app();
    const response = await instance.inject({
      method: "POST",
      url: "/api/organizations",
      headers: { cookie: "authenticated=yes" },
      payload: { displayName: "Synthetic Organization" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(createOrganization).not.toHaveBeenCalled();
    await instance.close();
  });

  it("rate-limits invitation creation by actor and canonical recipient", async () => {
    const instance = app();
    const response = await instance.inject({
      method: "POST",
      url: "/api/organization/invitations",
      headers: {
        cookie: "authenticated=yes",
        "idempotency-key": "invitation-create:00000000-0000-0000-0000-000000000001",
      },
      payload: { email: " Invitee@Example.Test ", role: "member" },
    });

    expect(response.statusCode).toBe(200);
    expect(createInvitation).toHaveBeenCalledOnce();
    expect(consumeRateLimit).toHaveBeenCalledTimes(2);
    expect(consumeRateLimit).toHaveBeenCalledWith({
      bucket: "invitation-actor",
      limit: 20,
      subject: "user-synthetic-1",
      windowSeconds: 3600,
    });
    expect(consumeRateLimit).toHaveBeenCalledWith({
      bucket: "invitation-recipient",
      limit: 5,
      subject: "invitee@example.test",
      windowSeconds: 3600,
    });
    await instance.close();
  });

  it("returns a safe 429 without creating a rate-limited invitation", async () => {
    const recipient = "private.recipient@example.test";
    const instance = app(
      {},
      {
        consume: vi.fn(async (input) => ({
          allowed: input.bucket !== "invitation-recipient",
          retryAfterSeconds: 3600,
        })),
      },
    );
    const response = await instance.inject({
      method: "POST",
      url: "/api/organization/invitations",
      headers: {
        cookie: "authenticated=yes",
        "idempotency-key": "invitation-limited:00000000-0000-0000-0000-000000000001",
      },
      payload: { email: recipient, role: "editor" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
    });
    expect(response.body).not.toContain(recipient);
    expect(response.body).not.toContain("user-synthetic-1");
    expect(createInvitation).not.toHaveBeenCalled();
    await instance.close();
  });

  it("returns a safe 503 when invitation rate-limit storage is unavailable", async () => {
    const recipient = "private.recipient@example.test";
    const instance = app(
      {},
      {
        consume: vi.fn(async () => {
          throw new Error(`Synthetic store failure for ${recipient}`);
        }),
      },
    );
    const response = await instance.inject({
      method: "POST",
      url: "/api/organization/invitations",
      headers: {
        cookie: "authenticated=yes",
        "idempotency-key": "invitation-unavailable:00000000-0000-0000-0000-000000000001",
      },
      payload: { email: recipient, role: "member" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "RATE_LIMIT_UNAVAILABLE",
        message: "Request protection is temporarily unavailable.",
      },
    });
    expect(response.body).not.toContain(recipient);
    expect(response.body).not.toContain("Synthetic store failure");
    expect(createInvitation).not.toHaveBeenCalled();
    await instance.close();
  });

  it("rate-limits invitation resend by actor and invitation", async () => {
    const instance = app();
    const response = await instance.inject({
      method: "POST",
      url: "/api/organization/invitations/invitation-synthetic-1/resend",
      headers: {
        cookie: "authenticated=yes",
        "idempotency-key": "invitation-resend:00000000-0000-0000-0000-000000000001",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resendInvitation).toHaveBeenCalledOnce();
    expect(consumeRateLimit).toHaveBeenCalledTimes(2);
    expect(consumeRateLimit).toHaveBeenCalledWith({
      bucket: "invitation-resend",
      limit: 5,
      subject: "actor:user-synthetic-1",
      windowSeconds: 3600,
    });
    expect(consumeRateLimit).toHaveBeenCalledWith({
      bucket: "invitation-resend",
      limit: 5,
      subject: "invitation:invitation-synthetic-1",
      windowSeconds: 3600,
    });
    await instance.close();
  });

  it("does not resend when either authenticated resend bucket denies or fails", async () => {
    const cases: Array<{ expectedStatus: 429 | 503; limiter: AbuseRateLimiter }> = [
      {
        expectedStatus: 429,
        limiter: {
          consume: vi.fn(async (input) => ({
            allowed: input.subject !== "invitation:invitation-private-1",
            retryAfterSeconds: 3600,
          })),
        },
      },
      {
        expectedStatus: 503,
        limiter: {
          consume: vi.fn(async () => {
            throw new Error("Synthetic private backend detail");
          }),
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const instance = app({}, testCase.limiter);
      const response = await instance.inject({
        method: "POST",
        url: "/api/organization/invitations/invitation-private-1/resend",
        headers: {
          cookie: "authenticated=yes",
          "idempotency-key": `invitation-resend-failure:00000000-0000-0000-0000-00000000000${index}`,
        },
      });
      expect(response.statusCode).toBe(testCase.expectedStatus);
      expect(response.body).not.toContain("invitation-private-1");
      expect(response.body).not.toContain("Synthetic private backend detail");
      await instance.close();
    }
    expect(resendInvitation).not.toHaveBeenCalled();
  });

  it("returns the same forbidden shape for a cross-organization service denial", async () => {
    const instance = app({
      listMembers: async () => {
        throw new AccountHttpError(403, "FORBIDDEN", "This action is not allowed.");
      },
    });
    const response = await instance.inject({
      method: "GET",
      url: "/api/organization/members",
      headers: { cookie: "authenticated=yes" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("organization");
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    await instance.close();
  });

  it("rejects password routes", async () => {
    const instance = app();
    const response = await instance.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "synthetic@example.test", password: "forbidden" },
    });

    expect(response.statusCode).toBe(404);
    await instance.close();
  });

  it("query-redacts auth and invitation targets before logging", async () => {
    const { sanitizeRequestTarget } = await import("../src/observability/logger.js");
    const sentinel = "UNIQUE_TOKEN_SENTINEL_001";

    expect(sanitizeRequestTarget(`/api/auth/callback?code=${sentinel}`)).toBe(
      "/[REDACTED_ACTION_ROUTE]",
    );
    expect(sanitizeRequestTarget(`/api/invitation?token=${sentinel}`)).toBe(
      "/[REDACTED_ACTION_ROUTE]",
    );
  });
});
