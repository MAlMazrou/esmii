import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { setActiveOrganization } from "../src/repositories/sessions.js";
import type { SqlExecutor } from "../src/transactions.js";

function result<Row extends QueryResultRow>(
  rows: Row[] = [],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: "", fields: [], oid: 0, rowCount, rows };
}

describe("active organization switching", () => {
  it("uses the organization-before-session lock order and verifies current membership", async () => {
    const statements: string[] = [];
    const responses: QueryResult[] = [
      result(),
      result([{ id: "synthetic-organization" }]),
      result([{ id: "synthetic-session" }]),
      result([{ id: "synthetic-membership" }]),
      result([], 1),
    ];
    const executor = {
      async query(text: string) {
        statements.push(text);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected query");
        return response;
      },
    } as SqlExecutor;

    await expect(
      setActiveOrganization(executor, {
        organizationId: "synthetic-organization",
        sessionId: "synthetic-session",
        userId: "synthetic-user",
      }),
    ).resolves.toBe(true);

    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(statements[1]).toContain("FROM app.organization");
    expect(statements[2]).toContain('FROM app."session"');
    expect(statements[3]).toContain("FROM app.member");
    expect(statements[4]).toContain('UPDATE app."session"');
    expect(responses).toEqual([]);
  });
});
