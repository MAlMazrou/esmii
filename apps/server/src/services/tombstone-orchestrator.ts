import { createHash } from "node:crypto";

import type { AppEnvironment } from "@esmii/config";
import {
  advanceTombstoneHighWater,
  markTombstoneCancelled,
  markTombstoneCommitted,
  readTombstoneRecoveryState,
  recordPreparedTombstone,
  withTransaction,
  type DatabaseClient,
  type SqlExecutor,
} from "@esmii/database";

import type { AccessReductionRequest, SecurityTombstoneOrchestrator } from "./account-service.js";
import type { TombstoneJournal } from "../security/tombstones.js";

interface TombstoneRepositorySeam {
  advanceHighWater: typeof advanceTombstoneHighWater;
  markCancelled: typeof markTombstoneCancelled;
  markCommitted: typeof markTombstoneCommitted;
  readRecoveryState: typeof readTombstoneRecoveryState;
  recordPrepared: typeof recordPreparedTombstone;
  transaction: typeof withTransaction;
}

const postgresTombstoneRepositories: TombstoneRepositorySeam = {
  advanceHighWater: advanceTombstoneHighWater,
  markCancelled: markTombstoneCancelled,
  markCommitted: markTombstoneCommitted,
  readRecoveryState: readTombstoneRecoveryState,
  recordPrepared: recordPreparedTombstone,
  transaction: withTransaction,
};

function scopeId(request: AccessReductionRequest): string {
  const value =
    request.scopeKind === "organization"
      ? request.organizationId
      : request.scopeKind === "membership" || request.scopeKind === "ownership"
        ? request.membershipId
        : request.scopeKind === "provider" || request.scopeKind === "account"
          ? request.accountId
          : request.userId;
  if (value === undefined || !/^[A-Za-z0-9_-]{1,160}$/u.test(value)) {
    throw new TypeError("tombstone scope identity is missing or invalid");
  }
  return value;
}

function scopeDigest(request: AccessReductionRequest): string {
  return createHash("sha256")
    .update("esmii-tombstone-scope-v1\0", "utf8")
    .update(request.scopeKind, "utf8")
    .update("\0", "utf8")
    .update(scopeId(request), "utf8")
    .digest("hex");
}

export class PostgresSecurityTombstoneOrchestrator implements SecurityTombstoneOrchestrator {
  readonly #clock: () => Date;
  readonly #environment: AppEnvironment;
  readonly #journal: TombstoneJournal;
  readonly #pool: DatabaseClient["pool"];
  readonly #repositories: TombstoneRepositorySeam;
  #failedClosed = false;

  public constructor(input: {
    clock?: () => Date;
    environment: AppEnvironment;
    journal: TombstoneJournal;
    pool: DatabaseClient["pool"];
    repositories?: Partial<TombstoneRepositorySeam>;
  }) {
    this.#clock = input.clock ?? (() => new Date());
    this.#environment = input.environment;
    this.#journal = input.journal;
    this.#pool = input.pool;
    this.#repositories = { ...postgresTombstoneRepositories, ...input.repositories };
  }

