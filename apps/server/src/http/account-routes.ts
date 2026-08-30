import type { FastifyInstance, FastifyRequest } from "fastify";
import Type from "typebox";

import {
  AccountProvidersResponseSchema,
  ErrorResponseSchema,
  InvitationCreateRequestSchema,
  InvitationInspectResponseSchema,
  InvitationListResponseSchema,
  MagicLinkRequestResponseSchema,
  MemberListResponseSchema,
  MemberRoleUpdateRequestSchema,
  MutationResponseSchema,
  OrganizationCreateRequestSchema,
  OrganizationDeleteRequestSchema,
  OrganizationSummarySchema,
  OrganizationSwitchRequestSchema,
  OrganizationUpdateRequestSchema,
  ProfileUpdateRequestSchema,
  PublicConfigurationSchema,
  SessionListResponseSchema,
  ViewerResponseSchema,
  type AccountProvidersResponse,
  type AuthProviderId,
  type InvitationCreateRequest,
  type InvitationInspectResponse,
  type InvitationListResponse,
  type MemberListResponse,
  type MemberRoleUpdateRequest,
  type OrganizationCreateRequest,
  type OrganizationDeleteRequest,
  type OrganizationSummary,
  type OrganizationSwitchRequest,
  type OrganizationUpdateRequest,
  type ProfileUpdateRequest,
  type PublicConfiguration,
  type SessionListResponse,
  type ViewerResponse,
} from "@esmii/contracts";

import type { AuthenticationSeam, AuthenticatedPrincipal } from "../account/seams.js";
import { canonicalRateLimitEmail, type AbuseRateLimiter } from "../security/rate-limiter.js";

const tenMinutesInSeconds = 10 * 60;
const oneHourInSeconds = 60 * 60;
const magicAcceptedResponse = Object.freeze({
  status: "accepted" as const,
  message: "If this email can sign in, a link will arrive shortly." as const,
});

const AuthResultResponseSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("expired"),
      Type.Literal("used"),
      Type.Literal("superseded"),
      Type.Literal("invalid"),
      Type.Literal("provider_cancelled"),
      Type.Literal("provider_failed"),
      Type.Literal("unsafe_link_rejected"),
    ]),
  },
  { additionalProperties: false },
);

const MagicLinkIngressSchema = Type.Object(
  {
    callbackId: Type.Optional(Type.Literal("app")),
    email: Type.String({ maxLength: 320 }),
  },
  { additionalProperties: false },
);

const RedirectResponseSchema = Type.Object(
  { redirectUrl: Type.String({ minLength: 1, maxLength: 2048 }) },
  { additionalProperties: false },
);

const IdentifierParamsSchema = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 160 }) },
  { additionalProperties: false },
);

const ProviderParamsSchema = Type.Object(
  {
    provider: Type.Union([
      Type.Literal("google"),
      Type.Literal("microsoft"),
      Type.Literal("apple"),
    ]),
  },
  { additionalProperties: false },
);

export type AuthResultState =
  | "expired"
  | "used"
  | "superseded"
  | "invalid"
  | "provider_cancelled"
  | "provider_failed"
  | "unsafe_link_rejected";

export interface AccountRequestContext {
  cookieHeader?: string;
  idempotencyKey: string | null;
  principal: AuthenticatedPrincipal;
  requestId: string;
}

export interface LogoutResult {
  setCookieHeaders: readonly string[];
}

