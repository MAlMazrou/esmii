import type { QueryResultRow } from "pg";

import type { SqlExecutor } from "../transactions.js";

export type AuditResult = "denied" | "failed" | "success";

export interface AuditEventInput {
  action: string;
  actorUserId: string | null;
  correlationId: string;
  eventId: string;
  metadata?: Readonly<Record<string, unknown>>;
  organizationId: string | null;
  requestId: string;
  result: AuditResult;
  targetId: string;
  targetType: string;
}

export async function insertAuditEvent(
  executor: SqlExecutor,
  input: AuditEventInput,
): Promise<void> {
  await executor.query(
    `INSERT INTO app.audit_events (
       event_id,
       actor_user_id,
       organization_id,
       action,
       target_type,
       target_id,
       result,
       request_id,
       correlation_id,
       metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      input.eventId,
      input.actorUserId,
      input.organizationId,
      input.action,
      input.targetType,
      input.targetId,
      input.result,
      input.requestId,
      input.correlationId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

interface AuditRow extends QueryResultRow {
  action: string;
  actor_user_id: string | null;
  correlation_id: string;
  event_id: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  organization_id: string;
  request_id: string;
  result: AuditResult;
  sequence: string;
  target_id: string;
  target_type: string;
}

export interface SafeAuditEvent {
  action: string;
  actorUserId: string | null;
  correlationId: string;
  eventId: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  organizationId: string;
  requestId: string;
  result: AuditResult;
  sequence: string;
  targetId: string;
  targetType: string;
}

export async function listOrganizationAuditEvents(
  executor: SqlExecutor,
  input: {
    afterSequence?: string;
    limit: number;
    organizationId: string;
    requestingUserId: string;
  },
): Promise<SafeAuditEvent[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new TypeError("audit list limit must be between 1 and 100");
  }

  const result = await executor.query<AuditRow>(
    `SELECT
       audit.sequence::text,
       audit.event_id,
       audit.occurred_at,
       audit.actor_user_id,
       audit.organization_id,
       audit.action,
       audit.target_type,
       audit.target_id,
       audit.result,
       audit.request_id,
       audit.correlation_id,
       audit.metadata
     FROM app.audit_events AS audit
     WHERE audit.organization_id = $1
       AND ($2::bigint IS NULL OR audit.sequence < $2::bigint)
       AND EXISTS (
         SELECT 1
           FROM app.member
           INNER JOIN app.organization
             ON organization.id = member."organizationId"
            AND organization."deletedAt" IS NULL
          WHERE member."organizationId" = audit.organization_id
            AND member."userId" = $3
            AND member.status = 'active'
            AND member.role IN ('owner', 'editor')
       )
     ORDER BY audit.sequence DESC
     LIMIT $4`,
    [input.organizationId, input.afterSequence ?? null, input.requestingUserId, input.limit],
  );

  return result.rows.map((row) => ({
    action: row.action,
    actorUserId: row.actor_user_id,
    correlationId: row.correlation_id,
    eventId: row.event_id,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
    organizationId: row.organization_id,
    requestId: row.request_id,
    result: row.result,
    sequence: row.sequence,
    targetId: row.target_id,
    targetType: row.target_type,
  }));
}
