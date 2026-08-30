export type TombstoneOperation =
  | "account-disable"
  | "provider-unlink"
  | "membership-remove"
  | "membership-demote"
  | "ownership-change"
  | "organization-delete";

export type TombstoneScopeKind =
  "account" | "membership" | "organization" | "ownership" | "provider" | "user";
export type TombstonePhase = "prepared" | "committed" | "cancelled";

export interface TombstoneRecord {
  eventId: string;
  occurredAt: string;
  operation: TombstoneOperation;
  phase: TombstonePhase;
  scopeId: string;
  scopeKind: TombstoneScopeKind;
  sequence: number;
}

export interface TombstoneJournal {
  append(record: Omit<TombstoneRecord, "sequence">): Promise<TombstoneRecord>;
}

export type CaptureFault = "prepare" | "commit" | "cancel";

export class CapturedTombstoneJournal implements TombstoneJournal {
  readonly #faults: Set<CaptureFault>;
  readonly #records: TombstoneRecord[] = [];
  readonly #startingSequence: number;

  public constructor(faults: readonly CaptureFault[] = [], startingSequence = 0) {
    this.#faults = new Set(faults);
    if (!Number.isSafeInteger(startingSequence) || startingSequence < 0) {
      throw new TypeError("startingSequence must be a non-negative integer");
    }
    this.#startingSequence = startingSequence;
  }

  public get records(): readonly TombstoneRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  public async append(record: Omit<TombstoneRecord, "sequence">): Promise<TombstoneRecord> {
    const fault =
      record.phase === "prepared" ? "prepare" : record.phase === "committed" ? "commit" : "cancel";
    if (this.#faults.has(fault)) throw new Error(`Synthetic tombstone ${fault} failure`);
    const captured = {
      ...record,
      sequence: this.#startingSequence + this.#records.length + 1,
    };
    this.#records.push(captured);
    return { ...captured };
  }
}

export interface AccessReductionInput {
  eventId: string;
  now: Date;
  operation: TombstoneOperation;
  scopeId: string;
  scopeKind: TombstoneScopeKind;
}

export async function executeAccessReduction<T>(
  journal: TombstoneJournal,
  input: AccessReductionInput,
  mutate: () => Promise<T>,
): Promise<T> {
  const base = {
    eventId: input.eventId,
    occurredAt: input.now.toISOString(),
    operation: input.operation,
    scopeId: input.scopeId,
    scopeKind: input.scopeKind,
  } as const;
  await journal.append({ ...base, phase: "prepared" });
  let result: T;
  try {
    result = await mutate();
  } catch (error) {
    try {
      await journal.append({ ...base, phase: "cancelled" });
    } catch {
      // An unresolved prepare intentionally remains fail-closed during recovery.
    }
    throw error;
  }
  await journal.append({ ...base, phase: "committed" });
  return result;
}

export interface TombstoneReplayResult {
  failClosedAllTenants: boolean;
  failClosedScopes: readonly { scopeId: string; scopeKind: TombstoneScopeKind }[];
  highWatermark: number;
}

export function replayTombstones(
  records: readonly Readonly<TombstoneRecord>[],
  currentHighWatermark = 0,
): TombstoneReplayResult {
  const ordered = [...records]
    .filter((record) => record.sequence > currentHighWatermark)
    .sort((left, right) => left.sequence - right.sequence);
  const pending = new Map<string, TombstoneRecord>();
  const failed = new Map<string, { scopeId: string; scopeKind: TombstoneScopeKind }>();
  let expected = currentHighWatermark + 1;
  let highWatermark = currentHighWatermark;

  for (const record of ordered) {
    if (record.sequence !== expected) {
      return { failClosedAllTenants: true, failClosedScopes: [], highWatermark };
    }
    expected += 1;
    highWatermark = record.sequence;
    if (!record.scopeId || !record.scopeKind || !record.eventId) {
      return { failClosedAllTenants: true, failClosedScopes: [], highWatermark };
    }
    if (record.phase === "prepared") {
      if (pending.has(record.eventId)) {
        return { failClosedAllTenants: true, failClosedScopes: [], highWatermark };
      }
      pending.set(record.eventId, { ...record });
      continue;
    }
    const prepared = pending.get(record.eventId);
    if (
      prepared === undefined ||
      prepared.scopeId !== record.scopeId ||
      prepared.scopeKind !== record.scopeKind ||
      prepared.operation !== record.operation
    ) {
      return { failClosedAllTenants: true, failClosedScopes: [], highWatermark };
    }
    pending.delete(record.eventId);
  }

  for (const record of pending.values()) {
    failed.set(`${record.scopeKind}:${record.scopeId}`, {
      scopeId: record.scopeId,
      scopeKind: record.scopeKind,
    });
  }
  return {
    failClosedAllTenants: false,
    failClosedScopes: [...failed.values()],
    highWatermark,
  };
}
