import { randomUUID } from "node:crypto";

import { loadWorkerConfig } from "@esmii/config/server";
import { createDatabaseClient } from "@esmii/database";
import { SmtpEmailTransport } from "@esmii/email";

import { ActionLinkWorker } from "../jobs/action-link-worker.js";
import {
  PostgresActionLinkDeliveryRepository,
  PostgresWorkerOutboxStore,
} from "../jobs/postgres-adapters.js";
import { OutboxDispatcher, PgBossActionLinkQueue } from "../jobs/pg-boss.js";
import { createWorkerAuthBoundary } from "../jobs/worker-auth.js";
import { createApplicationLogger } from "../observability/logger.js";
import { pingValkey } from "../runtime/valkey-probe.js";

async function main(): Promise<void> {
  const logger = createApplicationLogger();
  const configuration = await loadWorkerConfig();
  const database = createDatabaseClient({
    applicationName: "esmii-worker",
    connectionString: configuration.databaseUrl,
    onUnexpectedError() {
      logger.error(
        { event: "worker_database_pool_error" },
        "An unexpected database pool error occurred",
      );
    },
    role: "worker",
  });
  const email = new SmtpEmailTransport({
    defaultFrom: { address: "noreply@esmii.app", displayName: "Esmii" },
    smtpUrl: configuration.smtpUrl,
  });
  const queue = new PgBossActionLinkQueue(configuration.databaseUrl);

  try {
    await Promise.all([database.ping(), pingValkey(configuration.valkeyUrl)]);
    const workerAuth = createWorkerAuthBoundary({
      database,
      emailTransport: email,
      environment: configuration.appEnvironment,
      keyring: configuration.actionLinkKeyring,
      publicOrigin: configuration.publicOrigin,
    });
    const actionLinkWorker = new ActionLinkWorker({
      emailTransport: email,
      environment: configuration.appEnvironment,
      keyring: configuration.actionLinkKeyring,
      magicLinkIssuer: workerAuth.issuer,
      publicOrigin: configuration.publicOrigin,
      repository: new PostgresActionLinkDeliveryRepository(database, configuration.appEnvironment),
    });
    const dispatcher = new OutboxDispatcher({
      environment: configuration.appEnvironment,
      outbox: new PostgresWorkerOutboxStore(database),
      queue,
      workerId: `worker-${randomUUID()}`,
    });

    await queue.start(actionLinkWorker, configuration.jobConcurrency);
    let dispatchRunning = false;
    const dispatch = async (): Promise<void> => {
      if (dispatchRunning) return;
      dispatchRunning = true;
      try {
        const count = await dispatcher.dispatchOnce();
        if (count > 0) {
          logger.info({ count, event: "worker_outbox_dispatched" }, "Outbox events dispatched");
        }
      } catch {
        logger.error({ event: "worker_outbox_dispatch_failed" }, "Outbox dispatch failed");
      } finally {
        dispatchRunning = false;
      }
    };

    await dispatch();
    const dispatchTimer = setInterval(() => void dispatch(), 2_000);
    const heartbeat = setInterval(() => {
      logger.info({ event: "worker_heartbeat" }, "Worker heartbeat");
    }, configuration.heartbeatIntervalMs);

    logger.info({ event: "worker_ready" }, "Worker is consuming action-link jobs");
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    clearInterval(dispatchTimer);
    clearInterval(heartbeat);
  } catch {
    logger.error({ event: "worker_startup_failed" }, "Worker startup failed");
    process.exitCode = 1;
  } finally {
    await queue.stop().catch(() => undefined);
    await email.close();
    await database.close();
  }
  logger.info({ event: "worker_stopped" }, "Worker stopped");
}

void main().catch(() => {
  process.stderr.write("Worker startup failed; inspect configuration and dependency health.\n");
  process.exitCode = 1;
});
