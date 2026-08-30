import type { QueryResultRow } from "pg";

import type { SqlExecutor } from "./transactions.js";

export const organizationRoles = ["owner", "editor", "member"] as const;
export type OrganizationRole = (typeof organizationRoles)[number];

export const organizationCapabilities = [
  "organization:view",
  "members:list",
  "profile:update-own",
  "organization:update",
  "invitations:manage",
  "members:manage-non-owner",
  "members:change-role",
  "ownership:manage",
  "organization:delete",
] as const;
export type OrganizationCapability = (typeof organizationCapabilities)[number];

const capabilityRoles: Readonly<Record<OrganizationCapability, ReadonlySet<OrganizationRole>>> = {
  "organization:view": new Set(organizationRoles),
  "members:list": new Set(["owner", "editor"]),
  "profile:update-own": new Set(organizationRoles),
  "organization:update": new Set(["owner"]),
  "invitations:manage": new Set(["owner", "editor"]),
  "members:manage-non-owner": new Set(["owner"]),
  "members:change-role": new Set(["owner"]),
  "ownership:manage": new Set(["owner"]),
  "organization:delete": new Set(["owner"]),
};

export function isOrganizationRole(value: string): value is OrganizationRole {
  return organizationRoles.some((role) => role === value);
}

export function roleHasCapability(
  role: OrganizationRole,
  capability: OrganizationCapability,
): boolean {
  return capabilityRoles[capability].has(role);
}

export class AuthorizationDeniedError extends Error {
  public constructor() {
    super("organization access denied");
    this.name = "AuthorizationDeniedError";
  }
}

interface ActiveScopeRow extends QueryResultRow {
  membership_id: string;
  organization_id: string;
  organization_version: number;
  role: string;
}

export interface ActiveOrganizationScope {
  membershipId: string;
  organizationId: string;
  organizationVersion: number;
  role: OrganizationRole;
}

/**
 * Resolves scope from server-side session state and current durable membership.
 * A client-supplied organization identifier is accepted only as an equality
 * assertion against that resolved state.
 */
export async function resolveActiveOrganizationScope(
  executor: SqlExecutor,
  input: {
    expectedOrganizationId?: string;
    sessionId: string;
    userId: string;
  },
): Promise<ActiveOrganizationScope | null> {
  const values: unknown[] = [input.sessionId, input.userId];
  const expectedClause =
    input.expectedOrganizationId === undefined
      ? ""
      : `AND organization.id = $${values.push(input.expectedOrganizationId)}`;
  const result = await executor.query<ActiveScopeRow>(
    `SELECT
       member.id AS membership_id,
       organization.id AS organization_id,
       organization.version AS organization_version,
       member.role
     FROM app."session" AS session
     INNER JOIN app."user" AS authenticated_user
       ON authenticated_user.id = session."userId"
      AND authenticated_user.status = 'active'
     INNER JOIN app.organization
       ON organization.id = session."activeOrganizationId"
      AND organization."deletedAt" IS NULL
     INNER JOIN app.member
       ON member."organizationId" = organization.id
      AND member."userId" = authenticated_user.id
      AND member.status = 'active'
     WHERE session.id = $1
       AND session."userId" = $2
       AND session."expiresAt" > statement_timestamp()
       ${expectedClause}
     LIMIT 1`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined || !isOrganizationRole(row.role)) return null;

  return {
    membershipId: row.membership_id,
    organizationId: row.organization_id,
    organizationVersion: row.organization_version,
    role: row.role,
  };
}

export async function requireActiveOrganizationCapability(
  executor: SqlExecutor,
  input: {
    capability: OrganizationCapability;
    expectedOrganizationId?: string;
    sessionId: string;
    userId: string;
  },
): Promise<ActiveOrganizationScope> {
  const scope = await resolveActiveOrganizationScope(executor, input);
  if (scope === null || !roleHasCapability(scope.role, input.capability)) {
    throw new AuthorizationDeniedError();
  }

  return scope;
}
