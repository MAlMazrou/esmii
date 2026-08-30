import type { ActionLinkKeyring, ActionLinkPurpose, AppEnvironment } from "@esmii/config";
import type { EmailTransport } from "@esmii/email";
import { renderInvitationEmail } from "@esmii/email";

import { deriveActionLink, stableMessageId } from "../action-links/derivation.js";
import { canonicalizeEmail } from "../domain/email.js";
import type { ActionLinkJobPayload } from "./payload.js";

export type DeliveryIntentStatus =
  "requested" | "issued" | "consumed" | "expired" | "superseded" | "cancelled";

export interface ActionLinkDeliveryIntent {
  callbackIdentifier: "invitation_accept_callback" | "magic_login_callback";
  dispatchNotAfter: Date;
  invitation?: {
    organizationName: string;
    role: "editor" | "member";
  };
  keyVersion: number | null;
  purpose: ActionLinkPurpose;
  recipientEmail: string;
  stableMessageId: string | null;
  status: DeliveryIntentStatus;
  tokenHash: string | null;
}

export interface DeliveryAttemptIdentity {
  attemptNumber: number;
  eventId: string;
  intentId: string;
  stableMessageId: string;
}

export interface ActionLinkDeliveryRepository {
  commitIssuedHash(input: {
    environment: AppEnvironment;
    expiresAt: Date;
    intentId: string;
    keyVersion: number;
    purpose: ActionLinkPurpose;
    stableMessageId: string;
    tokenHash: string;
  }): Promise<boolean>;
  getCurrentIntent(input: {
    environment: AppEnvironment;
    intentId: string;
    purpose: ActionLinkPurpose;
  }): Promise<ActionLinkDeliveryIntent | null>;
  recordAccepted(identity: DeliveryAttemptIdentity, providerReference?: string): Promise<void>;
  recordFailed(
    identity: DeliveryAttemptIdentity,
    failure: { code: string; kind: "permanent" | "retryable" },
  ): Promise<void>;
  recordSkipped(
    identity: Omit<DeliveryAttemptIdentity, "stableMessageId">,
    reason: "cancelled" | "consumed" | "expired" | "missing" | "superseded",
  ): Promise<void>;
  recordStarted(identity: DeliveryAttemptIdentity): Promise<void>;
}

export interface MagicLinkIssuer {
  issue(input: {
    approvedCallbackPath: "/app";
    canonicalEmail: string;
    expiresAt: Date;
    intentId: string;
    keyVersion: number;
    messageId: string;
    rawToken: string;
  }): Promise<{ providerReference?: string }>;
}

export type WorkerCrashPoint = "before-hash-commit" | "after-hash-commit" | "after-smtp-acceptance";

export interface ActionLinkWorkerOptions {
  crashAt?: WorkerCrashPoint;
  emailTransport: EmailTransport;
  environment: AppEnvironment;
  keyring: ActionLinkKeyring;
  magicLinkIssuer: MagicLinkIssuer;
  publicOrigin: string;
  repository: ActionLinkDeliveryRepository;
}

export interface ActionLinkWorkerResult {
  outcome: "accepted" | "skipped";
  reason?: string;
}

function skipReason(status: DeliveryIntentStatus) {
  if (status === "consumed") return "consumed" as const;
  if (status === "superseded") return "superseded" as const;
  if (status === "expired") return "expired" as const;
  return "cancelled" as const;
}

function transientActionUrl(
  publicOrigin: string,
  payload: ActionLinkJobPayload,
  rawToken: string,
): URL {
  const path =
    payload.purpose === "magic-link" ? "/api/auth/magic-link/verify" : "/api/invitation/exchange";
  const url = new URL(path, publicOrigin);
  url.searchParams.set("intent", payload.intentId);
  url.searchParams.set("token", rawToken);
  return url;
}

function stableFailureCode(error: unknown): string {
  if (error instanceof TypeError) return "INVALID_DELIVERY_INPUT";
  return "DELIVERY_TEMPORARILY_UNAVAILABLE";
}

export class ActionLinkWorker {
  readonly #options: ActionLinkWorkerOptions;

  public constructor(options: ActionLinkWorkerOptions) {
    if (options.environment !== options.keyring.environment) {
      throw new TypeError("worker and action-link keyring environments must match");
    }
    this.#options = options;
  }

