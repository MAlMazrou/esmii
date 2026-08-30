import { describe, expect, it, vi } from "vitest";

import {
  assertAuthPoolSearchPath,
  AUTH_DATABASE_CONNECTION_OPTIONS,
} from "../src/auth/create-auth.js";
import {
  canonicalizeEmail,
  deriveWorkerMagicLinkToken,
  hashActionToken,
  requireWorkerMagicLinkIssuance,
  runWithWorkerMagicLinkIssuance,
  type WorkerMagicLinkIssuance,
} from "../src/auth/issuance-context.js";
import { createDevelopmentMockProvider } from "../src/auth/mock-provider.js";
import {
  classifyPublicAuthRoute,
  mayForwardPublicAuthRouteToBetterAuth,
} from "../src/auth/routes.js";
import {
  applyAuthCallbackSecurityHeaders,
  redactAuthRequestTarget,
  validateCleanSameOriginCallback,
} from "../src/auth/security.js";
import {
  revokeOwnedSessionById,
  serializeSafeSession,
  serializeSafeSessions,
  type OwnedSessionRevocationStore,
} from "../src/auth/sessions.js";

const applicationOrigin = "https://esmii.app";
const rawTokenA = "A".repeat(43);
const rawTokenB = "B".repeat(43);

function authPoolContract(options: string | undefined) {
  return {
    options: { options },
  } as Parameters<typeof assertAuthPoolSearchPath>[0];
}

function issuance(overrides: Partial<WorkerMagicLinkIssuance> = {}): WorkerMagicLinkIssuance {
  return {
    approvedCallbackPath: "/account",
    expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    intentId: "intent-001",
    keyVersion: "v1",
    normalizedEmail: "user@example.invalid",
    rawToken: rawTokenA,
    stableMessageId: "message-001",
    ...overrides,
  };
}

describe("auth callback security", () => {
  it("accepts only clean same-origin callbacks and returns a path identifier", () => {
    expect(validateCleanSameOriginCallback("/account", applicationOrigin)).toBe("/account");
    expect(validateCleanSameOriginCallback("https://esmii.app/settings", applicationOrigin)).toBe(
      "/settings",
    );

    for (const candidate of [
      "https://attacker.example/",
      "//attacker.example/",
      "/account?token=secret",
      "/account#secret",
      " https://esmii.app/account",
      "\\attacker.example/path",
    ]) {
      expect(() => validateCleanSameOriginCallback(candidate, applicationOrigin)).toThrow();
    }
  });

  it("applies callback privacy headers and redacts every query value", () => {
    const headers = applyAuthCallbackSecurityHeaders();
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("pragma")).toBe("no-cache");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(
      redactAuthRequestTarget(
        "/api/auth/callback/google?code=raw-code&state=raw-state#should-not-log",
      ),
    ).toBe("/api/auth/callback/google?[REDACTED]");
  });
});

describe("auth database schema isolation", () => {
  it("accepts only the explicit app-first search path", () => {
    expect(() =>
      assertAuthPoolSearchPath(authPoolContract(AUTH_DATABASE_CONNECTION_OPTIONS)),
    ).not.toThrow();

    for (const connectionOptions of [
      undefined,
      "",
      "-c search_path=public",
      "-c search_path=public,app",
      "-c search_path=app,public -c statement_timeout=5000",
    ]) {
      expect(() => assertAuthPoolSearchPath(authPoolContract(connectionOptions))).toThrow(
        "authentication database pool must use",
      );
    }
  });
});

describe("public Better Auth route mediation", () => {
  it("forwards only social kickoff, provider callbacks, and sign-out", () => {
    expect(classifyPublicAuthRoute("POST", "/api/auth/sign-in/social")).toBe("better-auth");
    expect(classifyPublicAuthRoute("GET", "/api/auth/callback/google?code=secret")).toBe(
      "better-auth",
    );
    expect(classifyPublicAuthRoute("POST", "/api/auth/callback/apple")).toBe("better-auth");
    expect(mayForwardPublicAuthRouteToBetterAuth("POST", "/api/auth/sign-out")).toBe(true);
    expect(classifyPublicAuthRoute("GET", "/api/health/live")).toBe("not-auth");
  });

  it("keeps magic-link, session, account, and organization routes application-owned", () => {
    for (const target of [
      "/api/auth/sign-in/magic-link",
      "/api/auth/magic-link/request",
      "/api/auth/magic-link/verify?token=secret",
      "/api/auth/result",
      "/api/auth/get-session",
      "/api/auth/list-sessions",
      "/api/auth/revoke-session",
      "/api/auth/link-social",
      "/api/auth/unlink-account",
      "/api/auth/organization/list-members",
      "/api/auth/organization/invite-member",
      "/api/auth/organization/accept-invitation",
    ]) {
      expect(classifyPublicAuthRoute("POST", target)).toBe("application");
      expect(mayForwardPublicAuthRouteToBetterAuth("POST", target)).toBe(false);
    }
  });

  it("denies passwords, automatic verification email, and unknown future routes", () => {
    for (const target of [
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email",
      "/api/auth/request-password-reset",
      "/api/auth/reset-password/raw-token",
      "/api/auth/send-verification-email",
      "/api/auth/unknown-plugin-route",
      "/api/auth/callback/github",
      "/api/auth/callback/google/extra",
      "https://esmii.app/api/auth/callback/google",
      "//esmii.app/api/auth/callback/google",
    ]) {
      expect(classifyPublicAuthRoute("POST", target)).toBe("deny");
    }
  });
});

