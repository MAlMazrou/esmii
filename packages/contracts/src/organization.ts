import Type from "typebox";

import { UserSummarySchema } from "./auth.js";

export const OrganizationRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("editor"),
  Type.Literal("member"),
]);

export const InvitationRoleSchema = Type.Union([Type.Literal("editor"), Type.Literal("member")]);

export const OrganizationSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 160 }),
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    locator: Type.String({ minLength: 2, maxLength: 80, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    role: OrganizationRoleSchema,
  },
  { additionalProperties: false },
);

export const ViewerResponseSchema = Type.Object(
  {
    user: UserSummarySchema,
    activeOrganization: Type.Union([OrganizationSummarySchema, Type.Null()]),
    organizations: Type.Array(OrganizationSummarySchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export const OrganizationCreateRequestSchema = Type.Object(
  {
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);

export const OrganizationSwitchRequestSchema = Type.Object(
  { organizationId: Type.String({ minLength: 1, maxLength: 160 }) },
  { additionalProperties: false },
);

export const OrganizationUpdateRequestSchema = Type.Object(
  { displayName: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);

export const OrganizationDeleteRequestSchema = Type.Object(
  {
    confirmation: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);

export const MemberSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 160 }),
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    email: Type.String({ minLength: 3, maxLength: 320 }),
    role: OrganizationRoleSchema,
    joinedAt: Type.String({ format: "date-time" }),
    isCurrentUser: Type.Boolean(),
    emailVerified: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const MemberListResponseSchema = Type.Object(
  {
    items: Type.Array(MemberSummarySchema, { maxItems: 100 }),
    total: Type.Integer({ minimum: 0 }),
    nextCursor: Type.Union([Type.String({ maxLength: 240 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const MemberRoleUpdateRequestSchema = Type.Object(
  { role: Type.Union([Type.Literal("editor"), Type.Literal("member")]) },
  { additionalProperties: false },
);

export const InvitationStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("expired"),
  Type.Literal("accepted"),
  Type.Literal("revoked"),
]);

export const InvitationSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 160 }),
    email: Type.String({ minLength: 3, maxLength: 320 }),
    role: InvitationRoleSchema,
    status: InvitationStateSchema,
    createdAt: Type.String({ format: "date-time" }),
    expiresAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const InvitationListResponseSchema = Type.Object(
  {
    items: Type.Array(InvitationSummarySchema, { maxItems: 100 }),
    total: Type.Integer({ minimum: 0 }),
    pendingCount: Type.Integer({ minimum: 0 }),
    nextCursor: Type.Union([Type.String({ maxLength: 240 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const InvitationCreateRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    role: InvitationRoleSchema,
  },
  { additionalProperties: false },
);

export const InvitationAcceptanceStateSchema = Type.Union([
  Type.Literal("needs_authentication"),
  Type.Literal("ready"),
  Type.Literal("wrong_email"),
  Type.Literal("expired"),
  Type.Literal("revoked"),
  Type.Literal("consumed"),
  Type.Literal("organization_deleted"),
  Type.Literal("accepted"),
]);

export const InvitationInspectResponseSchema = Type.Object(
  {
    state: InvitationAcceptanceStateSchema,
    organization: Type.Optional(
      Type.Object(
        { displayName: Type.String({ minLength: 1, maxLength: 120 }) },
        { additionalProperties: false },
      ),
    ),
    role: Type.Optional(InvitationRoleSchema),
  },
  { additionalProperties: false },
);

export const MutationResponseSchema = Type.Object(
  { status: Type.Literal("ok") },
  { additionalProperties: false },
);

export type OrganizationRole = Type.Static<typeof OrganizationRoleSchema>;
export type InvitationRole = Type.Static<typeof InvitationRoleSchema>;
export type OrganizationSummary = Type.Static<typeof OrganizationSummarySchema>;
export type ViewerResponse = Type.Static<typeof ViewerResponseSchema>;
export type OrganizationCreateRequest = Type.Static<typeof OrganizationCreateRequestSchema>;
export type OrganizationSwitchRequest = Type.Static<typeof OrganizationSwitchRequestSchema>;
export type OrganizationUpdateRequest = Type.Static<typeof OrganizationUpdateRequestSchema>;
export type OrganizationDeleteRequest = Type.Static<typeof OrganizationDeleteRequestSchema>;
export type MemberSummary = Type.Static<typeof MemberSummarySchema>;
export type MemberListResponse = Type.Static<typeof MemberListResponseSchema>;
export type MemberRoleUpdateRequest = Type.Static<typeof MemberRoleUpdateRequestSchema>;
export type InvitationState = Type.Static<typeof InvitationStateSchema>;
export type InvitationSummary = Type.Static<typeof InvitationSummarySchema>;
export type InvitationListResponse = Type.Static<typeof InvitationListResponseSchema>;
export type InvitationCreateRequest = Type.Static<typeof InvitationCreateRequestSchema>;
export type InvitationInspectResponse = Type.Static<typeof InvitationInspectResponseSchema>;
export type InvitationAcceptanceState = Type.Static<typeof InvitationAcceptanceStateSchema>;
export type MutationResponse = Type.Static<typeof MutationResponseSchema>;
