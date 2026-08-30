export type OrganizationRole = "owner" | "editor" | "member";

export type OrganizationCapability =
  | "organization:view"
  | "organization:update"
  | "organization:delete"
  | "members:list"
  | "members:add-remove"
  | "members:change-role"
  | "owners:manage"
  | "invitations:manage"
  | "profile:update-own";

const capabilities: Readonly<Record<OrganizationRole, ReadonlySet<OrganizationCapability>>> = {
  owner: new Set([
    "organization:view",
    "organization:update",
    "organization:delete",
    "members:list",
    "members:add-remove",
    "members:change-role",
    "owners:manage",
    "invitations:manage",
    "profile:update-own",
  ]),
  editor: new Set([
    "organization:view",
    "members:list",
    "invitations:manage",
    "profile:update-own",
  ]),
  member: new Set(["organization:view", "profile:update-own"]),
};

export interface ActiveMembership {
  active: boolean;
  organizationId: string;
  role: OrganizationRole;
  userId: string;
}

export class OrganizationAccessDeniedError extends Error {
  public constructor() {
    super("Organization access denied");
    this.name = "OrganizationAccessDeniedError";
  }
}

export function hasCapability(role: OrganizationRole, capability: OrganizationCapability): boolean {
  return capabilities[role].has(capability);
}

export function requireOrganizationCapability(input: {
  activeOrganizationId: string | null;
  capability: OrganizationCapability;
  membership: ActiveMembership | null;
  resourceOrganizationId: string;
  targetInvitationRole?: Exclude<OrganizationRole, "owner">;
}): ActiveMembership {
  const membership = input.membership;
  if (
    input.activeOrganizationId === null ||
    input.activeOrganizationId !== input.resourceOrganizationId ||
    membership === null ||
    !membership.active ||
    membership.organizationId !== input.resourceOrganizationId ||
    !hasCapability(membership.role, input.capability)
  ) {
    throw new OrganizationAccessDeniedError();
  }
  if (
    input.capability === "invitations:manage" &&
    input.targetInvitationRole !== undefined &&
    input.targetInvitationRole !== "editor" &&
    input.targetInvitationRole !== "member"
  ) {
    throw new OrganizationAccessDeniedError();
  }
  return membership;
}

export function requireRecentAuthentication(
  authenticatedAt: Date,
  now: Date,
  maximumAgeSeconds: number,
): void {
  const ageMs = now.getTime() - authenticatedAt.getTime();
  if (ageMs < 0 || ageMs > maximumAgeSeconds * 1000) {
    throw new OrganizationAccessDeniedError();
  }
}
