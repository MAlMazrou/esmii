import { describe, expect, it } from "vitest";

import {
  actionLinkPayloadFromOutbox,
  OutboxDispatcher,
  pgBossWorkerOptions,
  type ActionLinkQueue,
  type SafeOutboxEvent,
  type WorkerOutboxStore,
} from "../src/jobs/pg-boss.js";

function event(overrides: Partial<SafeOutboxEvent> = {}): SafeOutboxEvent {
  return {
    eventId: "event-synthetic-1",
    eventType: "magic_link.requested",
    payload: { intentId: "intent-synthetic-1", purpose: "magic_login" },
    ...overrides,
  };
}

class CapturedOutbox implements WorkerOutboxStore {
  public claimed: SafeOutboxEvent[] = [];
  public dispatched: unknown[] = [];
  public released: unknown[] = [];

  public async claim(): Promise<SafeOutboxEvent[]> {
    return this.claimed.splice(0);
  }
  public async markDispatched(input: unknown): Promise<void> {
    this.dispatched.push(input);
  }
  public async release(input: never): Promise<void> {
    this.released.push(input);
  }
}

class CapturedQueue implements ActionLinkQueue {
  public fail = false;
  public sent: unknown[] = [];
  public async send(payload: never): Promise<string> {
    if (this.fail) throw new Error("synthetic queue outage");
    this.sent.push(payload);
    return "job-synthetic-1";
  }
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
}

describe("pg-boss worker boundary", () => {
  it("pins schema ownership and disables application-runtime migration", () => {
    expect(pgBossWorkerOptions("postgresql://worker:synthetic@postgres/esmii")).toMatchObject({
      createSchema: false,
      migrate: false,
      schema: "pgboss",
    });
  });

  it("accepts only the intent-only action-link payload", () => {
    expect(actionLinkPayloadFromOutbox(event(), "test")).toEqual({
      environment: "test",
      eventId: "event-synthetic-1",
      intentId: "intent-synthetic-1",
      purpose: "magic-link",
    });
    expect(() =>
      actionLinkPayloadFromOutbox(
        event({
          payload: { email: "must-not-queue@example.test", intentId: "x", purpose: "magic_login" },
        }),
        "test",
      ),
    ).toThrow("prohibited fields");
  });

  it("marks dispatch only after queue acceptance", async () => {
    const outbox = new CapturedOutbox();
    outbox.claimed.push(event());
    const queue = new CapturedQueue();
    const dispatcher = new OutboxDispatcher({
      environment: "test",
      outbox,
      queue,
      workerId: "worker-synthetic",
    });
    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);
    expect(queue.sent).toHaveLength(1);
    expect(outbox.dispatched).toEqual([
      {
        eventId: "event-synthetic-1",
        jobId: "job-synthetic-1",
        workerId: "worker-synthetic",
      },
    ]);
  });

  it("releases a transient queue failure with a bounded retry time", async () => {
    const outbox = new CapturedOutbox();
    outbox.claimed.push(event());
    const queue = new CapturedQueue();
    queue.fail = true;
    const dispatcher = new OutboxDispatcher({
      clock: () => new Date("2026-08-30T00:00:00.000Z"),
      environment: "test",
      outbox,
      queue,
      workerId: "worker-synthetic",
    });
    await expect(dispatcher.dispatchOnce()).resolves.toBe(0);
    expect(outbox.released).toEqual([
      {
        eventId: "event-synthetic-1",
        failureCode: "QUEUE_TEMPORARILY_UNAVAILABLE",
        outcome: "retry",
        retryAt: new Date("2026-08-30T00:00:10.000Z"),
        workerId: "worker-synthetic",
      },
    ]);
  });
});
