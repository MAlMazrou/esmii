import Type from "typebox";

export const AuthProviderIdSchema = Type.Union([
  Type.Literal("google"),
  Type.Literal("microsoft"),
  Type.Literal("apple"),
]);

export const AuthProviderModeSchema = Type.Union([Type.Literal("oauth"), Type.Literal("mock")]);

export const PublicAuthProviderSchema = Type.Object(
  {
    id: AuthProviderIdSchema,
    enabled: Type.Boolean(),
    mode: AuthProviderModeSchema,
  },
  { additionalProperties: false },
);

export const PublicConfigurationSchema = Type.Object(
  {
    applicationName: Type.Literal("Esmii"),
    applicationSlug: Type.Literal("esmii"),
    providers: Type.Array(PublicAuthProviderSchema, { maxItems: 3 }),
  },
  { additionalProperties: false },
);

export const MagicLinkRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    callbackId: Type.Optional(Type.Literal("app")),
  },
  { additionalProperties: false },
);

export const MagicLinkRequestResponseSchema = Type.Object(
  {
    status: Type.Literal("accepted"),
    message: Type.Literal("If this email can sign in, a link will arrive shortly."),
  },
  { additionalProperties: false },
);

export const MockSocialRequestSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal("google"), Type.Literal("microsoft")]),
    scenario: Type.Literal("success"),
  },
  { additionalProperties: false },
);

export const UserSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 160 }),
    displayName: Type.String({ minLength: 1, maxLength: 120 }),
    email: Type.String({ minLength: 3, maxLength: 320 }),
    emailVerified: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SessionSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 160 }),
    createdAt: Type.String({ format: "date-time" }),
    lastSeenAt: Type.String({ format: "date-time" }),
    clientLabel: Type.String({ minLength: 1, maxLength: 160 }),
    current: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SessionListResponseSchema = Type.Object(
  { items: Type.Array(SessionSummarySchema, { maxItems: 100 }) },
  { additionalProperties: false },
);

export const AccountProviderSummarySchema = Type.Object(
  {
    id: AuthProviderIdSchema,
    label: Type.String({ minLength: 1, maxLength: 40 }),
    configured: Type.Boolean(),
    connected: Type.Boolean(),
    canDisconnect: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AccountProvidersResponseSchema = Type.Object(
  { items: Type.Array(AccountProviderSummarySchema, { maxItems: 3 }) },
  { additionalProperties: false },
);

export const ProfileUpdateRequestSchema = Type.Object(
  { displayName: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);

export type AuthProviderId = Type.Static<typeof AuthProviderIdSchema>;
export type AuthProviderMode = Type.Static<typeof AuthProviderModeSchema>;
export type PublicAuthProvider = Type.Static<typeof PublicAuthProviderSchema>;
export type PublicConfiguration = Type.Static<typeof PublicConfigurationSchema>;
export type MagicLinkRequest = Type.Static<typeof MagicLinkRequestSchema>;
export type MagicLinkRequestResponse = Type.Static<typeof MagicLinkRequestResponseSchema>;
export type MockSocialRequest = Type.Static<typeof MockSocialRequestSchema>;
export type UserSummary = Type.Static<typeof UserSummarySchema>;
export type SessionSummary = Type.Static<typeof SessionSummarySchema>;
export type SessionListResponse = Type.Static<typeof SessionListResponseSchema>;
export type AccountProviderSummary = Type.Static<typeof AccountProviderSummarySchema>;
export type AccountProvidersResponse = Type.Static<typeof AccountProvidersResponseSchema>;
export type ProfileUpdateRequest = Type.Static<typeof ProfileUpdateRequestSchema>;
