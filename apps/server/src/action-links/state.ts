import type { ActionLinkPurpose, AppEnvironment } from "@esmii/config";

export type ActionLinkIntentState =
  "pending" | "hash-committed" | "accepted" | "consumed" | "superseded" | "expired" | "exhausted";

export interface ActionLinkIntentSnapshot {
  canonicalEmail: string;
  consumedAt: Date | null;
  environment: AppEnvironment;
  expiresAt: Date;
  id: string;
  keyVersion: number;
  purpose: ActionLinkPurpose;
  state: ActionLinkIntentState;
  supersededAt: Date | null;
  tokenHash: string | null;
}

export type DeliveryDecision =
  | { kind: "derive-and-commit" }
  | { kind: "send-committed"; tokenHash: string }
  | { kind: "skip"; reason: "consumed" | "expired" | "superseded" | "exhausted" };

export function decideActionLinkDelivery(
  intent: Readonly<ActionLinkIntentSnapshot>,
  now: Date,
): DeliveryDecision {
  if (intent.consumedAt !== null || intent.state === "consumed")
    return { kind: "skip", reason: "consumed" };
  if (intent.supersededAt !== null || intent.state === "superseded") {
    return { kind: "skip", reason: "superseded" };
  }
  if (intent.expiresAt.getTime() <= now.getTime() || intent.state === "expired") {
    return { kind: "skip", reason: "expired" };
  }
  if (intent.state === "exhausted") return { kind: "skip", reason: "exhausted" };
  if (intent.tokenHash === null) return { kind: "derive-and-commit" };
  return { kind: "send-committed", tokenHash: intent.tokenHash };
}

export function expiresAtForPurpose(purpose: ActionLinkPurpose, issuedAt: Date): Date {
  const seconds = purpose === "magic-link" ? 10 * 60 : 7 * 24 * 60 * 60;
  return new Date(issuedAt.getTime() + seconds * 1000);
}
