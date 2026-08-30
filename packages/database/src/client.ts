import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg, { type Pool as PgPool } from "pg";

const { Pool } = pg;

export type DatabaseRuntimeRole = "api" | "worker" | "migration";

export const databaseSessionOptions = "-c search_path=app,public" as const;

export interface DatabaseClientOptions {
  applicationName?: string;
  connectionString: string;
  maximumConnections?: number;
  onUnexpectedError?: () => void;
  role: DatabaseRuntimeRole;
}

export interface DatabaseClient {
  readonly db: NodePgDatabase;
  readonly pool: PgPool;
  close(): Promise<void>;
  ping(): Promise<void>;
}

const rolePoolLimits: Readonly<Record<DatabaseRuntimeRole, number>> = {
  api: 5,
  worker: 2,
  migration: 1,
};

export function defaultPoolSizeForRole(role: DatabaseRuntimeRole): number {
  return rolePoolLimits[role];
}

export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const maximumConnections = options.maximumConnections ?? defaultPoolSizeForRole(options.role);

  if (!Number.isSafeInteger(maximumConnections) || maximumConnections < 1) {
    throw new TypeError("maximumConnections must be a positive integer");
  }

  if (maximumConnections > defaultPoolSizeForRole(options.role)) {
    throw new TypeError(`maximumConnections exceeds the ${options.role} role budget`);
  }

  const pool = new Pool({
    application_name: options.applicationName ?? `esmii-${options.role}`,
    connectionString: options.connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: maximumConnections,
    // Better Auth's direct pg adapter uses its stock unqualified table names.
    // Keep this explicit (rather than encoded in a URL) so every caller and
    // createAuth can fail closed on the same inspectable database contract.
    options: databaseSessionOptions,
  });
  const db = drizzle(pool);
  pool.on("error", () => {
    options.onUnexpectedError?.();
  });

  return {
    db,
    pool,
    async close(): Promise<void> {
      await pool.end();
    },
    async ping(): Promise<void> {
      await pool.query("SELECT 1");
    },
  };
}
