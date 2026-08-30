import { describe, expect, it } from "vitest";

import type { ActionLinkKeyring } from "@esmii/config";

import {
  actionTokenHashMatches,
  deriveActionLink,
  stableMessageId,
} from "../src/action-links/derivation.js";
import { decideActionLinkDelivery, expiresAtForPurpose } from "../src/action-links/state.js";
import {
  hasCapability,
  requireOrganizationCapability,
  requireRecentAuthentication,
  type OrganizationCapability,
  type OrganizationRole,
} from "../src/authorization/roles.js";
import { canonicalizeEmail } from "../src/domain/email.js";
import { parseActionLinkJobPayload } from "../src/jobs/payload.js";
import { organizationRoom } from "../src/realtime/rooms.js";
import {
  CapturedTombstoneJournal,
  executeAccessReduction,
  replayTombstones,
} from "../src/security/tombstones.js";

const keyring: ActionLinkKeyring = {
  environment: "test",
  schemaVersion: 1,
  keys: [
    {
      key: new Uint8Array(32).fill(7),
      purpose: "magic-link",
      status: "active",
      version: 3,
    },
    {
      key: new Uint8Array(32).fill(9),
      purpose: "invitation",
      status: "active",
      version: 5,
    },
  ],
};

describe("organization authorization matrix", () => {
  const matrix: Record<OrganizationRole, readonly OrganizationCapability[]> = {
    owner: [
      "organization:view",
      "organization:update",
      "organization:delete",
      "members:list",
      "members:add-remove",
      "members:change-role",
      "owners:manage",
      "invitations:manage",
      "profile:update-own",
    ],
    editor: ["organization:view", "members:list", "invitations:manage", "profile:update-own"],
    member: ["organization:view", "profile:update-own"],
  };

  for (const role of ["owner", "editor", "member"] as const) {
    it(`grants only the locked ${role} capabilities`, () => {
      const allCapabilities = matrix.owner;
      for (const capability of allCapabilities) {
        expect(hasCapability(role, capability)).toBe(matrix[role].includes(capability));
      }
    });
  }

  it("denies a valid membership when active or resource organization scope differs", () => {
    expect(() =>
      requireOrganizationCapability({
        activeOrganizationId: "org-a",
        capability: "organization:view",
        membership: {
          active: true,
          organizationId: "org-a",
          role: "owner",
          userId: "user-a",
        },
        resourceOrganizationId: "org-b",
      }),
    ).toThrow("Organization access denied");
  });

  it("requires recent authentication for sensitive owner actions", () => {
    const now = new Date("2026-08-30T00:20:00.000Z");
    expect(() =>
      requireRecentAuthentication(new Date("2026-08-30T00:00:00.000Z"), now, 600),
    ).toThrow("Organization access denied");
    expect(() =>
      requireRecentAuthentication(new Date("2026-08-30T00:15:00.000Z"), now, 600),
    ).not.toThrow();
  });
});

