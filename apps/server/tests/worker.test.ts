import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ActionLinkKeyring } from "@esmii/config";
import { CapturedEmailTransport } from "@esmii/email";

import {
  ActionLinkWorker,
  type ActionLinkDeliveryIntent,
  type ActionLinkDeliveryRepository,
  type DeliveryAttemptIdentity,
  type MagicLinkIssuer,
  type WorkerCrashPoint,
} from "../src/jobs/action-link-worker.js";
import type { ActionLinkJobPayload } from "../src/jobs/payload.js";

const activeKeyring: ActionLinkKeyring = {
  schemaVersion: 1,
  environment: "test",
  keys: [
    { key: new Uint8Array(32).fill(11), purpose: "magic-link", status: "active", version: 2 },
    { key: new Uint8Array(32).fill(10), purpose: "magic-link", status: "overlap", version: 1 },
    { key: new Uint8Array(32).fill(12), purpose: "invitation", status: "active", version: 4 },
  ],
};

const magicPayload: ActionLinkJobPayload = {
  environment: "test",
  eventId: "event-magic-synthetic-1",
  intentId: "intent-magic-synthetic-1",
  purpose: "magic-link",
};

const invitationPayload: ActionLinkJobPayload = {
  environment: "test",
  eventId: "event-invitation-synthetic-1",
  intentId: "intent-invitation-synthetic-1",
  purpose: "invitation",
};

function pendingIntent(purpose: "magic-link" | "invitation"): ActionLinkDeliveryIntent {
  return {
    callbackIdentifier:
      purpose === "magic-link" ? "magic_login_callback" : "invitation_accept_callback",
    dispatchNotAfter: new Date("2099-08-30T00:10:00.000Z"),
    ...(purpose === "invitation"
      ? {
          invitation: {
            organizationName: "Synthetic Organization",
            role: "member" as const,
          },
        }
      : {}),
    keyVersion: null,
    purpose,
    recipientEmail: "synthetic.user@example.test",
    stableMessageId: null,
    status: "requested",
    tokenHash: null,
  };
}

class MemoryDeliveryRepository implements ActionLinkDeliveryRepository {
  public readonly accepted: DeliveryAttemptIdentity[] = [];
  public readonly failed: { code: string; identity: DeliveryAttemptIdentity; kind: string }[] = [];
  public readonly skipped: string[] = [];
  public readonly started: DeliveryAttemptIdentity[] = [];
  public intent: ActionLinkDeliveryIntent | null;

  public constructor(intent: ActionLinkDeliveryIntent | null) {
    this.intent = intent === null ? null : structuredClone(intent);
  }

  public async commitIssuedHash(input: {
    expiresAt: Date;
    keyVersion: number;
    stableMessageId: string;
    tokenHash: string;
  }): Promise<boolean> {
    if (this.intent === null || this.intent.status !== "requested") return false;
    this.intent = {
      ...this.intent,
      dispatchNotAfter: new Date(input.expiresAt),
      keyVersion: input.keyVersion,
      stableMessageId: input.stableMessageId,
      status: "issued",
      tokenHash: input.tokenHash,
    };
    return true;
  }

  public async getCurrentIntent(): Promise<ActionLinkDeliveryIntent | null> {
    return this.intent === null ? null : structuredClone(this.intent);
  }

  public async recordAccepted(identity: DeliveryAttemptIdentity): Promise<void> {
    this.accepted.push({ ...identity });
  }

  public async recordFailed(
    identity: DeliveryAttemptIdentity,
    failure: { code: string; kind: "permanent" | "retryable" },
  ): Promise<void> {
    this.failed.push({ code: failure.code, identity: { ...identity }, kind: failure.kind });
  }

  public async recordSkipped(
    _identity: Omit<DeliveryAttemptIdentity, "stableMessageId">,
    reason: string,
  ): Promise<void> {
    this.skipped.push(reason);
  }

  public async recordStarted(identity: DeliveryAttemptIdentity): Promise<void> {
    this.started.push({ ...identity });
  }
}

class CapturedMagicIssuer implements MagicLinkIssuer {
  public calls = 0;
  public readonly hashes: string[] = [];
  public unavailable = false;

  public async issue(input: { rawToken: string }) {
    this.calls += 1;
    this.hashes.push(createHash("sha256").update(input.rawToken).digest("hex"));
    if (this.unavailable) throw new Error("Synthetic SMTP unavailable");
    return { providerReference: `capture:${this.calls}` };
  }
}

