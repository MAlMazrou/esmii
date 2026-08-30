import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";

import { containsAsciiControlCharacter, validateCleanSameOriginCallback } from "./security.js";

export const MAGIC_LINK_PURPOSE = "magic-link-sign-in" as const;

export interface WorkerMagicLinkIssuance {
  readonly approvedCallbackPath: string;
  readonly expiresAt: Date;
  readonly intentId: string;
  readonly keyVersion: string;
  readonly normalizedEmail: string;
  readonly rawToken: string;
  readonly stableMessageId: string;
}

export interface WorkerMagicLinkTokenDerivation {
  readonly environmentId: string;
  readonly intentId: string;
  readonly key: Uint8Array;
  readonly keyVersion: string;
  readonly normalizedEmail: string;
}

const issuanceStorage = new AsyncLocalStorage<Readonly<WorkerMagicLinkIssuance>>();

function requireSafeIdentifier(value: string, name: string): void {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    containsAsciiControlCharacter(value)
  ) {
    throw new TypeError(`${name} must be a non-empty safe identifier`);
  }
}

export function canonicalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || !normalized.includes("@")) {
    throw new TypeError("email must be a valid canonical email value");
  }
  return normalized;
}

function encodeCanonicalPart(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function deriveWorkerMagicLinkToken(input: WorkerMagicLinkTokenDerivation): string {
  if (input.key.byteLength < 32) {
    throw new TypeError("magic-link derivation key must contain at least 256 bits");
  }
  requireSafeIdentifier(input.environmentId, "environmentId");
  requireSafeIdentifier(input.intentId, "intentId");
  requireSafeIdentifier(input.keyVersion, "keyVersion");
  const email = canonicalizeEmail(input.normalizedEmail);
  if (email !== input.normalizedEmail) {
    throw new TypeError("normalizedEmail must already be canonical");
  }

  const canonicalTuple = [
    "esmii-action-link-v1",
    input.environmentId,
    MAGIC_LINK_PURPOSE,
    input.keyVersion,
    input.intentId,
    email,
  ]
    .map(encodeCanonicalPart)
    .join("|");

  return createHmac("sha256", input.key).update(canonicalTuple, "utf8").digest("base64url");
}

export function hashActionToken(rawToken: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(rawToken)) {
    throw new TypeError("raw action token must be an unpadded 256-bit base64url value");
  }
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function validateIssuanceContext(
  issuance: WorkerMagicLinkIssuance,
  applicationOrigin: string,
): Readonly<WorkerMagicLinkIssuance> {
  requireSafeIdentifier(issuance.intentId, "intentId");
  requireSafeIdentifier(issuance.keyVersion, "keyVersion");
  requireSafeIdentifier(issuance.stableMessageId, "stableMessageId");
  hashActionToken(issuance.rawToken);

  const normalizedEmail = canonicalizeEmail(issuance.normalizedEmail);
  if (normalizedEmail !== issuance.normalizedEmail) {
    throw new TypeError("normalizedEmail must already be canonical");
  }
  if (!Number.isFinite(issuance.expiresAt.getTime())) {
    throw new TypeError("expiresAt must be a valid date");
  }

  const approvedCallbackPath = validateCleanSameOriginCallback(
    issuance.approvedCallbackPath,
    applicationOrigin,
  );

  return Object.freeze({
    approvedCallbackPath,
    expiresAt: new Date(issuance.expiresAt),
    intentId: issuance.intentId,
    keyVersion: issuance.keyVersion,
    normalizedEmail,
    rawToken: issuance.rawToken,
    stableMessageId: issuance.stableMessageId,
  });
}

export function runWithWorkerMagicLinkIssuance<T>(
  issuance: WorkerMagicLinkIssuance,
  applicationOrigin: string,
  operation: () => T,
): T {
  return issuanceStorage.run(validateIssuanceContext(issuance, applicationOrigin), operation);
}

export function requireWorkerMagicLinkIssuance(): Readonly<WorkerMagicLinkIssuance> {
  const issuance = issuanceStorage.getStore();
  if (issuance === undefined) {
    throw new Error("worker magic-link issuance context is required");
  }
  return issuance;
}
