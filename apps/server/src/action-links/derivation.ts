import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  ActionLinkKey,
  ActionLinkKeyring,
  ActionLinkPurpose,
  AppEnvironment,
} from "@esmii/config";
import { getActionLinkKey } from "@esmii/config";

export const MAGIC_LINK_LIFETIME_SECONDS = 10 * 60;
export const INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

export interface ActionLinkDerivationInput {
  canonicalEmail: string;
  environment: AppEnvironment;
  intentId: string;
  purpose: ActionLinkPurpose;
}

export interface DerivedActionLink {
  keyVersion: number;
  token: string;
  tokenHash: string;
}

function derivationPayload(input: ActionLinkDerivationInput, key: ActionLinkKey): string {
  return [
    "esmii-action-link",
    "v1",
    input.environment,
    input.purpose,
    String(key.version),
    input.intentId,
    input.canonicalEmail,
  ].join("\0");
}

/** Worker-only: callers must never persist the returned raw token. */
export function deriveActionLink(
  keyring: ActionLinkKeyring,
  input: ActionLinkDerivationInput,
  version?: number,
): DerivedActionLink {
  if (input.environment !== keyring.environment) {
    throw new Error("Action-link environment mismatch");
  }
  const key = getActionLinkKey(keyring, input.purpose, version);
  const tokenBytes = createHmac("sha256", key.key).update(derivationPayload(input, key)).digest();
  const token = tokenBytes.toString("base64url");
  return {
    keyVersion: key.version,
    token,
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
  };
}

export function hashActionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function actionTokenHashMatches(token: string, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashActionToken(token), "hex");
  return timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
}

export function stableMessageId(
  eventId: string,
  environment: AppEnvironment,
  messageIdDomain = "messages.invalid",
): string {
  const safeId = eventId.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  if (safeId.length < 1 || safeId.length > 160) throw new TypeError("eventId is invalid");
  if (!/^[A-Za-z0-9.-]{1,253}$/u.test(messageIdDomain)) {
    throw new TypeError("messageIdDomain is invalid");
  }
  return `<${safeId}.${environment}@${messageIdDomain}>`;
}
