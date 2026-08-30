import type { Pool, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import { acceptInvitationFromContinuation } from "../src/repositories/invitations.js";
import { inspectInvitationContinuation } from "../src/repositories/continuations.js";
import type { SqlExecutor } from "../src/transactions.js";

function result<Row extends QueryResultRow>(
  rows: Row[] = [],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: "", fields: [], oid: 0, rowCount, rows };
}

describe("invitation continuation inspection", () => {
  it("returns only safe invitation presentation fields after hash authentication", async () => {
    const secretHash = "a".repeat(64);
    const executor = {
      async query() {
        return {
          rowCount: 1,
          rows: [
            {
              email: "invitee@example.test",
              expires_at: new Date("2030-01-01T00:00:00.000Z"),
              invitation_id: "synthetic-invitation",
              invitation_status: "pending",
              organization_deleted: false,
              organization_name: "Synthetic Organization",
              role: "member",
              secret_hash: secretHash,
            },
          ],
        } as QueryResult;
      },
    } satisfies SqlExecutor;

    const inspected = await inspectInvitationContinuation(executor, {
      continuationId: "10000000-0000-4000-8000-000000000001",
      presentedSecretHash: secretHash,
    });

    expect(inspected).toEqual({
      email: "invitee@example.test",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      invitationId: "synthetic-invitation",
      organization: { deleted: false, displayName: "Synthetic Organization" },
      role: "member",
      status: "pending",
    });
    expect(inspected).not.toHaveProperty("secretHash");
    expect(inspected).not.toHaveProperty("actionIntentId");
  });

  it("rejects malformed hashes before querying", async () => {
    let queried = false;
    const executor = {
      async query() {
        queried = true;
        throw new Error("unexpected query");
      },
    } satisfies SqlExecutor;

    await expect(
      inspectInvitationContinuation(executor, {
        continuationId: "10000000-0000-4000-8000-000000000001",
        presentedSecretHash: "not-a-hash",
      }),
    ).resolves.toBeNull();
    expect(queried).toBe(false);
  });

  it("returns only the committed organization invalidation shape after atomic acceptance", async () => {
    const actionIntentId = "10000000-0000-4000-8000-000000000002";
    const auditEventId = "10000000-0000-4000-8000-000000000003";
    const invitationId = "synthetic-invitation";
    const organizationId = "synthetic-organization";
    const secretHash = "b".repeat(64);
    const responses: QueryResult[] = [
      result(),
      result([
        { action_intent_id: actionIntentId, invitation_id: invitationId, secret_hash: secretHash },
      ]),
      result([{ email: "invitee@example.test", email_verified: true, status: "active" }]),
      result([{ organization_id: organizationId }]),
      result(),
      result([{ id: organizationId }]),
      result([
        {
          email: "invitee@example.test",
          expires_at: new Date("2030-01-01T00:00:00.000Z"),
          id: invitationId,
          organization_id: organizationId,
          role: "member",
          status: "pending",
          version: 1,
        },
      ]),
      result([{ id: organizationId }]),
      result(),
      result([{ id: "synthetic-membership", version: 1 }]),
      result([], 1),
      result([], 1),
      result([], 1),
      result([], 1),
      result([], 1),
      result(),
    ];
    const query = vi.fn(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected query");
      return response;
    });
    const release = vi.fn();
    const pool = {
      async connect() {
        return { query, release };
      },
    } as unknown as Pool;

    const accepted = await acceptInvitationFromContinuation(pool, {
      audit: {
        action: "invitation.accepted",
        actorUserId: "synthetic-user",
        correlationId: "synthetic-correlation",
        eventId: auditEventId,
        metadata: {},
        organizationId,
        requestId: "synthetic-request",
        result: "success",
        targetId: invitationId,
        targetType: "invitation",
      },
      authorizationEventId: "10000000-0000-4000-8000-000000000004",
      authorizationIdempotencyKey: "synthetic-authorization-key",
      continuationId: "10000000-0000-4000-8000-000000000005",
      correlationId: "synthetic-correlation",
      environment: "test",
      membershipId: "synthetic-membership",
      presentedSecretHash: secretHash,
      userId: "synthetic-user",
    });

    expect(accepted).toEqual({ organizationId, version: auditEventId });
    expect(accepted).not.toHaveProperty("email");
    expect(accepted).not.toHaveProperty("token");
    expect(accepted).not.toHaveProperty("secretHash");
    expect(responses).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });
});
