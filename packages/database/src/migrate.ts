import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabaseClient } from "./client.js";

export interface RunMigrationsOptions {
  connectionString: string;
  migrationsDirectory?: string;
}

export function bundledMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const client = createDatabaseClient({
    applicationName: "esmii-migrate",
    connectionString: options.connectionString,
    maximumConnections: 1,
    role: "migration",
  });

  try {
    await migrate(client.db, {
      migrationsFolder: options.migrationsDirectory ?? bundledMigrationsDirectory(),
      migrationsSchema: "drizzle",
      migrationsTable: "schema_migrations",
    });
  } finally {
    await client.close();
  }
}
