import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export type TransactionIsolation = "read committed" | "repeatable read" | "serializable";

export async function withTransaction<Result>(
  pool: Pool,
  work: (transaction: PoolClient) => Promise<Result>,
  isolation: TransactionIsolation = "read committed",
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Serializes every owner, membership, invitation, and deletion write per org. */
export async function lockOrganization(
  transaction: SqlExecutor,
  organizationId: string,
): Promise<void> {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 50483))", [
    organizationId,
  ]);
  await transaction.query("SELECT id FROM app.organization WHERE id = $1 FOR UPDATE", [
    organizationId,
  ]);
}