describe("action-link worker boundaries", () => {
  const input = {
    canonicalEmail: "synthetic.user@example.test",
    environment: "test" as const,
    intentId: "intent-synthetic-1",
    purpose: "magic-link" as const,
  };

  it("derives the same 256-bit token and hash for retry without persisting a URL", () => {
    const first = deriveActionLink(keyring, input);
    const retry = deriveActionLink(keyring, input);

    expect(first).toEqual(retry);
    expect(first.token).toHaveLength(43);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(actionTokenHashMatches(first.token, first.tokenHash)).toBe(true);
    expect(JSON.stringify({ intentId: input.intentId, tokenHash: first.tokenHash })).not.toContain(
      first.token,
    );
  });

  it("separates purpose and environment and rejects retired/cross-environment access", () => {
    const invitation = deriveActionLink(keyring, { ...input, purpose: "invitation" });
    expect(invitation.token).not.toBe(deriveActionLink(keyring, input).token);
    expect(() => deriveActionLink(keyring, { ...input, environment: "staging" })).toThrow(
      "environment mismatch",
    );
  });

  it("uses 10-minute magic-link and seven-day invitation expiries", () => {
    const issuedAt = new Date("2026-08-30T00:00:00.000Z");
    expect(expiresAtForPurpose("magic-link", issuedAt).toISOString()).toBe(
      "2026-08-30T00:10:00.000Z",
    );
    expect(expiresAtForPurpose("invitation", issuedAt).toISOString()).toBe(
      "2026-09-06T00:00:00.000Z",
    );
  });

  it("skips expired, consumed, and superseded retry work", () => {
    const base = {
      canonicalEmail: input.canonicalEmail,
      consumedAt: null,
      environment: "test" as const,
      expiresAt: new Date("2026-08-30T00:10:00.000Z"),
      id: input.intentId,
      keyVersion: 3,
      purpose: "magic-link" as const,
      state: "pending" as const,
      supersededAt: null,
      tokenHash: null,
    };
    expect(decideActionLinkDelivery(base, new Date("2026-08-30T00:09:00.000Z"))).toEqual({
      kind: "derive-and-commit",
    });
    expect(decideActionLinkDelivery(base, new Date("2026-08-30T00:10:00.000Z"))).toEqual({
      kind: "skip",
      reason: "expired",
    });
    expect(
      decideActionLinkDelivery(
        { ...base, state: "superseded", supersededAt: new Date("2026-08-30T00:05:00.000Z") },
        new Date("2026-08-30T00:06:00.000Z"),
      ),
    ).toEqual({ kind: "skip", reason: "superseded" });
  });

  it("accepts only an intent-only pg-boss payload", () => {
    const valid = {
      environment: "test",
      eventId: "event-synthetic-1",
      intentId: "intent-synthetic-1",
      purpose: "magic-link",
    };
    expect(parseActionLinkJobPayload(valid)).toEqual(valid);
    expect(() => parseActionLinkJobPayload({ ...valid, token: "forbidden" })).toThrow(
      "prohibited fields",
    );
    expect(() =>
      parseActionLinkJobPayload({ ...valid, url: "https://example.test/forbidden" }),
    ).toThrow("prohibited fields");
  });

  it("creates a stable retry message identity", () => {
    expect(stableMessageId("event-synthetic-1", "test", "messages.example.test")).toBe(
      "<event-synthetic-1.test@messages.example.test>",
    );
  });
});

describe("security tombstone recovery", () => {
  const input = {
    eventId: "event-tombstone-1",
    now: new Date("2026-08-30T00:00:00.000Z"),
    operation: "membership-remove" as const,
    scopeId: "membership-synthetic-1",
    scopeKind: "membership" as const,
  };

  it("does not report success until prepare, mutation, and commit are durable", async () => {
    const journal = new CapturedTombstoneJournal();
    await expect(executeAccessReduction(journal, input, async () => "done")).resolves.toBe("done");
    expect(journal.records.map((record) => record.phase)).toEqual(["prepared", "committed"]);
    expect(replayTombstones(journal.records)).toEqual({
      failClosedAllTenants: false,
      failClosedScopes: [],
      highWatermark: 2,
    });
  });

  it("records cancel when the local mutation fails", async () => {
    const journal = new CapturedTombstoneJournal();
    await expect(
      executeAccessReduction(journal, input, async () => {
        throw new Error("Synthetic mutation failure");
      }),
    ).rejects.toThrow("Synthetic mutation failure");
    expect(journal.records.map((record) => record.phase)).toEqual(["prepared", "cancelled"]);
  });

  it("fails the affected scope closed after an unresolved prepare", async () => {
    const journal = new CapturedTombstoneJournal(["commit"]);
    await expect(executeAccessReduction(journal, input, async () => "changed")).rejects.toThrow(
      "Synthetic tombstone commit failure",
    );
    expect(replayTombstones(journal.records)).toMatchObject({
      failClosedAllTenants: false,
      failClosedScopes: [{ scopeId: input.scopeId, scopeKind: "membership" }],
    });
  });

  it("fails all tenants closed on a sequence gap", () => {
    expect(
      replayTombstones([
        {
          ...input,
          occurredAt: input.now.toISOString(),
          phase: "prepared",
          sequence: 2,
        },
      ]),
    ).toMatchObject({ failClosedAllTenants: true });
  });
});

describe("safe identity and realtime naming", () => {
  it("canonicalizes case without removing dots or plus tags", () => {
    expect(canonicalizeEmail("  Synthetic.User+tag@Example.Test ")).toBe(
      "synthetic.user+tag@example.test",
    );
  });

  it("creates only validated server-side organization rooms", () => {
    expect(organizationRoom("org_synthetic-1")).toBe("organization:org_synthetic-1");
    expect(() => organizationRoom("../org")).toThrow("organizationId is invalid");
  });
});