describe("worker-only magic-link issuance context", () => {
  it("derives a deterministic purpose- and environment-bound 256-bit token", () => {
    const input = {
      environmentId: "development",
      intentId: "intent-001",
      key: new Uint8Array(32).fill(7),
      keyVersion: "v1",
      normalizedEmail: "user@example.invalid",
    } as const;
    const token = deriveWorkerMagicLinkToken(input);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(deriveWorkerMagicLinkToken(input)).toBe(token);
    expect(deriveWorkerMagicLinkToken({ ...input, intentId: "intent-002" })).not.toBe(token);
    expect(deriveWorkerMagicLinkToken({ ...input, environmentId: "staging" })).not.toBe(token);
  });

  it("hashes the transient token with SHA-256 and rejects non-256-bit encodings", () => {
    expect(hashActionToken(rawTokenA)).toBe(
      "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
    );
    expect(() => hashActionToken("short-token")).toThrow();
  });

  it("keeps concurrent issuance contexts isolated", async () => {
    const [first, second] = await Promise.all([
      runWithWorkerMagicLinkIssuance(issuance(), applicationOrigin, async () => {
        await Promise.resolve();
        return requireWorkerMagicLinkIssuance().rawToken;
      }),
      runWithWorkerMagicLinkIssuance(
        issuance({ intentId: "intent-002", rawToken: rawTokenB }),
        applicationOrigin,
        async () => {
          await Promise.resolve();
          return requireWorkerMagicLinkIssuance().rawToken;
        },
      ),
    ]);

    expect(first).toBe(rawTokenA);
    expect(second).toBe(rawTokenB);
    expect(() => requireWorkerMagicLinkIssuance()).toThrow(
      "worker magic-link issuance context is required",
    );
  });

  it("requires the email to already use the shared canonical form", () => {
    expect(canonicalizeEmail(" User@Example.Invalid ")).toBe("user@example.invalid");
    expect(() =>
      runWithWorkerMagicLinkIssuance(
        issuance({ normalizedEmail: "User@Example.Invalid" }),
        applicationOrigin,
        () => undefined,
      ),
    ).toThrow("normalizedEmail must already be canonical");
  });
});

describe("safe session management", () => {
  const session = {
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    expiresAt: new Date("2026-09-06T00:00:00.000Z"),
    id: "session-001",
    ipAddress: "192.0.2.10",
    token: "raw-session-token",
    updatedAt: new Date("2026-08-30T01:00:00.000Z"),
    userAgent: "Synthetic Browser",
    userId: "user-001",
  };

  it("serializes explicit display fields without token material", () => {
    const safeSession = serializeSafeSession(session, "session-001");
    expect(safeSession).toEqual({
      createdAt: "2026-08-30T00:00:00.000Z",
      current: true,
      expiresAt: "2026-09-06T00:00:00.000Z",
      id: "session-001",
      ipAddress: "192.0.2.10",
      updatedAt: "2026-08-30T01:00:00.000Z",
      userAgent: "Synthetic Browser",
    });
    expect(safeSession).not.toHaveProperty("token");
    expect(safeSession).not.toHaveProperty("userId");
    expect(serializeSafeSessions([session], "session-001")).toEqual([safeSession]);
  });

  it("refuses current-session revocation and delegates an owned-id atomic delete", async () => {
    const store: OwnedSessionRevocationStore = {
      revokeOtherOwnedSessions: vi.fn(async () => 0),
      revokeOwnedSessionById: vi.fn(async () => true),
    };

    await expect(
      revokeOwnedSessionById(store, {
        currentSessionId: "session-001",
        sessionId: "session-001",
        userId: "user-001",
      }),
    ).resolves.toBe("current-session");
    expect(store.revokeOwnedSessionById).not.toHaveBeenCalled();

    await expect(
      revokeOwnedSessionById(store, {
        currentSessionId: "session-001",
        sessionId: "session-002",
        userId: "user-001",
      }),
    ).resolves.toBe("revoked");
    expect(store.revokeOwnedSessionById).toHaveBeenCalledWith({
      currentSessionId: "session-001",
      sessionId: "session-002",
      userId: "user-001",
    });
  });
});

describe("development mock provider seam", () => {
  it("exposes only fixed synthetic scenarios in development and test", () => {
    const provider = createDevelopmentMockProvider("development");
    expect(provider.id).toBe("esmii-development-mock");
    expect(provider.resolveScenario("verified-new-user")).toEqual({
      email: "new.user@example.invalid",
      emailVerified: true,
      name: "New User",
      providerAccountId: "mock-new-user",
    });
    expect(() => provider.resolveScenario("provider-error")).toThrow("synthetic provider failure");
  });

  it("cannot be constructed for staging or production", () => {
    expect(() => createDevelopmentMockProvider("staging")).toThrow();
    expect(() => createDevelopmentMockProvider("production")).toThrow();
  });
});