  public async handle(
    payload: ActionLinkJobPayload,
    attemptNumber: number,
  ): Promise<ActionLinkWorkerResult> {
    if (payload.environment !== this.#options.environment) {
      throw new TypeError("cross-environment action-link job rejected");
    }
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
      throw new TypeError("attemptNumber must be a positive integer");
    }
    let intent = await this.#options.repository.getCurrentIntent(payload);
    const attemptBase = { attemptNumber, eventId: payload.eventId, intentId: payload.intentId };
    if (intent === null) {
      await this.#options.repository.recordSkipped(attemptBase, "missing");
      return { outcome: "skipped", reason: "missing" };
    }
    if (intent.purpose !== payload.purpose)
      throw new TypeError("cross-purpose action-link job rejected");
    if (intent.status !== "requested" && intent.status !== "issued") {
      const reason = skipReason(intent.status);
      await this.#options.repository.recordSkipped(attemptBase, reason);
      return { outcome: "skipped", reason };
    }
    if (intent.dispatchNotAfter.getTime() <= Date.now()) {
      await this.#options.repository.recordSkipped(attemptBase, "expired");
      return { outcome: "skipped", reason: "expired" };
    }

    const canonicalEmail = canonicalizeEmail(intent.recipientEmail);
    if (this.#options.crashAt === "before-hash-commit" && intent.status === "requested") {
      throw new Error("Synthetic crash before hash commit");
    }
    let derived = deriveActionLink(
      this.#options.keyring,
      {
        canonicalEmail,
        environment: this.#options.environment,
        intentId: payload.intentId,
        purpose: payload.purpose,
      },
      intent.keyVersion ?? undefined,
    );
    const messageId =
      intent.stableMessageId ?? stableMessageId(payload.eventId, payload.environment);
    if (intent.status === "requested") {
      const committed = await this.#options.repository.commitIssuedHash({
        environment: this.#options.environment,
        expiresAt: intent.dispatchNotAfter,
        intentId: payload.intentId,
        keyVersion: derived.keyVersion,
        purpose: payload.purpose,
        stableMessageId: messageId,
        tokenHash: derived.tokenHash,
      });
      if (!committed) {
        await this.#options.repository.recordSkipped(attemptBase, "superseded");
        return { outcome: "skipped", reason: "superseded" };
      }
      if (this.#options.crashAt === "after-hash-commit") {
        throw new Error("Synthetic crash after hash commit");
      }
      intent = await this.#options.repository.getCurrentIntent(payload);
      if (intent === null || intent.status !== "issued") {
        throw new Error("issued action-link intent could not be reloaded");
      }
    } else {
      if (intent.keyVersion === null || intent.tokenHash === null) {
        throw new TypeError("issued intent is missing hash metadata");
      }
      derived = deriveActionLink(
        this.#options.keyring,
        {
          canonicalEmail,
          environment: this.#options.environment,
          intentId: payload.intentId,
          purpose: payload.purpose,
        },
        intent.keyVersion,
      );
    }
    if (intent.tokenHash !== derived.tokenHash || intent.stableMessageId !== messageId) {
      throw new TypeError("issued intent does not match deterministic derivation");
    }

    const identity = { ...attemptBase, stableMessageId: messageId };
    await this.#options.repository.recordStarted(identity);
    try {
      let providerReference: string | undefined;
      if (payload.purpose === "magic-link") {
        const receipt = await this.#options.magicLinkIssuer.issue({
          approvedCallbackPath: "/app",
          canonicalEmail,
          expiresAt: new Date(intent.dispatchNotAfter),
          intentId: payload.intentId,
          keyVersion: derived.keyVersion,
          messageId,
          rawToken: derived.token,
        });
        providerReference = receipt.providerReference;
      } else {
        if (intent.invitation === undefined) {
          throw new TypeError("invitation delivery context is missing");
        }
        const template = renderInvitationEmail({
          actionUrl: transientActionUrl(this.#options.publicOrigin, payload, derived.token),
          organizationName: intent.invitation.organizationName,
          role: intent.invitation.role,
        });
        const receipt = await this.#options.emailTransport.send({
          html: template.html,
          messageId,
          subject: template.subject,
          text: template.text,
          to: { address: canonicalEmail },
        });
        providerReference = receipt.transportReference;
      }
      if (this.#options.crashAt === "after-smtp-acceptance") {
        throw new Error("Synthetic crash after SMTP acceptance");
      }
      await this.#options.repository.recordAccepted(identity, providerReference);
      return { outcome: "accepted" };
    } catch (error) {
      const permanent = error instanceof TypeError;
      await this.#options.repository.recordFailed(identity, {
        code: stableFailureCode(error),
        kind: permanent ? "permanent" : "retryable",
      });
      if (!permanent) throw error;
      return { outcome: "skipped", reason: "permanent-failure" };
    }
  }
}
