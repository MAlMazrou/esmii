import type { AppEnvironment } from "@esmii/config";
import { PgBoss, type ConstructorOptions, type JobWithMetadata } from "pg-boss";

import type { ActionLinkWorker } from "./action-link-worker.js";
import { expectedPgBossSchemaVersion } from "./constants.js";
import { parseActionLinkJobPayload, type ActionLinkJobPayload } from "./payload.js";

export const actionLinkQueueName = "action-link-delivery";

export function pgBossWorkerOptions(connectionString: string): ConstructorOptions {
  return {
    application_name: "esmii-worker-pgboss",
    connectionString,
    createSchema: false,
    max: 1,
    migrate: false,
    schedule: false,
    schema: "pgboss",
    supervise: true,
  };
}

export interface ActionLinkQueue {
  send(payload: ActionLinkJobPayload): Promise<string>;
  start(handler: ActionLinkWorker, concurrency: number): Promise<void>;
  stop(): Promise<void>;
}

export class PgBossActionLinkQueue implements ActionLinkQueue {
  readonly #boss: PgBoss;

  public constructor(connectionString: string) {
    this.#boss = new PgBoss(pgBossWorkerOptions(connectionString));
  }

  public async send(payload: ActionLinkJobPayload): Promise<string> {
    const safePayload = parseActionLinkJobPayload(payload);
    const id = await this.#boss.send(actionLinkQueueName, safePayload, {
      id: safePayload.eventId,
      singletonKey: safePayload.eventId,
    });
    if (id === null) throw new Error("pg-boss rejected the action-link job");
    return id;
  }

  public async start(handler: ActionLinkWorker, concurrency: number): Promise<void> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new TypeError("worker concurrency must be between 1 and 32");
    }
    this.#boss.on("error", () => {
      // The application logger observes the runtime boundary; never serialize job data here.
    });
    await this.#boss.start();
    const version = await this.#boss.schemaVersion();
    if (version !== expectedPgBossSchemaVersion) {
      throw new Error("worker refused an unpinned pg-boss schema");
    }
    await this.#boss.work(
      actionLinkQueueName,
      {
        batchSize: 1,
        includeMetadata: true,
        localConcurrency: concurrency,
        pollingIntervalSeconds: 2,
      },
      async (jobs: JobWithMetadata<ActionLinkJobPayload>[]) => {
        for (const job of jobs) {
          await handler.handle(parseActionLinkJobPayload(job.data), job.retryCount + 1);
        }
      },
    );
  }

  public async stop(): Promise<void> {
    await this.#boss.stop({ close: true, graceful: true, timeout: 30_000 });
  }
}

export interface SafeOutboxEvent {
  eventId: string;
  eventType: "invitation.requested" | "magic_link.requested";
  payload: Readonly<Record<string, unknown>>;
}

export interface WorkerOutboxStore {
  claim(input: {
    limit: number;
    leaseSeconds: number;
    workerId: string;
  }): Promise<SafeOutboxEvent[]>;
  markDispatched(input: { eventId: string; jobId: string; workerId: string }): Promise<void>;
  release(
    input:
      | {
          eventId: string;
          failureCode: string;
          outcome: "exhausted";
          workerId: string;
        }
      | {
          eventId: string;
          failureCode: string;
          outcome: "retry";
          retryAt: Date;
          workerId: string;
        },
  ): Promise<void>;
}

export function actionLinkPayloadFromOutbox(
  event: SafeOutboxEvent,
  environment: AppEnvironment,
): ActionLinkJobPayload {
  const keys = Object.keys(event.payload).sort();
  if (keys.join(",") !== "intentId,purpose") {
    throw new TypeError("outbox action-link payload contains prohibited fields");
  }
  const intentId = event.payload.intentId;
  const persistedPurpose = event.payload.purpose;
  const expectedPurpose =
    event.eventType === "magic_link.requested" ? "magic_login" : "invitation_accept";
  if (
    typeof intentId !== "string" ||
    intentId.length < 1 ||
    intentId.length > 160 ||
    persistedPurpose !== expectedPurpose
  ) {
    throw new TypeError("outbox action-link payload is invalid");
  }
  return {
    environment,
    eventId: event.eventId,
    intentId,
    purpose: persistedPurpose === "magic_login" ? "magic-link" : "invitation",
  };
}

export class OutboxDispatcher {
  readonly #environment: AppEnvironment;
  readonly #outbox: WorkerOutboxStore;
  readonly #queue: ActionLinkQueue;
  readonly #workerId: string;
  readonly #clock: () => Date;

  public constructor(input: {
    environment: AppEnvironment;
    outbox: WorkerOutboxStore;
    queue: ActionLinkQueue;
    workerId: string;
    clock?: () => Date;
  }) {
    this.#environment = input.environment;
    this.#outbox = input.outbox;
    this.#queue = input.queue;
    this.#workerId = input.workerId;
    this.#clock = input.clock ?? (() => new Date());
  }

  public async dispatchOnce(): Promise<number> {
    const events = await this.#outbox.claim({
      limit: 20,
      leaseSeconds: 30,
      workerId: this.#workerId,
    });
    let dispatched = 0;
    for (const event of events) {
      try {
        const payload = actionLinkPayloadFromOutbox(event, this.#environment);
        const jobId = await this.#queue.send(payload);
        await this.#outbox.markDispatched({
          eventId: event.eventId,
          jobId,
          workerId: this.#workerId,
        });
        dispatched += 1;
      } catch (error) {
        const permanent = error instanceof TypeError;
        if (permanent) {
          await this.#outbox.release({
            eventId: event.eventId,
            failureCode: "INVALID_OUTBOX_EVENT",
            outcome: "exhausted",
            workerId: this.#workerId,
          });
        } else {
          await this.#outbox.release({
            eventId: event.eventId,
            failureCode: "QUEUE_TEMPORARILY_UNAVAILABLE",
            outcome: "retry",
            retryAt: new Date(this.#clock().getTime() + 10_000),
            workerId: this.#workerId,
          });
        }
      }
    }
    return dispatched;
  }
}
