import { createHash } from "node:crypto";

import type { AppEnvironment } from "@esmii/config";
import {
  claimOutboxBatch,
  getActionIntentForDelivery,
  issueCurrentActionIntent,
  markOutboxDispatched,
  recordDeliveryAttemptAccepted,
  recordDeliveryAttemptFailed,
  recordDeliveryAttemptSkipped,
  recordDeliveryAttemptStarted,
  releaseOrExhaustOutboxLease,
  withTransaction,
  type DatabaseClient,
} from "@esmii/database";

import { stableMessageId } from "../action-links/derivation.js";
import type {
  ActionLinkDeliveryRepository,
  DeliveryAttemptIdentity,
} from "./action-link-worker.js";
import type { ActionLinkPurpose } from "@esmii/config";
import type { SafeOutboxEvent, WorkerOutboxStore } from "./pg-boss.js";

function databasePurpose(purpose: ActionLinkPurpose): "invitation_accept" | "magic_login" {
  return purpose === "magic-link" ? "magic_login" : "invitation_accept";
}

function deliveryAttemptId(identity: { attemptNumber: number; eventId: string }): string {
  const bytes = createHash("sha256")
    .update("esmii-delivery-attempt-v1\0", "utf8")
    .update(identity.eventId, "utf8")
    .update("\0", "utf8")
    .update(String(identity.attemptNumber), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireKeyVersion(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[1-9]\d{0,8}$/u.test(value)) throw new TypeError("stored key version is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("stored key version is invalid");
  return parsed;
}

export class PostgresActionLinkDeliveryRepository implements ActionLinkDeliveryRepository {
  readonly #database: DatabaseClient;
  readonly #environment: AppEnvironment;

  public constructor(database: DatabaseClient, environment: AppEnvironment) {
    this.#database = database;
    this.#environment = environment;
  }

  public async getCurrentIntent(input: {
    environment: AppEnvironment;
    intentId: string;
    purpose: ActionLinkPurpose;
  }) {
    const intent = await getActionIntentForDelivery(this.#database.pool, {
      environment: input.environment,
      intentId: input.intentId,
      purpose: databasePurpose(input.purpose),
    });
    if (intent === null) return null;
    const keyVersion = requireKeyVersion(intent.keyVersion);
    const invitation =
      input.purpose === "invitation" &&
      intent.organization !== null &&
      intent.invitationRole !== null
        ? {
            organizationName: intent.organization.name,
            role: intent.invitationRole,
          }
        : undefined;
    return {
      callbackIdentifier: intent.callbackIdentifier,
      dispatchNotAfter: intent.dispatchNotAfter,
      ...(invitation === undefined ? {} : { invitation }),
      keyVersion,
      purpose: input.purpose,
      recipientEmail: intent.recipientEmail,
      stableMessageId: intent.stableMessageId,
      status: intent.status,
      tokenHash: intent.tokenHash,
    };
  }

  public async commitIssuedHash(input: {
    environment: AppEnvironment;
    expiresAt: Date;
    intentId: string;
    keyVersion: number;
    purpose: ActionLinkPurpose;
    stableMessageId: string;
    tokenHash: string;
  }): Promise<boolean> {
    return withTransaction(this.#database.pool, (transaction) =>
      issueCurrentActionIntent(transaction, {
        environment: input.environment,
        expiresAt: input.expiresAt,
        intentId: input.intentId,
        keyVersion: String(input.keyVersion),
        purpose: databasePurpose(input.purpose),
        stableMessageId: input.stableMessageId,
        tokenHash: input.tokenHash,
      }),
    );
  }

  public async recordStarted(identity: DeliveryAttemptIdentity): Promise<void> {
    await recordDeliveryAttemptStarted(this.#database.pool, {
      attemptId: deliveryAttemptId(identity),
      attemptNumber: identity.attemptNumber,
      outboxEventId: identity.eventId,
      stableMessageId: identity.stableMessageId,
    });
  }

  public async recordAccepted(
    identity: DeliveryAttemptIdentity,
    providerReference?: string,
  ): Promise<void> {
    await recordDeliveryAttemptAccepted(this.#database.pool, {
      attemptId: deliveryAttemptId(identity),
      providerReference: providerReference ?? null,
    });
  }

  public async recordFailed(
    identity: DeliveryAttemptIdentity,
    failure: { code: string; kind: "permanent" | "retryable" },
  ): Promise<void> {
    await recordDeliveryAttemptFailed(this.#database.pool, {
      attemptId: deliveryAttemptId(identity),
      failureClass: failure.kind,
      failureCode: failure.code,
    });
  }

  public async recordSkipped(
    identity: Omit<DeliveryAttemptIdentity, "stableMessageId">,
    reason: "cancelled" | "consumed" | "expired" | "missing" | "superseded",
  ): Promise<void> {
    await recordDeliveryAttemptSkipped(this.#database.pool, {
      attemptId: deliveryAttemptId(identity),
      attemptNumber: identity.attemptNumber,
      outboxEventId: identity.eventId,
      reason,
      stableMessageId: stableMessageId(identity.eventId, this.#environment),
    });
  }
}

export class PostgresWorkerOutboxStore implements WorkerOutboxStore {
  readonly #database: DatabaseClient;

  public constructor(database: DatabaseClient) {
    this.#database = database;
  }

  public async claim(input: { limit: number; leaseSeconds: number; workerId: string }) {
    const rows = await claimOutboxBatch(this.#database.pool, {
      ...input,
      allowedEventTypes: ["magic_link.requested", "invitation.requested"],
    });
    return rows.flatMap((row) => {
      if (row.eventType !== "magic_link.requested" && row.eventType !== "invitation.requested") {
        return [];
      }
      return [
        {
          eventId: row.eventId,
          eventType: row.eventType,
          payload: row.payload,
        } satisfies SafeOutboxEvent,
      ];
    });
  }

  public async markDispatched(input: {
    eventId: string;
    jobId: string;
    workerId: string;
  }): Promise<void> {
    if (
      !(await markOutboxDispatched(this.#database.pool, {
        eventId: input.eventId,
        pgBossJobId: input.jobId,
        workerId: input.workerId,
      }))
    ) {
      throw new Error("claimed outbox event changed before dispatch was recorded");
    }
  }

  public async release(
    input:
      | { eventId: string; failureCode: string; outcome: "exhausted"; workerId: string }
      | {
          eventId: string;
          failureCode: string;
          outcome: "retry";
          retryAt: Date;
          workerId: string;
        },
  ): Promise<void> {
    if (!(await releaseOrExhaustOutboxLease(this.#database.pool, input))) {
      throw new Error("claimed outbox event changed before its lease was released");
    }
  }
}