export interface AccountHttpService {
  acceptInvitation(context: AccountRequestContext): Promise<void>;
  createInvitation(context: AccountRequestContext, input: InvitationCreateRequest): Promise<void>;
  createOrganization(
    context: AccountRequestContext,
    input: OrganizationCreateRequest,
  ): Promise<void>;
  deleteOrganization(
    context: AccountRequestContext,
    input: OrganizationDeleteRequest,
  ): Promise<void>;
  getAuthResult(request: FastifyRequest): Promise<{ state: AuthResultState }>;
  getInvitation(
    principal: AuthenticatedPrincipal | null,
    request: FastifyRequest,
  ): Promise<InvitationInspectResponse>;
  getOrganization(context: AccountRequestContext): Promise<OrganizationSummary>;
  getPublicConfiguration(): Promise<PublicConfiguration>;
  getViewer(context: AccountRequestContext): Promise<ViewerResponse>;
  grantOwner(context: AccountRequestContext, memberId: string): Promise<void>;
  linkProvider(
    context: AccountRequestContext,
    provider: AuthProviderId,
  ): Promise<{ redirectUrl: string }>;
  listInvitations(context: AccountRequestContext): Promise<InvitationListResponse>;
  listMembers(context: AccountRequestContext): Promise<MemberListResponse>;
  listProviders(context: AccountRequestContext): Promise<AccountProvidersResponse>;
  listSessions(context: AccountRequestContext): Promise<SessionListResponse>;
  logout(context: AccountRequestContext): Promise<LogoutResult>;
  removeMember(context: AccountRequestContext, memberId: string): Promise<void>;
  requestMagicLink(input: {
    callbackId: "app";
    email: string;
    idempotencyKey: string | null;
    requestId: string;
  }): Promise<void>;
  resendInvitation(context: AccountRequestContext, invitationId: string): Promise<void>;
  revokeInvitation(context: AccountRequestContext, invitationId: string): Promise<void>;
  revokeOtherSessions(context: AccountRequestContext): Promise<void>;
  revokeProvider(context: AccountRequestContext, provider: AuthProviderId): Promise<void>;
  revokeSession(context: AccountRequestContext, sessionId: string): Promise<void>;
  switchOrganization(
    context: AccountRequestContext,
    input: OrganizationSwitchRequest,
  ): Promise<void>;
  updateMemberRole(
    context: AccountRequestContext,
    memberId: string,
    input: MemberRoleUpdateRequest,
  ): Promise<void>;
  updateOrganization(
    context: AccountRequestContext,
    input: OrganizationUpdateRequest,
  ): Promise<void>;
  updateProfile(context: AccountRequestContext, input: ProfileUpdateRequest): Promise<void>;
}

export interface AccountHttpDependencies {
  abuseRateLimiter: AbuseRateLimiter;
  authentication: AuthenticationSeam;
  service: AccountHttpService;
}

export class AccountHttpError extends Error {
  public readonly code: string;
  public readonly safeMessage: string;
  public readonly statusCode: number;

  public constructor(statusCode: number, code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "AccountHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers["idempotency-key"];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^[A-Za-z0-9:._-]{16,160}$/u.test(value)) {
    throw new AccountHttpError(400, "INVALID_IDEMPOTENCY_KEY", "The request key is invalid.");
  }
  return value;
}

async function optionalPrincipal(
  authentication: AuthenticationSeam,
  request: FastifyRequest,
): Promise<AuthenticatedPrincipal | null> {
  return authentication.authenticate({
    ...(request.headers.cookie === undefined ? {} : { cookieHeader: request.headers.cookie }),
    requestId: request.id,
  });
}

async function context(
  dependencies: AccountHttpDependencies,
  request: FastifyRequest,
  requireIdempotency = false,
): Promise<AccountRequestContext> {
  const principal = await optionalPrincipal(dependencies.authentication, request);
  if (principal === null) {
    throw new AccountHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  }
  const key = idempotencyKey(request);
  if (requireIdempotency && key === null) {
    throw new AccountHttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "A request key is required.");
  }
  return {
    ...(request.headers.cookie === undefined ? {} : { cookieHeader: request.headers.cookie }),
    idempotencyKey: key,
    principal,
    requestId: request.id,
  };
}

type RateLimitInput = Parameters<AbuseRateLimiter["consume"]>[0];

async function magicLinkRateLimitAllows(
  rateLimiter: AbuseRateLimiter,
  request: FastifyRequest<{ Body: { email: string } }>,
): Promise<boolean> {
  const email = canonicalRateLimitEmail(request.body.email);
  try {
    const networkDecision = rateLimiter.consume({
      bucket: "magic-network",
      limit: 30,
      subject: request.ip,
      windowSeconds: tenMinutesInSeconds,
    });
    if (email === null) {
      await networkDecision;
      return false;
    }
    const [network, identity] = await Promise.all([
      networkDecision,
      rateLimiter.consume({
        bucket: "magic-email",
        limit: 5,
        subject: email,
        windowSeconds: tenMinutesInSeconds,
      }),
    ]);
    return network.allowed && identity.allowed;
  } catch {
    return false;
  }
}

async function requireAuthenticatedRateLimits(
  rateLimiter: AbuseRateLimiter,
  inputs: readonly RateLimitInput[],
): Promise<void> {
  let decisions;
  try {
    decisions = await Promise.all(inputs.map((input) => rateLimiter.consume(input)));
  } catch {
    throw new AccountHttpError(
      503,
      "RATE_LIMIT_UNAVAILABLE",
      "Request protection is temporarily unavailable.",
    );
  }
  if (decisions.some((decision) => !decision.allowed)) {
    throw new AccountHttpError(429, "RATE_LIMITED", "Too many requests. Try again later.");
  }
}

