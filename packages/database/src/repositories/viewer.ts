import type { Pool, QueryResultRow } from "pg";

import type { OrganizationRole } from "../authorization.js";
import { isOrganizationRole, requireActiveOrganizationCapability } from "../authorization.js";
import type { SqlExecutor } from "../transactions.js";
import { lockOrganization, withTransaction } from "../transactions.js";
import type { AuditEventInput } from "./audit.js";
import { insertAuditEvent } from "./audit.js";

interface ViewerRow extends QueryResultRow {
  active_organization_id: string | null;
  email: string;
  email_verified: boolean;
  id: string;
  image: string | null;
  memberships: Array<{
    createdAt: string;
    membershipId: string;
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    role: string;
  }>;
  name: string;
}

export interface ViewerMembership {
  createdAt: Date;
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: OrganizationRole;
}

export interface ViewerContext {
  activeOrganizationId: string | null;
  email: string;
  emailVerified: boolean;
  id: string;
  image: string | null;
  memberships: ViewerMembership[];
  name: string;
}

/** Resolves the viewer only from a current server-side session and durable memberships. */
export async function getViewerContext(
  executor: SqlExecutor,
  input: { sessionId: string; userId: string },
): Promise<ViewerContext | null> {
  const result = await executor.query<ViewerRow>(
    `SELECT
       authenticated_user.id,
       authenticated_user.name,
       authenticated_user.email,
       authenticated_user."emailVerified" AS email_verified,
       authenticated_user.image,
       CASE WHEN EXISTS (
         SELECT 1
           FROM app.member AS active_member
           INNER JOIN app.organization AS active_organization
             ON active_organization.id = active_member."organizationId"
            AND active_organization."deletedAt" IS NULL
          WHERE active_member."organizationId" = session."activeOrganizationId"
            AND active_member."userId" = authenticated_user.id
            AND active_member.status = 'active'
       ) THEN session."activeOrganizationId" ELSE NULL END AS active_organization_id,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'membershipId', member.id,
             'organizationId', organization.id,
             'organizationName', organization.name,
             'organizationSlug', organization.slug,
             'role', member.role,
             'createdAt', member."createdAt"
           ) ORDER BY organization.name, organization.id
         ) FILTER (WHERE member.id IS NOT NULL),
         '[]'::jsonb
       ) AS memberships
     FROM app."session" AS session
     INNER JOIN app."user" AS authenticated_user
       ON authenticated_user.id = session."userId"
      AND authenticated_user.status = 'active'
     LEFT JOIN app.member
       ON member."userId" = authenticated_user.id
      AND member.status = 'active'
     LEFT JOIN app.organization
       ON organization.id = member."organizationId"
      AND organization."deletedAt" IS NULL
     WHERE session.id = $1
       AND session."userId" = $2
       AND session."expiresAt" > statement_timestamp()
     GROUP BY authenticated_user.id, session."activeOrganizationId"`,
    [input.sessionId, input.userId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;

  const memberships = row.memberships.flatMap((membership): ViewerMembership[] => {
    if (!isOrganizationRole(membership.role)) return [];
    return [
      {
        createdAt: new Date(membership.createdAt),
        membershipId: membership.membershipId,
        organizationId: membership.organizationId,
        organizationName: membership.organizationName,
        organizationSlug: membership.organizationSlug,
        role: membership.role,
      },
    ];
  });
  return {
    activeOrganizationId: row.active_organization_id,
    email: row.email,
    emailVerified: row.email_verified,
    id: row.id,
    image: row.image,
    memberships,
    name: row.name,
  };
}

interface OrganizationSummaryRow extends QueryResultRow {
  created_at: Date;
  id: string;
  logo: string | null;
  name: string;
  role: string;
  slug: string;
  updated_at: Date | null;
  version: number;
}

export interface ActiveOrganizationSummary {
  createdAt: Date;
  id: string;
  logo: string | null;
  name: string;
  role: OrganizationRole;
  slug: string;
  updatedAt: Date | null;
  version: number;
}

export async function getActiveOrganizationSummary(
  executor: SqlExecutor,
  input: { sessionId: string; userId: string },
): Promise<ActiveOrganizationSummary | null> {
  const result = await executor.query<OrganizationSummaryRow>(
    `SELECT
       organization.id,
       organization.name,
       organization.slug,
       organization.logo,
       organization."createdAt" AS created_at,
       organization."updatedAt" AS updated_at,
       organization.version,
       member.role
     FROM app."session" AS session
     INNER JOIN app.organization
       ON organization.id = session."activeOrganizationId"
      AND organization."deletedAt" IS NULL
     INNER JOIN app.member
       ON member."organizationId" = organization.id
      AND member."userId" = session."userId"
      AND member.status = 'active'
     WHERE session.id = $1
       AND session."userId" = $2
       AND session."expiresAt" > statement_timestamp()`,
    [input.sessionId, input.userId],
  );
  const row = result.rows[0];
  if (row === undefined || !isOrganizationRole(row.role)) return null;
  return {
    createdAt: row.created_at,
    id: row.id,
    logo: row.logo,
    name: row.name,
    role: row.role,
    slug: row.slug,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

interface MemberListRow extends QueryResultRow {
  created_at: Date;
  display_name: string;
  email: string;
  email_verified: boolean;
  is_current_user: boolean;
  membership_id: string;
  role: string;
  user_id: string;
}

export interface ActiveOrganizationMember {
  createdAt: Date;
  displayName: string;
  email: string;
  emailVerified: boolean;
  isCurrentUser: boolean;
  membershipId: string;
  role: OrganizationRole;
  userId: string;
}

export async function listActiveOrganizationMembers(
  executor: SqlExecutor,
  input: { afterMemberId?: string; limit: number; sessionId: string; userId: string },
): Promise<ActiveOrganizationMember[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new TypeError("member list limit must be between 1 and 100");
  }
  const result = await executor.query<MemberListRow>(
    `WITH authorized AS (
       SELECT requesting_member."organizationId" AS organization_id
         FROM app."session" AS requesting_session
         INNER JOIN app.organization
           ON organization.id = requesting_session."activeOrganizationId"
          AND organization."deletedAt" IS NULL
         INNER JOIN app.member AS requesting_member
           ON requesting_member."organizationId" = organization.id
          AND requesting_member."userId" = requesting_session."userId"
          AND requesting_member.status = 'active'
          AND requesting_member.role IN ('owner', 'editor')
        WHERE requesting_session.id = $1
          AND requesting_session."userId" = $2
          AND requesting_session."expiresAt" > statement_timestamp()
     )
     SELECT
       member.id AS membership_id,
       member."userId" AS user_id,
       member.role,
       member."createdAt" AS created_at,
       member."userId" = $2 AS is_current_user,
       member_user.name AS display_name,
       member_user.email,
       member_user."emailVerified" AS email_verified
     FROM authorized
     INNER JOIN app.member ON member."organizationId" = authorized.organization_id
     INNER JOIN app."user" AS member_user ON member_user.id = member."userId"
     WHERE member.status = 'active'
       AND ($3::text IS NULL OR member.id > $3)
     ORDER BY member.id
     LIMIT $4`,
    [input.sessionId, input.userId, input.afterMemberId ?? null, input.limit],
  );
  return result.rows.flatMap((row): ActiveOrganizationMember[] => {
    if (!isOrganizationRole(row.role)) return [];
    return [
      {
        createdAt: row.created_at,
        displayName: row.display_name,
        email: row.email,
        emailVerified: row.email_verified,
        isCurrentUser: row.is_current_user,
        membershipId: row.membership_id,
        role: row.role,
        userId: row.user_id,
      },
    ];
  });
}

export function normalizeDisplayName(value: string): string {
  const normalized = value.normalize("NFC").trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (normalized.length < 1 || normalized.length > 120 || hasControlCharacter) {
    throw new TypeError("display name must contain 1 to 120 printable characters");
  }
  return normalized;
}

export async function updateOwnDisplayName(
  executor: SqlExecutor,
  input: { name: string; sessionId: string; userId: string },
): Promise<boolean> {
  const name = normalizeDisplayName(input.name);
  const result = await executor.query(
    `UPDATE app."user" AS target_user
        SET name = $2,
            "updatedAt" = statement_timestamp()
      WHERE target_user.id = $1
        AND target_user.status = 'active'
        AND EXISTS (
          SELECT 1
            FROM app."session" AS current_session
           WHERE current_session.id = $3
             AND current_session."userId" = target_user.id
             AND current_session."expiresAt" > statement_timestamp()
        )`,
    [input.userId, name, input.sessionId],
  );
  return result.rowCount === 1;
}

export async function updateActiveOrganizationDisplayName(
  pool: Pool,
  input: { audit: AuditEventInput; name: string; sessionId: string; userId: string },
): Promise<boolean> {
  const name = normalizeDisplayName(input.name);
  return withTransaction(pool, async (transaction) => {
    const initialScope = await requireActiveOrganizationCapability(transaction, {
      capability: "organization:update",
      sessionId: input.sessionId,
      userId: input.userId,
    });
    await lockOrganization(transaction, initialScope.organizationId);
    const currentScope = await requireActiveOrganizationCapability(transaction, {
      capability: "organization:update",
      expectedOrganizationId: initialScope.organizationId,
      sessionId: input.sessionId,
      userId: input.userId,
    });
    const changed = await transaction.query(
      `UPDATE app.organization
          SET name = $2,
              "updatedAt" = statement_timestamp(),
              version = version + 1
        WHERE id = $1 AND "deletedAt" IS NULL AND name IS DISTINCT FROM $2`,
      [currentScope.organizationId, name],
    );
    if (changed.rowCount !== 1) return false;
    await insertAuditEvent(transaction, {
      ...input.audit,
      action: "organization.updated",
      actorUserId: input.userId,
      organizationId: currentScope.organizationId,
      targetId: currentScope.organizationId,
      targetType: "organization",
    });
    return true;
  });
}
