import { createHmac } from "node:crypto";

import type { AppEnvironment } from "@esmii/config";
import { canonicalizeEmail } from "@esmii/database";
import { createClient } from "redis";

const consumeScript = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local remaining = redis.call("PTTL", KEYS[1])
return { current, remaining }
`;

export type AbuseRateLimitBucket =
  | "invitation-actor"
  | "invitation-recipient"
  | "invitation-resend"
  | "magic-email"
  | "magic-network";

export interface AbuseRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AbuseRateLimitStore {
  close(): Promise<void>;
  increment(input: {
    key: string;
    windowMilliseconds: number;
  }): Promise<{ count: number; remainingMilliseconds: number }>;
}

export interface AbuseRateLimiter {
  consume(input: {
    bucket: AbuseRateLimitBucket;
    limit: number;
    subject: string;
    windowSeconds: number;
  }): Promise<AbuseRateLimitDecision>;
}

export class ValkeyAbuseRateLimitStore implements AbuseRateLimitStore {
  readonly #client: ReturnType<typeof createClient>;
  readonly #connected: Promise<void>;

  public constructor(url: string) {
    this.#client = createClient({
      disableOfflineQueue: true,
      socket: { connectTimeout: 3_000, reconnectStrategy: false },
      url,
    });
    this.#client.on("error", () => undefined);
    this.#connected = this.#client.connect().then(() => undefined);
    void this.#connected.catch(() => undefined);
  }

  public async close(): Promise<void> {
    await this.#connected.catch(() => undefined);
    if (this.#client.isOpen) await this.#client.quit();
  }

  public async increment(input: {
    key: string;
    windowMilliseconds: number;
  }): Promise<{ count: number; remainingMilliseconds: number }> {
    await this.#connected;
    const result = await this.#client.eval(consumeScript, {
      arguments: [String(input.windowMilliseconds)],
      keys: [input.key],
    });
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      typeof result[0] !== "number" ||
      typeof result[1] !== "number"
    ) {
      throw new Error("Valkey returned an invalid rate-limit result");
    }
    return {
      count: result[0],
      remainingMilliseconds: Math.max(0, result[1]),
    };
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

export class HashedAbuseRateLimiter implements AbuseRateLimiter {
  readonly #environment: AppEnvironment;
  readonly #key: Uint8Array;
  readonly #store: AbuseRateLimitStore;

  public constructor(input: {
    environment: AppEnvironment;
    key: Uint8Array;
    store: AbuseRateLimitStore;
  }) {
    if (input.key.byteLength < 32) {
      throw new TypeError("rate-limit derivation key must contain at least 256 bits");
    }
    this.#environment = input.environment;
    this.#key = new Uint8Array(input.key);
    this.#store = input.store;
  }

  public async consume(input: {
    bucket: AbuseRateLimitBucket;
    limit: number;
    subject: string;
    windowSeconds: number;
  }): Promise<AbuseRateLimitDecision> {
    requirePositiveInteger(input.limit, "limit");
    requirePositiveInteger(input.windowSeconds, "windowSeconds");
    if (input.subject.length === 0 || input.subject.length > 1_024) {
      throw new TypeError("rate-limit subject is invalid");
    }
    const digest = createHmac("sha256", this.#key)
      .update("esmii-abuse-rate-limit-v1\0", "utf8")
      .update(this.#environment, "utf8")
      .update("\0", "utf8")
      .update(input.bucket, "utf8")
      .update("\0", "utf8")
      .update(input.subject, "utf8")
      .digest("base64url");
    const result = await this.#store.increment({
      key: `esmii:api:${this.#environment}:rate:${input.bucket}:${digest}`,
      windowMilliseconds: input.windowSeconds * 1_000,
    });
    return {
      allowed: result.count <= input.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(result.remainingMilliseconds / 1_000)),
    };
  }
}

export function canonicalRateLimitEmail(value: string): string | null {
  try {
    return canonicalizeEmail(value);
  } catch {
    return null;
  }
}