const responseErrors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  429: ErrorResponseSchema,
  500: ErrorResponseSchema,
  503: ErrorResponseSchema,
} as const;

export function registerAccountRoutes(
  app: FastifyInstance,
  dependencies: AccountHttpDependencies,
): void {
  app.get(
    "/api/public/config",
    { schema: { response: { 200: PublicConfigurationSchema, ...responseErrors } } },
    async () => dependencies.service.getPublicConfiguration(),
  );

  app.post<{ Body: { callbackId?: "app"; email: string } }>(
    "/api/auth/magic-link/request",
    {
      schema: {
        body: MagicLinkIngressSchema,
        response: { 202: MagicLinkRequestResponseSchema, ...responseErrors },
      },
    },
    async (request, reply) => {
      if (!(await magicLinkRateLimitAllows(dependencies.abuseRateLimiter, request))) {
        return reply.code(202).send(magicAcceptedResponse);
      }
      await dependencies.service.requestMagicLink({
        callbackId: request.body.callbackId ?? "app",
        email: request.body.email,
        idempotencyKey: idempotencyKey(request),
        requestId: request.id,
      });
      return reply.code(202).send(magicAcceptedResponse);
    },
  );

  app.get(
    "/api/auth/result",
    { schema: { response: { 200: AuthResultResponseSchema, ...responseErrors } } },
    async (request) => dependencies.service.getAuthResult(request),
  );

  app.get(
    "/api/viewer",
    { schema: { response: { 200: ViewerResponseSchema, ...responseErrors } } },
    async (request) => dependencies.service.getViewer(await context(dependencies, request)),
  );

  app.post(
    "/api/account/logout",
    { schema: { response: { 200: MutationResponseSchema, ...responseErrors } } },
    async (request, reply) => {
      const result = await dependencies.service.logout(await context(dependencies, request));
      if (result.setCookieHeaders.length > 0) {
        void reply.header("set-cookie", [...result.setCookieHeaders]);
      }
      return reply.send({ status: "ok" as const });
    },
  );

  app.get(
    "/api/account/sessions",
    { schema: { response: { 200: SessionListResponseSchema, ...responseErrors } } },
    async (request) => dependencies.service.listSessions(await context(dependencies, request)),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/account/sessions/:id",
    {
      schema: {
        params: IdentifierParamsSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.revokeSession(
        await context(dependencies, request, true),
        request.params.id,
      );
      return { status: "ok" as const };
    },
  );

  app.post(
    "/api/account/sessions/revoke-others",
    { schema: { response: { 200: MutationResponseSchema, ...responseErrors } } },
    async (request) => {
      await dependencies.service.revokeOtherSessions(await context(dependencies, request, true));
      return { status: "ok" as const };
    },
  );

  app.patch<{ Body: ProfileUpdateRequest }>(
    "/api/account/profile",
    {
      schema: {
        body: ProfileUpdateRequestSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.updateProfile(
        await context(dependencies, request, true),
        request.body,
      );
      return { status: "ok" as const };
    },
  );

  app.get(
    "/api/account/providers",
    { schema: { response: { 200: AccountProvidersResponseSchema, ...responseErrors } } },
    async (request) => dependencies.service.listProviders(await context(dependencies, request)),
  );

  app.post<{ Params: { provider: AuthProviderId } }>(
    "/api/account/providers/:provider/link",
    {
      schema: {
        params: ProviderParamsSchema,
        response: { 200: RedirectResponseSchema, ...responseErrors },
      },
    },
    async (request) =>
      dependencies.service.linkProvider(
        await context(dependencies, request, true),
        request.params.provider,
      ),
  );

  app.delete<{ Params: { provider: AuthProviderId } }>(
    "/api/account/providers/:provider",
    {
      schema: {
        params: ProviderParamsSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.revokeProvider(
        await context(dependencies, request, true),
        request.params.provider,
      );
      return { status: "ok" as const };
    },
  );

  app.get(
    "/api/organizations",
    { schema: { response: { 200: ViewerResponseSchema, ...responseErrors } } },
    async (request) => dependencies.service.getViewer(await context(dependencies, request)),
  );

  app.post<{ Body: OrganizationCreateRequest }>(
    "/api/organizations",
    {
      schema: {
        body: OrganizationCreateRequestSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.createOrganization(
        await context(dependencies, request, true),
        request.body,
      );
      return { status: "ok" as const };
    },
  );

  app.post<{ Body: OrganizationSwitchRequest }>(
    "/api/organizations/switch",
    {
      schema: {
        body: OrganizationSwitchRequestSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.switchOrganization(
        await context(dependencies, request, true),
        request.body,
      );
      return { status: "ok" as const };
    },
  );

  app.get(
    "/api/organization",
    { schema: { response: { 200: OrganizationSummarySchema, ...responseErrors } } },
    async (request) => dependencies.service.getOrganization(await context(dependencies, request)),
  );

  app.patch<{ Body: OrganizationUpdateRequest }>(
    "/api/organization",
    {
      schema: {
        body: OrganizationUpdateRequestSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.updateOrganization(
        await context(dependencies, request, true),
        request.body,
      );
      return { status: "ok" as const };
    },
  );

  app.post<{ Body: OrganizationDeleteRequest }>(
    "/api/organization/delete",
    {
      schema: {
        body: OrganizationDeleteRequestSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.deleteOrganization(
        await context(dependencies, request, true),
        request.body,
      );
      return { status: "ok" as const };
    },
  );

  app.get(
    "/api/organization/members",
    { schema: { response: { 200: MemberListResponseSchema, ...responseErrors } } },
    async (request) => dependencies.service.listMembers(await context(dependencies, request)),
  );

  app.patch<{ Body: MemberRoleUpdateRequest; Params: { id: string } }>(
    "/api/organization/members/:id",
    {
      schema: {
        body: MemberRoleUpdateRequestSchema,
        params: IdentifierParamsSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.updateMemberRole(
        await context(dependencies, request, true),
        request.params.id,
        request.body,
      );
      return { status: "ok" as const };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/organization/members/:id",
    {
      schema: {
        params: IdentifierParamsSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.removeMember(
        await context(dependencies, request, true),
        request.params.id,
      );
      return { status: "ok" as const };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/organization/members/:id/grant-owner",
    {
      schema: {
        params: IdentifierParamsSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      await dependencies.service.grantOwner(
        await context(dependencies, request, true),
        request.params.id,
      );
      return { status: "ok" as const };
    },
  );

  app.get(
    "/api/organization/invitations",
    { schema: { response: { 200: InvitationListResponseSchema, ...responseErrors } } },
    async (request) => dependencies.service.listInvitations(await context(dependencies, request)),
  );

  app.post<{ Body: InvitationCreateRequest }>(
    "/api/organization/invitations",
    {
      schema: {
        body: InvitationCreateRequestSchema,
        response: { 200: MutationResponseSchema, ...responseErrors },
      },
    },
    async (request) => {
      const requestContext = await context(dependencies, request, true);
      const recipient = canonicalRateLimitEmail(request.body.email);
      if (recipient === null) {
        throw new AccountHttpError(400, "INVALID_REQUEST", "The request is invalid.");
      }
      await requireAuthenticatedRateLimits(dependencies.abuseRateLimiter, [
        {
          bucket: "invitation-actor",
          limit: 20,
          subject: requestContext.principal.userId,
          windowSeconds: oneHourInSeconds,
        },
        {
          bucket: "invitation-recipient",
          limit: 5,
          subject: recipient,
          windowSeconds: oneHourInSeconds,
        },
      ]);
      await dependencies.service.createInvitation(requestContext, request.body);
      return { status: "ok" as const };
    },
  );

  for (const action of ["resend", "revoke"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/organization/invitations/:id/${action}`,
      {
        schema: {
          params: IdentifierParamsSchema,
          response: { 200: MutationResponseSchema, ...responseErrors },
        },
      },
      async (request) => {
        const requestContext = await context(dependencies, request, true);
        if (action === "resend") {
          await requireAuthenticatedRateLimits(dependencies.abuseRateLimiter, [
            {
              bucket: "invitation-resend",
              limit: 5,
              subject: `actor:${requestContext.principal.userId}`,
              windowSeconds: oneHourInSeconds,
            },
            {
              bucket: "invitation-resend",
              limit: 5,
              subject: `invitation:${request.params.id}`,
              windowSeconds: oneHourInSeconds,
            },
          ]);
          await dependencies.service.resendInvitation(requestContext, request.params.id);
        } else {
          await dependencies.service.revokeInvitation(requestContext, request.params.id);
        }
        return { status: "ok" as const };
      },
    );
  }

  app.get(
    "/api/invitation",
    { schema: { response: { 200: InvitationInspectResponseSchema, ...responseErrors } } },
    async (request) =>
      dependencies.service.getInvitation(
        await optionalPrincipal(dependencies.authentication, request),
        request,
      ),
  );

  app.post(
    "/api/invitation/accept",
    { schema: { response: { 200: MutationResponseSchema, ...responseErrors } } },
    async (request) => {
      await dependencies.service.acceptInvitation(await context(dependencies, request, true));
      return { status: "ok" as const };
    },
  );
}
