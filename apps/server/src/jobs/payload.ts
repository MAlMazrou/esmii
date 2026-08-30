import type { ActionLinkPurpose, AppEnvironment } from "@esmii/config";

export interface ActionLinkJobPayload {
  environment: AppEnvironment;
  eventId: string;
  intentId: string;
  purpose: ActionLinkPurpose;
}

export function parseActionLinkJobPayload(value: unknown): ActionLinkJobPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Action-link job payload is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "environment,eventId,intentId,purpose") {
    throw new TypeError("Action-link job payload contains prohibited fields");
  }
  if (
    (record.environment !== "development" &&
      record.environment !== "test" &&
      record.environment !== "staging" &&
      record.environment !== "production") ||
    (record.purpose !== "magic-link" && record.purpose !== "invitation") ||
    typeof record.intentId !== "string" ||
    record.intentId.length < 1 ||
    record.intentId.length > 160 ||
    typeof record.eventId !== "string" ||
    record.eventId.length < 1 ||
    record.eventId.length > 160
  ) {
    throw new TypeError("Action-link job payload is invalid");
  }
  return {
    environment: record.environment,
    eventId: record.eventId,
    intentId: record.intentId,
    purpose: record.purpose,
  };
}