function worker(input: {
  crashAt?: WorkerCrashPoint;
  email?: CapturedEmailTransport;
  issuer?: CapturedMagicIssuer;
  keyring?: ActionLinkKeyring;
  repository: MemoryDeliveryRepository;
}) {
  return {
    email: input.email ?? new CapturedEmailTransport({ maximumMessages: 5 }),
    issuer: input.issuer ?? new CapturedMagicIssuer(),
    runtime: new ActionLinkWorker({
      ...(input.crashAt === undefined ? {} : { crashAt: input.crashAt }),
      emailTransport: input.email ?? new CapturedEmailTransport({ maximumMessages: 5 }),
      environment: "test",
      keyring: input.keyring ?? activeKeyring,
      magicLinkIssuer: input.issuer ?? new CapturedMagicIssuer(),
      publicOrigin: "http://localhost:8080",
      repository: input.repository,
    }),
  };
}

describe("action-link worker", () => {
  it("commits only the hash, then delivers through the Better Auth magic-link issuer", async () => {
    const repository = new MemoryDeliveryRepository(pendingIntent("magic-link"));
    const issuer = new CapturedMagicIssuer();
    const runtime = new ActionLinkWorker({
      emailTransport: new CapturedEmailTransport(),
      environment: "test",
      keyring: activeKeyring,
      magicLinkIssuer: issuer,
      publicOrigin: "http://localhost:8080",
      repository,
    });

    await expect(runtime.handle(magicPayload, 1)).resolves.toEqual({ outcome: "accepted" });
    expect(issuer.calls).toBe(1);
    expect(repository.intent).toMatchObject({
      keyVersion: 2,
      status: "issued",
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const applicationState = JSON.stringify({ repository, payload: magicPayload });
    expect(applicationState).not.toMatch(/https?:\/\//u);
    expect(applicationState).not.toContain("rawToken");
  });

  it("retries a crash before hash commit normally", async () => {
    const repository = new MemoryDeliveryRepository(pendingIntent("magic-link"));
    const crashing = worker({ crashAt: "before-hash-commit", repository }).runtime;
    await expect(crashing.handle(magicPayload, 1)).rejects.toThrow("before hash commit");
    expect(repository.intent?.status).toBe("requested");

    const issuer = new CapturedMagicIssuer();
    const retry = new ActionLinkWorker({
      emailTransport: new CapturedEmailTransport(),
      environment: "test",
      keyring: activeKeyring,
      magicLinkIssuer: issuer,
      publicOrigin: "http://localhost:8080",
      repository,
    });
    await expect(retry.handle(magicPayload, 2)).resolves.toEqual({ outcome: "accepted" });
    expect(issuer.calls).toBe(1);
  });

  it("rederives the same link after a crash following hash commit", async () => {
    const repository = new MemoryDeliveryRepository(pendingIntent("magic-link"));
    const crashing = worker({ crashAt: "after-hash-commit", repository }).runtime;
    await expect(crashing.handle(magicPayload, 1)).rejects.toThrow("after hash commit");
    const committedHash = repository.intent?.tokenHash;

    const issuer = new CapturedMagicIssuer();
    const retry = new ActionLinkWorker({
      emailTransport: new CapturedEmailTransport(),
      environment: "test",
      keyring: activeKeyring,
      magicLinkIssuer: issuer,
      publicOrigin: "http://localhost:8080",
      repository,
    });
    await retry.handle(magicPayload, 2);
    expect(issuer.hashes).toEqual([committedHash]);
  });

  it("duplicates only the same invitation message identity after SMTP acceptance crash", async () => {
    const repository = new MemoryDeliveryRepository(pendingIntent("invitation"));
    const email = new CapturedEmailTransport({ maximumMessages: 5 });
    const crashing = new ActionLinkWorker({
      crashAt: "after-smtp-acceptance",
      emailTransport: email,
      environment: "test",
      keyring: activeKeyring,
      magicLinkIssuer: new CapturedMagicIssuer(),
      publicOrigin: "http://localhost:8080",
      repository,
    });
    await expect(crashing.handle(invitationPayload, 1)).rejects.toThrow("after SMTP acceptance");

    const retry = new ActionLinkWorker({
      emailTransport: email,
      environment: "test",
      keyring: activeKeyring,
      magicLinkIssuer: new CapturedMagicIssuer(),
      publicOrigin: "http://localhost:8080",
      repository,
    });
    await retry.handle(invitationPayload, 2);
    expect(email.messages).toHaveLength(2);
    expect(email.messages[0]?.messageId).toBe(email.messages[1]?.messageId);
    expect(email.messages[0]?.text).toBe(email.messages[1]?.text);
  });

  it("records retryable SMTP failure and succeeds on the next delivery", async () => {
    const repository = new MemoryDeliveryRepository(pendingIntent("magic-link"));
    const issuer = new CapturedMagicIssuer();
    issuer.unavailable = true;
    const runtime = new ActionLinkWorker({
      emailTransport: new CapturedEmailTransport(),
      environment: "test",
      keyring: activeKeyring,
      magicLinkIssuer: issuer,
      publicOrigin: "http://localhost:8080",
      repository,
    });
    await expect(runtime.handle(magicPayload, 1)).rejects.toThrow("SMTP unavailable");
    expect(repository.failed).toMatchObject([
      { code: "DELIVERY_TEMPORARILY_UNAVAILABLE", kind: "retryable" },
    ]);

    issuer.unavailable = false;
    await expect(runtime.handle(magicPayload, 2)).resolves.toEqual({ outcome: "accepted" });
    expect(issuer.hashes[0]).toBe(issuer.hashes[1]);
  });

  it("skips consumed, superseded, expired, and missing intents", async () => {
    for (const status of ["consumed", "superseded", "expired", "cancelled"] as const) {
      const repository = new MemoryDeliveryRepository({
        ...pendingIntent("magic-link"),
        status,
      });
      const runtime = worker({ repository }).runtime;
      await expect(runtime.handle(magicPayload, 1)).resolves.toMatchObject({ outcome: "skipped" });
      expect(repository.started).toHaveLength(0);
    }
    const missing = new MemoryDeliveryRepository(null);
    await expect(worker({ repository: missing }).runtime.handle(magicPayload, 1)).resolves.toEqual({
      outcome: "skipped",
      reason: "missing",
    });
  });

  it("accepts overlap keys for existing links and rejects retired versions", async () => {
    const overlapDerivedRepository = new MemoryDeliveryRepository({
      ...pendingIntent("magic-link"),
      keyVersion: 1,
      stableMessageId: "<existing.test@messages.esmii.app>",
      status: "issued",
      tokenHash: "0".repeat(64),
    });
    const overlapKeyring: ActionLinkKeyring = {
      ...activeKeyring,
      keys: activeKeyring.keys.map((key) => ({ ...key, key: new Uint8Array(key.key) })),
    };
    const { deriveActionLink } = await import("../src/action-links/derivation.js");
    const derived = deriveActionLink(
      overlapKeyring,
      {
        canonicalEmail: "synthetic.user@example.test",
        environment: "test",
        intentId: magicPayload.intentId,
        purpose: "magic-link",
      },
      1,
    );
    if (overlapDerivedRepository.intent !== null) {
      overlapDerivedRepository.intent.tokenHash = derived.tokenHash;
    }
    await expect(
      worker({ keyring: overlapKeyring, repository: overlapDerivedRepository }).runtime.handle(
        magicPayload,
        1,
      ),
    ).resolves.toEqual({ outcome: "accepted" });

    const retiredKeyring: ActionLinkKeyring = {
      ...overlapKeyring,
      keys: overlapKeyring.keys.map((key) =>
        key.purpose === "magic-link" && key.version === 1 ? { ...key, status: "retired" } : key,
      ),
    };
    const retiredRepository = new MemoryDeliveryRepository(overlapDerivedRepository.intent);
    await expect(
      worker({ keyring: retiredKeyring, repository: retiredRepository }).runtime.handle(
        magicPayload,
        1,
      ),
    ).rejects.toThrow("unavailable or retired");
  });

  it("rejects cross-environment and cross-purpose jobs", async () => {
    const repository = new MemoryDeliveryRepository(pendingIntent("magic-link"));
    const runtime = worker({ repository }).runtime;
    await expect(runtime.handle({ ...magicPayload, environment: "staging" }, 1)).rejects.toThrow(
      "cross-environment",
    );
    await expect(runtime.handle({ ...magicPayload, purpose: "invitation" }, 1)).rejects.toThrow(
      "cross-purpose",
    );
  });
});
