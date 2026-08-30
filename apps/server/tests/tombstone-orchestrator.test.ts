import { describe, expect, it, vi } from "vitest";

import { CapturedTombstoneJournal } from "../src/security/tombstones.js";
import { PostgresSecurityTombstoneOrchestrator } from "../src/services/tombstone-orchestrator.js";

function repositories() {
  let highWater = 0;
  const executor = { query: vi.fn() };
  return {
    advanceHighWater: vi.fn(async (_transaction, input: { next: number }) => {
      highWater = input.next;
      return true;
    }),
    markCancelled: vi.fn(async () => true),
    markCommitted: vi.fn(async () => true),
    readRecoveryState: vi.fn(async () => ({
      accessClosed: false,
      closureReason: null,
      contiguousHighWater: String(highWater),
      environment: "test",
      epoch: "epoch-synthetic",
      version: 1,
    })),
    recordPrepared: vi.fn(async () => undefined),
    transaction: vi.fn(async (_pool, work: (transaction: unknown) => Promise<unknown>) =>
      work(executor),
    ),
  };
}

const reduction = {
  eventId: "event-synthetic",
  operation: "organization-delete",
  organizationId: "organization-synthetic",
  scopeKind: "organization",
} as const;

describe("PostgresSecurityTombstoneOrchestrator", () => {
  it("reconciles prepared and committed journal records contiguously", async () => {
    const journal = new CapturedTombstoneJournal();
    const repository = repositories();
    const orchestrator = new PostgresSecurityTombstoneOrchestrator({
      environment: "test",
      journal,
      pool: {} as never,
      repositories: repository as never,
    });

    await expect(orchestrator.execute(reduction, async () => true)).resolves.toBe(true);
    expect(journal.records.map((record) => [record.sequence, record.phase])).toEqual([
      [1, "prepared"],
      [2, "committed"],
    ]);
    expect(repository.markCommitted).toHaveBeenCalledOnce();
  });

  it("latches fail-closed after a post-mutation commit-capture failure", async () => {
    const repository = repositories();
    const mutate = vi.fn(async () => true);
    const orchestrator = new PostgresSecurityTombstoneOrchestrator({
      environment: "test",
      journal: new CapturedTombstoneJournal(["commit"]),
      pool: {} as never,
      repositories: repository as never,
    });

    await expect(orchestrator.execute(reduction, mutate)).rejects.toThrow(
      "commit could not be captured",
    );
    await expect(orchestrator.execute(reduction, mutate)).rejects.toThrow("runtime is fail-closed");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("latches fail-closed when a failed mutation cannot capture cancellation", async () => {
    const repository = repositories();
    const mutate = vi.fn(async () => {
      throw new Error("synthetic local mutation failure");
    });
    const orchestrator = new PostgresSecurityTombstoneOrchestrator({
      environment: "test",
      journal: new CapturedTombstoneJournal(["cancel"]),
      pool: {} as never,
      repositories: repository as never,
    });

    await expect(orchestrator.execute(reduction, mutate)).rejects.toThrow(
      "cancellation could not be captured",
    );
    await expect(orchestrator.execute(reduction, mutate)).rejects.toThrow("runtime is fail-closed");
  });
});
