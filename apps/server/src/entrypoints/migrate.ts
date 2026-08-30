import { randomUUID } from "node:crypto";

import { loadMigrationConfig } from "@esmii/config/server";
import { createDatabaseClient, runMigrations } from "@esmii/database";
import { PgBoss, type ConstructorOptions } from "pg-boss";

import { expectedPgBossSchemaVersion } from "../jobs/constants.js";

export function pgBossMigrationOptions(connectionString: string): ConstructorOptions {
  return {
    application_name: "esmii-pgboss-migrate",
    connectionString,
    createSchema: true,
    max: 1,
    migrate: true,
    schedule: false,
    schema: "pgboss",
    supervise: false,
  };
}

async function migratePgBoss(connectionString: string): Promise<void> {
  const boss = new PgBoss(pgBossMigrationOptions(connectionString));
  try {
    await boss.start();
    const version = await boss.schemaVersion();
    if (version !== expectedPgBossSchemaVersion) {
      throw new Error("pg-boss schema did not reach the pinned version");
    }
    await boss.createQueue("action-link-dead", {
      deleteAfterSeconds: 604_800,
      expireInSeconds: 60,
      retentionSeconds: 1_209_600,
      retryLimit: 0,
    });
    await boss.createQueue("action-link-delivery", {
      deadLetter: "action-link-dead",
      deleteAfterSeconds: 604_800,
      expireInSeconds: 60,
      retentionSeconds: 1_209_600,
      retryBackoff: true,
      retryDelay: 10,
      retryDelayMax: 900,
      retryLimit: 5,
    });
  } finally {
    await boss.stop({ close: true, graceful: true, timeout: 5_000 });
  }

  const database = createDatabaseClient({
    applicationName: "esmii-pgboss-grants",
    connectionString,
    maximumConnections: 1,
    role: "migration",
  });
  try {
    await database.pool.query("REVOKE ALL ON SCHEMA pgboss FROM PUBLIC");
    await database.pool.query("GRANT USAGE ON SCHEMA pgboss TO app_worker");
    await database.pool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO app_worker",
    );
    await database.pool.query(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO app_worker",
    );
    await database.pool.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO app_worker");
    await database.pool.query("REVOKE ALL ON SCHEMA pgboss FROM app_api");
  } finally {
    await database.close();
  }
}

async function initializeCapturedTombstoneState(
  connectionString: string,
  environment: "development" | "test" | "staging",
): Promise<void> {
  const database = createDatabaseClient({
    applicationName: "esmii-captured-tombstone-state",
    connectionString,
    maximumConnections: 1,
    role: "migration",
  });
  try {
    await database.pool.query(
      `INSERT INTO app.security_tombstone_state (singleton, environment, epoch)
       VALUES (true, $1, $2)
       ON CONFLICT (singleton) DO NOTHING`,
      [environment, randomUUID()],
    );
    const state = await database.pool.query<{ environment: string }>(
      "SELECT environment FROM app.security_tombstone_state WHERE singleton",
    );
    if (state.rows[0]?.environment !== environment) {
      throw new Error("local tombstone state belongs to another environment");
    }
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  const configuration = await loadMigrationConfig();
  await runMigrations({
    connectionString: configuration.databaseUrl,
    ...(configuration.migrationsDirectory === undefined
      ? {}
      : { migrationsDirectory: configuration.migrationsDirectory }),
  });
  if (configuration.appEnvironment !== "production") {
    await initializeCapturedTombstoneState(configuration.databaseUrl, configuration.appEnvironment);
  }
  await migratePgBoss(configuration.databaseUrl);
  process.stdout.write("Database migrations completed.\n");
}

void main().catch(() => {
  process.stderr.write("Database migration failed; no credential or SQL detail was printed.\n");
  process.exitCode = 1;
});