  public async execute<Result>(
    request: Readonly<AccessReductionRequest>,
    mutate: (transaction: SqlExecutor) => Promise<Result>,
  ): Promise<Result> {
    if (this.#failedClosed) {
      throw new Error("tombstone runtime is fail-closed pending recovery");
    }
    const preparedAt = this.#clock();
    const identity = scopeId(request);
    const journalBase = {
      eventId: request.eventId,
      operation: request.operation,
      scopeId: identity,
      scopeKind: request.scopeKind,
    } as const;
    const prepared = await this.#journal.append({
      ...journalBase,
      occurredAt: preparedAt.toISOString(),
      phase: "prepared",
    });

    try {
      await this.#repositories.transaction(this.#pool, async (transaction) => {
        await this.#repositories.recordPrepared(transaction, {
          ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
          environment: this.#environment,
          eventId: request.eventId,
          ...(request.membershipId === undefined ? {} : { membershipId: request.membershipId }),
          operation: request.operation,
          ...(request.organizationId === undefined
            ? {}
            : { organizationId: request.organizationId }),
          prepareSequence: prepared.sequence,
          preparedAt,
          scopeDigest: scopeDigest(request),
          scopeKind: request.scopeKind,
          ...(request.userId === undefined ? {} : { userId: request.userId }),
        });
        await this.#advanceHighWater(transaction, prepared.sequence);
      });
    } catch (error) {
      this.#failedClosed = true;
      await this.#journal
        .append({
          ...journalBase,
          occurredAt: this.#clock().toISOString(),
          phase: "cancelled",
        })
        .catch(() => undefined);
      throw error;
    }

    let result: Result;
    try {
      result = await this.#repositories.transaction(this.#pool, mutate);
    } catch (error) {
      await this.#cancelOrFailClosed(journalBase, request.eventId, "LOCAL_MUTATION_FAILED");
      throw error;
    }

    if (result === false) {
      await this.#cancelOrFailClosed(journalBase, request.eventId, "NO_STATE_CHANGE");
      return result;
    }

    const resolvedAt = this.#clock();
    let committed;
    try {
      committed = await this.#journal.append({
        ...journalBase,
        occurredAt: resolvedAt.toISOString(),
        phase: "committed",
      });
    } catch {
      this.#failedClosed = true;
      throw new Error("tombstone commit could not be captured; access remains fail-closed");
    }
    let commitReconciled: boolean;
    try {
      commitReconciled = await this.#repositories.transaction(this.#pool, async (transaction) => {
        const marked = await this.#repositories.markCommitted(transaction, {
          eventId: request.eventId,
          resolutionSequence: committed.sequence,
          resolvedAt,
        });
        if (!marked) return false;
        await this.#advanceHighWater(transaction, committed.sequence);
        return true;
      });
    } catch {
      this.#failedClosed = true;
      throw new Error("tombstone commit could not be reconciled with local state");
    }
    if (!commitReconciled) {
      this.#failedClosed = true;
      throw new Error("tombstone commit could not be reconciled with local state");
    }
    return result;
  }

  async #cancelOrFailClosed(
    journalBase: {
      eventId: string;
      operation: AccessReductionRequest["operation"];
      scopeId: string;
      scopeKind: AccessReductionRequest["scopeKind"];
    },
    eventId: string,
    failureCode: string,
  ): Promise<void> {
    const resolvedAt = this.#clock();
    let cancelled;
    try {
      cancelled = await this.#journal.append({
        ...journalBase,
        occurredAt: resolvedAt.toISOString(),
        phase: "cancelled",
      });
    } catch {
      this.#failedClosed = true;
      throw new Error("tombstone cancellation could not be captured; access remains fail-closed");
    }
    let cancellationReconciled: boolean;
    try {
      cancellationReconciled = await this.#repositories.transaction(
        this.#pool,
        async (transaction) => {
          const marked = await this.#repositories.markCancelled(transaction, {
            eventId,
            failureCode,
            resolutionSequence: cancelled.sequence,
            resolvedAt,
          });
          if (!marked) return false;
          await this.#advanceHighWater(transaction, cancelled.sequence);
          return true;
        },
      );
    } catch {
      this.#failedClosed = true;
      throw new Error("tombstone cancellation could not be reconciled; access remains fail-closed");
    }
    if (!cancellationReconciled) {
      this.#failedClosed = true;
      throw new Error("tombstone cancellation could not be reconciled; access remains fail-closed");
    }
  }

  async #advanceHighWater(transaction: SqlExecutor, sequence: number): Promise<void> {
    const state = await this.#repositories.readRecoveryState(transaction);
    if (
      state === null ||
      state.accessClosed ||
      state.environment !== this.#environment ||
      !/^\d+$/u.test(state.contiguousHighWater)
    ) {
      throw new Error("tombstone recovery state is unavailable or fail-closed");
    }
    const current = Number(state.contiguousHighWater);
    if (!Number.isSafeInteger(current) || sequence !== current + 1) {
      throw new Error("tombstone journal sequence is not contiguous");
    }
    if (
      !(await this.#repositories.advanceHighWater(transaction, {
        environment: this.#environment,
        epoch: state.epoch,
        expectedCurrent: current,
        next: sequence,
      }))
    ) {
      throw new Error("tombstone journal high-water changed concurrently");
    }
  }
}
