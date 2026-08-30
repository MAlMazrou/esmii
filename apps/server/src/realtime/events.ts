export const organizationInvalidationEvent = "organization:invalidate" as const;
export const organizationAccessRevokedEvent = "organization:access-revoked" as const;

export interface OrganizationInvalidationPayload {
  readonly version: string;
}

export type OrganizationAccessRevokedReason =
  "active-organization-changed" | "membership-revoked" | "organization-deleted" | "session-revoked";

export interface OrganizationAccessRevokedPayload {
  readonly reason: OrganizationAccessRevokedReason;
}

const safeVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export function createOrganizationInvalidationPayload(
  version: string,
): OrganizationInvalidationPayload {
  if (!safeVersionPattern.test(version)) {
    throw new TypeError("organization invalidation version is invalid");
  }
  return Object.freeze({ version });
}

export function createOrganizationAccessRevokedPayload(
  reason: OrganizationAccessRevokedReason,
): OrganizationAccessRevokedPayload {
  return Object.freeze({ reason });
}
