import { createHash, randomUUID } from "node:crypto";

import type { AppEnvironment } from "@esmii/config";
import type {
  AccountProvidersResponse,
  AuthProviderId,
  InvitationCreateRequest,
  InvitationInspectResponse,
  InvitationListResponse,
  MemberListResponse,
  MemberRoleUpdateRequest,
  OrganizationCreateRequest,
  OrganizationDeleteRequest,
  OrganizationSummary,
  OrganizationSwitchRequest,
  OrganizationUpdateRequest,
  ProfileUpdateRequest,
  PublicConfiguration,
  SessionListResponse,
  ViewerResponse,
} from "@esmii/contracts";
import {
  AuthorizationDeniedError,
  acceptInvitationFromContinuation,
  applyMembershipReduction,
  applyOrganizationSoftDeletion,
  canonicalizeEmail,
  createActionIntentWithOutbox,
  createOrResendInvitation,
  createOrganization,
  getActiveOrganizationSummary,
  getViewerContext,
  grantOwnerAuthority,
  insertAuditEvent,
  listActiveOrganizationMembers,
  listLinkedAccountProviders,
  listOrganizationInvitations,
  listSafeSessions,
  promoteMembershipToEditor,
  requireActiveOrganizationCapability,
  revokeAllOtherSessions,
  revokeInvitation,
  revokeSession,
  setActiveOrganization,
  unlinkLinkedAccountWithTombstone,
  updateActiveOrganizationDisplayName,
  updateOwnDisplayName,
  withTransaction,
  type AuditEventInput,
  type DatabaseClient,
  type OrganizationCapability,
  type OrganizationRole,
  type SqlExecutor,
  type TombstoneScopeKind,
} from "@esmii/database";
import type { FastifyRequest } from "fastify";

import type { AuthenticatedPrincipal } from "../account/seams.js";
import {
  parseInvitationContinuationCookie,
  type InvitationContinuationPresentation,
} from "../http/action-link-routes.js";
import {
  AccountHttpError,
  type AuthResultState,
  type AccountHttpService,
  type AccountRequestContext,
  type LogoutResult,
} from "../http/account-routes.js";
import type { OrganizationRealtimePublisher } from "../realtime/publisher.js";

const MAGIC_LINK_LIFETIME_MS = 10 * 60 * 1000;
const PAGE_LIMIT = 100;

const postgresRepositories = {
  acceptInvitationFromContinuation,
  applyMembershipReduction,
  applyOrganizationSoftDeletion,
  createActionIntentWithOutbox,
  createOrResendInvitation,
  createOrganization,
  getActiveOrganizationSummary,
  getViewerContext,
  grantOwnerAuthority,
  insertAuditEvent,
  listActiveOrganizationMembers,
  listLinkedAccountProviders,
  listOrganizationInvitations,
  listSafeSessions,
  promoteMembershipToEditor,
  requireActiveOrganizationCapability,
  revokeAllOtherSessions,
  revokeInvitation,
  revokeSession,
  setActiveOrganization,
  unlinkLinkedAccountWithTombstone,
  updateActiveOrganizationDisplayName,
  updateOwnDisplayName,
  withTransaction,
};

export type AccountRepositories = typeof postgresRepositories;

export interface ProviderLinkingSeam {
  /**
   * Starts Better Auth's authenticated provider-link flow. The callback bridge
   * remains responsible for verified-email validation and the final link audit.
   */
  begin(input: {
    cookieHeader: string;
    idempotencyKey: string;
    provider: AuthProviderId;
    requestId: string;
    sessionId: string;
    userId: string;
  }): Promise<{ redirectUrl: string }>;
}

export interface SessionTerminationSeam {
  /** Uses Better Auth's official sign-out path and returns only cookie-expiry headers. */
  expire(input: { cookieHeader: string; requestId: string }): Promise<LogoutResult>;
}

export interface ActionExchangeSeam {
  /** Reads only a short-lived, server-side auth-result continuation. */
  getAuthResult(request: FastifyRequest): Promise<{ state: AuthResultState }>;
  /** Reads only a short-lived invitation continuation, never a raw action token. */
  getInvitation(
    principal: AuthenticatedPrincipal | null,
    request: FastifyRequest,
    continuation: InvitationContinuationPresentation | null,
  ): Promise<InvitationInspectResponse>;
}

export type AccessReductionOperation =
  | "membership-demote"
  | "membership-remove"
  | "organization-delete"
  | "ownership-change"
  | "provider-unlink";

export interface AccessReductionRequest {
  accountId?: string;
  eventId: string;
  membershipId?: string;
  operation: AccessReductionOperation;
  organizationId?: string;
  scopeKind: TombstoneScopeKind;
  userId?: string;
}

export interface SecurityTombstoneOrchestrator {
  /**
   * Must durably prepare the journal and matching database tombstone before
   * invoking mutate, commit the journal before returning success, and fail
   * closed when prepare/commit/cancel cannot be made durable.
   */
  execute<Result>(
    request: Readonly<AccessReductionRequest>,
    mutate: (transaction: SqlExecutor) => Promise<Result>,
  ): Promise<Result>;
}

export interface PostgresAccountServiceOptions {
  actionExchange: ActionExchangeSeam;
  appEnvironment: AppEnvironment;
  clock?: () => Date;
  idFactory?: () => string;
  isMagicLinkRecipientAllowed?: (canonicalEmail: string) => boolean | Promise<boolean>;
  pool: DatabaseClient["pool"];
  providerLinking: ProviderLinkingSeam;
  publicConfiguration: PublicConfiguration;
  realtime: OrganizationRealtimePublisher;
  recentAuthenticationSeconds: number;
  repositories?: Partial<AccountRepositories>;
  sessionTermination: SessionTerminationSeam;
  tombstones: SecurityTombstoneOrchestrator;
}

interface MembershipTarget {
  id: string;
  role: OrganizationRole;
  userId: string;
}

interface InvitationTarget {
  email: string;
  id: string;
  role: "editor" | "member";
  status: string;
}

function sha256(...parts: readonly string[]): string {
  const digest = createHash("sha256");
  for (const part of parts) {
    digest.update(part.length.toString(10));
    digest.update(":");
    digest.update(part);
    digest.update(";");
  }
  return digest.digest("hex");
}

function requireIdempotencyKey(context: AccountRequestContext): string {
  if (context.idempotencyKey === null) {
    throw new AccountHttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "A request key is required.");
  }
  return context.idempotencyKey;
}

function forbidden(): never {
  throw new AccountHttpError(403, "FORBIDDEN", "This action is not allowed.");
}

function noActiveOrganization(): never {
  throw new AccountHttpError(409, "NO_ACTIVE_ORGANIZATION", "Select an organization to continue.");
}

function conflict(message: string): never {
  throw new AccountHttpError(409, "CONFLICT", message);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505";
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof AccountHttpError) throw error;
  if (error instanceof AuthorizationDeniedError) forbidden();
  if (error instanceof Error) {
    if (error.message.includes("recent") && error.message.includes("required")) {
      throw new AccountHttpError(
        403,
        "RECENT_AUTHENTICATION_REQUIRED",
        "Sign in again to continue.",
      );
    }
    if (
      error.message.includes("owner is required") ||
      error.message.includes("management is not permitted")
    ) {
      forbidden();
    }
    if (
      error.message.includes("final usable login method") ||
      error.message.includes("active membership already exists") ||
      error.message.includes("owner authority") ||
      error.message.includes("idempotency key")
    ) {
      conflict("The requested change conflicts with current state.");
    }
  }
  if (isUniqueViolation(error)) conflict("The requested value is already in use.");
  throw error;
}

function normalizeOrganizationSlug(displayName: string, organizationId: string): string {
  const normalized = displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/gu, "");
  const base = normalized.length >= 2 ? normalized : "organization";
  const suffix = organizationId.replace(/-/gu, "").slice(0, 10).toLowerCase();
  return `${base}-${suffix}`.slice(0, 80).replace(/-+$/gu, "");
}

function clientLabel(userAgent: string | null, ipAddress: string | null): string {
  const safeAgent = userAgent?.replace(/\p{Cc}/gu, " ").trim();
  if (safeAgent !== undefined && safeAgent.length > 0) return safeAgent.slice(0, 160);
  if (ipAddress !== null && ipAddress.length > 0) return `Client at ${ipAddress}`.slice(0, 160);
  return "Unknown client";
}

function publicProviders(configuration: PublicConfiguration): PublicConfiguration["providers"] {
  return configuration.providers.map((provider) => ({ ...provider }));
}

function safeAudit(
  context: Pick<AccountRequestContext, "principal" | "requestId">,
  eventId: string,
): AuditEventInput {
  return {
    action: "account.requested",
    actorUserId: context.principal.userId,
    correlationId: context.requestId,
    eventId,
    organizationId: null,
    requestId: context.requestId,
    result: "success",
    targetId: context.principal.userId,
    targetType: "user",
  };
}

export class PostgresAccountHttpService implements AccountHttpService {
  readonly #actionExchange: ActionExchangeSeam;
  readonly #appEnvironment: AppEnvironment;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #isMagicLinkRecipientAllowed: (canonicalEmail: string) => boolean | Promise<boolean>;
  readonly #pool: DatabaseClient["pool"];
  readonly #providerLinking: ProviderLinkingSeam;
  readonly #publicConfiguration: PublicConfiguration;
  readonly #realtime: OrganizationRealtimePublisher;
  readonly #recentAuthenticationSeconds: number;
  readonly #repositories: AccountRepositories;
  readonly #sessionTermination: SessionTerminationSeam;
  readonly #tombstones: SecurityTombstoneOrchestrator;

  public constructor(options: PostgresAccountServiceOptions) {
    if (
      !Number.isSafeInteger(options.recentAuthenticationSeconds) ||
      options.recentAuthenticationSeconds < 60 ||
      options.recentAuthenticationSeconds > 3600
    ) {
      throw new TypeError("recentAuthenticationSeconds must be between 60 and 3600");
    }
    if (options.appEnvironment === "staging" && options.isMagicLinkRecipientAllowed === undefined) {
      throw new TypeError("staging requires an explicit magic-link recipient admission policy");
    }
    const providerIds = options.publicConfiguration.providers.map((provider) => provider.id);
    if (new Set(providerIds).size !== providerIds.length) {
      throw new TypeError("public provider configuration must not contain duplicates");
    }

    this.#actionExchange = options.actionExchange;
    this.#appEnvironment = options.appEnvironment;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#isMagicLinkRecipientAllowed = options.isMagicLinkRecipientAllowed ?? (() => true);
    this.#pool = options.pool;
    this.#providerLinking = options.providerLinking;
    this.#publicConfiguration = {
      applicationName: "Esmii",
      applicationSlug: "esmii",
      providers: publicProviders(options.publicConfiguration),
    };
    this.#realtime = options.realtime;
    this.#recentAuthenticationSeconds = options.recentAuthenticationSeconds;
    this.#repositories = { ...postgresRepositories, ...options.repositories };
    this.#sessionTermination = options.sessionTermination;
    this.#tombstones = options.tombstones;
  }

  public async acceptInvitation(context: AccountRequestContext): Promise<void> {
    const key = requireIdempotencyKey(context);
    const continuation = parseInvitationContinuationCookie(
      context.cookieHeader,
      this.#appEnvironment,
    );
    if (continuation === null) {
      conflict("The invitation can no longer be accepted.");
    }
    const eventId = this.#idFactory();
    try {
      const accepted = await this.#repositories.acceptInvitationFromContinuation(this.#pool, {
        audit: safeAudit(context, eventId),
        authorizationEventId: this.#idFactory(),
        authorizationIdempotencyKey: `authorization:${sha256(
          "invitation.accept",
          context.principal.userId,
          continuation.continuationId,
          key,
        )}`,
        continuationId: continuation.continuationId,
        correlationId: context.requestId,
        environment: this.#appEnvironment,
        membershipId: this.#idFactory(),
        presentedSecretHash: continuation.presentedSecretHash,
        userId: context.principal.userId,
      });
      if (!accepted) conflict("The invitation can no longer be accepted.");
      await this.#realtime.invalidateOrganization({
        organizationId: accepted.organizationId,
        version: accepted.version,
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async createInvitation(
    context: AccountRequestContext,
    input: InvitationCreateRequest,
  ): Promise<void> {
    const key = requireIdempotencyKey(context);
    const scope = await this.#requireActiveCapability(context, "invitations:manage");
    const email = this.#canonicalEmail(input.email);
    const deduplication = sha256(
      "invitation.create",
      context.principal.userId,
      scope.organizationId,
      email,
      input.role,
      key,
    );
    const auditEventId = this.#idFactory();
    try {
      await this.#repositories.createOrResendInvitation(this.#pool, {
        actorUserId: context.principal.userId,
        audit: safeAudit(context, auditEventId),
        correlationId: context.requestId,
        email,
        environment: this.#appEnvironment,
        intentId: this.#idFactory(),
        invitationId: this.#idFactory(),
        organizationId: scope.organizationId,
        outboxEventId: this.#idFactory(),
        outboxIdempotencyKey: `invitation:${deduplication}`,
        role: input.role,
      });
      await this.#realtime.invalidateOrganization({
        organizationId: scope.organizationId,
        version: auditEventId,
      });
    } catch (error) {
      // Replaying the same durable request must not create another invitation/email.
      if (isUniqueViolation(error)) return;
      mapRepositoryError(error);
    }
  }

  public async createOrganization(
    context: AccountRequestContext,
    input: OrganizationCreateRequest,
  ): Promise<void> {
    const key = requireIdempotencyKey(context);
    const organizationId = this.#idFactory();
    const auditEventId = this.#idFactory();
    try {
      const created = await this.#repositories.createOrganization(this.#pool, {
        actorUserId: context.principal.userId,
        audit: safeAudit(context, auditEventId),
        idempotencyId: this.#idFactory(),
        idempotencyKey: key,
        membershipId: this.#idFactory(),
        name: input.displayName,
        organizationId,
        requestHash: sha256("organization.create", input.displayName),
        slug: normalizeOrganizationSlug(input.displayName, organizationId),
      });
      await this.#realtime.invalidateOrganization({
        organizationId: created.organizationId,
        version: auditEventId,
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async deleteOrganization(
    context: AccountRequestContext,
    input: OrganizationDeleteRequest,
  ): Promise<void> {
    requireIdempotencyKey(context);
    const organization = await this.#activeOrganization(context);
    if (input.confirmation !== organization.displayName) {
      throw new AccountHttpError(
        409,
        "CONFIRMATION_MISMATCH",
        "The organization confirmation does not match.",
      );
    }
    const eventId = this.#idFactory();
    try {
      const deleted = await this.#tombstones.execute(
        {
          eventId,
          operation: "organization-delete",
          organizationId: organization.id,
          scopeKind: "organization",
        },
        async (transaction) =>
          this.#repositories.applyOrganizationSoftDeletion(transaction, {
            actorSessionId: context.principal.sessionId,
            actorUserId: context.principal.userId,
            audit: safeAudit(context, eventId),
            organizationId: organization.id,
            recentAfter: this.#recentAfter(),
            tombstoneEventId: eventId,
          }),
      );
      if (deleted) {
        await this.#realtime.revokeOrganizationAccess({
          organizationId: organization.id,
          reason: "organization-deleted",
          target: { kind: "organization" },
        });
      }
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async getAuthResult(request: FastifyRequest): Promise<{ state: AuthResultState }> {
    return this.#actionExchange.getAuthResult(request);
  }

  public async getInvitation(
    principal: AuthenticatedPrincipal | null,
    request: FastifyRequest,
  ): Promise<InvitationInspectResponse> {
    return this.#actionExchange.getInvitation(
      principal,
      request,
      parseInvitationContinuationCookie(request.headers.cookie, this.#appEnvironment),
    );
  }

  public async getOrganization(context: AccountRequestContext): Promise<OrganizationSummary> {
    return this.#activeOrganization(context);
  }

  public async getPublicConfiguration(): Promise<PublicConfiguration> {
    return {
      ...this.#publicConfiguration,
      providers: publicProviders(this.#publicConfiguration),
    };
  }

  public async getViewer(context: AccountRequestContext): Promise<ViewerResponse> {
    const viewer = await this.#repositories.getViewerContext(this.#pool, context.principal);
    if (viewer === null) {
      throw new AccountHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const organizations = viewer.memberships.map((membership) => ({
      displayName: membership.organizationName,
      id: membership.organizationId,
      locator: membership.organizationSlug,
      role: membership.role,
    }));
    return {
      activeOrganization:
        organizations.find((organization) => organization.id === viewer.activeOrganizationId) ??
        null,
      organizations,
      user: {
        displayName: viewer.name,
        email: viewer.email,
        emailVerified: viewer.emailVerified,
        id: viewer.id,
      },
    };
  }

  public async grantOwner(context: AccountRequestContext, memberId: string): Promise<void> {
    requireIdempotencyKey(context);
    const scope = await this.#requireActiveCapability(context, "ownership:manage");
    const auditEventId = this.#idFactory();
    try {
      const granted = await this.#repositories.grantOwnerAuthority(this.#pool, {
        actorSessionId: context.principal.sessionId,
        actorUserId: context.principal.userId,
        audit: safeAudit(context, auditEventId),
        organizationId: scope.organizationId,
        recentAfter: this.#recentAfter(),
        targetMembershipId: memberId,
      });
      if (granted) {
        await this.#realtime.invalidateOrganization({
          organizationId: scope.organizationId,
          version: auditEventId,
        });
      }
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async linkProvider(
    context: AccountRequestContext,
    provider: AuthProviderId,
  ): Promise<{ redirectUrl: string }> {
    const key = requireIdempotencyKey(context);
    if (context.cookieHeader === undefined || context.cookieHeader.trim().length === 0) {
      throw new AccountHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    this.#requireConfiguredProvider(provider);
    await this.#requireRecentSession(context);
    try {
      const result = await this.#providerLinking.begin({
        cookieHeader: context.cookieHeader,
        idempotencyKey: key,
        provider,
        requestId: context.requestId,
        sessionId: context.principal.sessionId,
        userId: context.principal.userId,
      });
      await this.#repositories.insertAuditEvent(this.#pool, {
        ...safeAudit(context, this.#idFactory()),
        action: "identity.provider_link_requested",
        targetId: provider,
        targetType: "provider",
      });
      return result;
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async listInvitations(context: AccountRequestContext): Promise<InvitationListResponse> {
    await this.#requireActiveCapability(context, "invitations:manage");
    const invitations = await this.#repositories.listOrganizationInvitations(this.#pool, {
      limit: PAGE_LIMIT,
      scope: "all",
      sessionId: context.principal.sessionId,
      userId: context.principal.userId,
    });
    const now = this.#clock().getTime();
    const items = invitations.map((invitation) => {
      const status =
        invitation.status === "pending" && invitation.expiresAt.getTime() <= now
          ? ("expired" as const)
          : invitation.status === "canceled" || invitation.status === "rejected"
            ? ("revoked" as const)
            : invitation.status;
      return {
        createdAt: invitation.createdAt.toISOString(),
        email: invitation.email,
        expiresAt: invitation.expiresAt.toISOString(),
        id: invitation.id,
        role: invitation.role,
        status,
      };
    });
    return {
      items,
      nextCursor: null,
      pendingCount: items.filter((invitation) => invitation.status === "pending").length,
      total: items.length,
    };
  }

  public async listMembers(context: AccountRequestContext): Promise<MemberListResponse> {
    await this.#requireActiveCapability(context, "members:list");
    const members = await this.#repositories.listActiveOrganizationMembers(this.#pool, {
      limit: PAGE_LIMIT,
      sessionId: context.principal.sessionId,
      userId: context.principal.userId,
    });
    return {
      items: members.map((member) => ({
        displayName: member.displayName,
        email: member.email,
        emailVerified: member.emailVerified,
        id: member.membershipId,
        isCurrentUser: member.isCurrentUser,
        joinedAt: member.createdAt.toISOString(),
        role: member.role,
      })),
      nextCursor: null,
      total: members.length,
    };
  }

  public async listProviders(context: AccountRequestContext): Promise<AccountProvidersResponse> {
    const [linked, viewer] = await Promise.all([
      this.#repositories.listLinkedAccountProviders(this.#pool, {
        sessionId: context.principal.sessionId,
        userId: context.principal.userId,
      }),
      this.#repositories.getViewerContext(this.#pool, context.principal),
    ]);
    if (viewer === null) {
      throw new AccountHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const linkedIds = new Set(linked.map((account) => account.providerId));
    return {
      items: (["google"] as const).map((id) => {
        const configured = this.#publicConfiguration.providers.some(
          (provider) => provider.id === id && provider.enabled,
        );
        const connected = linkedIds.has(id);
        const anotherConfiguredProvider = this.#publicConfiguration.providers.some(
          (provider) => provider.enabled && provider.id !== id && linkedIds.has(provider.id),
        );
        return {
          canDisconnect: connected && (viewer.emailVerified || anotherConfiguredProvider),
          configured,
          connected,
          id,
          label: "Google",
        };
      }),
    };
  }

  public async listSessions(context: AccountRequestContext): Promise<SessionListResponse> {
    const sessions = await this.#repositories.listSafeSessions(
      this.#pool,
      context.principal.userId,
    );
    return {
      items: sessions.map((session) => ({
        clientLabel: clientLabel(session.userAgent, session.ipAddress),
        createdAt: session.createdAt.toISOString(),
        current: session.id === context.principal.sessionId,
        id: session.id,
        lastSeenAt: session.updatedAt.toISOString(),
      })),
    };
  }

  public async logout(context: AccountRequestContext): Promise<LogoutResult> {
    if (context.cookieHeader === undefined || context.cookieHeader.trim().length === 0) {
      throw new AccountHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const currentSession = (
      await this.#repositories.listSafeSessions(this.#pool, context.principal.userId)
    ).find((session) => session.id === context.principal.sessionId);
    const revoked = await this.#repositories.withTransaction(this.#pool, async (transaction) => {
      const changed = await this.#repositories.revokeSession(transaction, {
        sessionId: context.principal.sessionId,
        userId: context.principal.userId,
      });
      if (!changed) return false;
      await this.#repositories.insertAuditEvent(transaction, {
        ...safeAudit(context, this.#idFactory()),
        action: "session.revoked",
        targetId: context.principal.sessionId,
        targetType: "session",
      });
      return true;
    });
    const activeOrganizationId = currentSession?.activeOrganizationId;
    if (revoked && activeOrganizationId !== null && activeOrganizationId !== undefined) {
      await this.#realtime.revokeOrganizationAccess({
        organizationId: activeOrganizationId,
        reason: "session-revoked",
        target: { kind: "session", sessionId: context.principal.sessionId },
      });
    }
    const result = await this.#sessionTermination.expire({
      cookieHeader: context.cookieHeader,
      requestId: context.requestId,
    });
    if (
      result.setCookieHeaders.length > 8 ||
      result.setCookieHeaders.some(
        (header) => header.length > 4096 || header.includes("\r") || header.includes("\n"),
      )
    ) {
      throw new Error("session termination returned invalid cookie headers");
    }
    return { setCookieHeaders: [...result.setCookieHeaders] };
  }

  public async removeMember(context: AccountRequestContext, memberId: string): Promise<void> {
    requireIdempotencyKey(context);
    const scope = await this.#requireActiveCapability(context, "members:manage-non-owner");
    const target = await this.#membershipTarget(scope.organizationId, memberId);
    if (target === null) return;
    const eventId = this.#idFactory();
    const ownership = target.role === "owner";
    try {
      const removed = await this.#tombstones.execute(
        {
          eventId,
          membershipId: memberId,
          operation: ownership ? "ownership-change" : "membership-remove",
          organizationId: scope.organizationId,
          scopeKind: ownership ? "ownership" : "membership",
          userId: target.userId,
        },
        async (transaction) =>
          this.#repositories.applyMembershipReduction(transaction, {
            actorSessionId: context.principal.sessionId,
            actorUserId: context.principal.userId,
            audit: safeAudit(context, eventId),
            newRole: null,
            organizationId: scope.organizationId,
            recentAfter: this.#recentAfter(),
            targetMembershipId: memberId,
            tombstoneEventId: eventId,
            tombstoneScopeKind: ownership ? "ownership" : "membership",
          }),
      );
      if (removed) {
        await this.#realtime.revokeOrganizationAccess({
          organizationId: scope.organizationId,
          reason: "membership-revoked",
          target: { kind: "user", userId: target.userId },
        });
        await this.#realtime.invalidateOrganization({
          organizationId: scope.organizationId,
          version: eventId,
        });
      }
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async requestMagicLink(input: {
    callbackId: "app";
    email: string;
    idempotencyKey: string | null;
    requestId: string;
  }): Promise<void> {
    let email: string;
    try {
      email = canonicalizeEmail(input.email);
    } catch {
      return;
    }
    if (!(await this.#isMagicLinkRecipientAllowed(email))) return;
    const intentId = this.#idFactory();
    const eventId = this.#idFactory();
    const deduplication = sha256("magic-link.request", email, input.idempotencyKey ?? eventId);
    const dispatchNotAfter = new Date(this.#clock().getTime() + MAGIC_LINK_LIFETIME_MS);
    try {
      await this.#repositories.withTransaction(this.#pool, async (transaction) => {
        await this.#repositories.createActionIntentWithOutbox(transaction, {
          aggregateId: intentId,
          aggregateVersion: 1,
          callbackIdentifier: "magic_login_callback",
          correlationId: input.requestId,
          dispatchNotAfter,
          environment: this.#appEnvironment,
          generation: 1,
          intentId,
          invitationId: null,
          outboxEventId: eventId,
          outboxIdempotencyKey: `magic-link:${deduplication}`,
          purpose: "magic_login",
          recipientEmail: email,
        });
      });
    } catch (error) {
      // An idempotency replay still gets the same public response and no new email.
      if (isUniqueViolation(error) && input.idempotencyKey !== null) return;
      throw error;
    }
  }

  public async resendInvitation(
    context: AccountRequestContext,
    invitationId: string,
  ): Promise<void> {
    const key = requireIdempotencyKey(context);
    const scope = await this.#requireActiveCapability(context, "invitations:manage");
    const invitation = await this.#invitationTarget(scope.organizationId, invitationId);
    if (invitation === null || invitation.status !== "pending") {
      conflict("The invitation is no longer pending.");
    }
    const deduplication = sha256(
      "invitation.resend",
      context.principal.userId,
      scope.organizationId,
      invitationId,
      key,
    );
    const auditEventId = this.#idFactory();
    try {
      await this.#repositories.createOrResendInvitation(this.#pool, {
        actorUserId: context.principal.userId,
        audit: safeAudit(context, auditEventId),
        correlationId: context.requestId,
        email: invitation.email,
        environment: this.#appEnvironment,
        intentId: this.#idFactory(),
        invitationId,
        organizationId: scope.organizationId,
        outboxEventId: this.#idFactory(),
        outboxIdempotencyKey: `invitation:${deduplication}`,
        role: invitation.role,
      });
      await this.#realtime.invalidateOrganization({
        organizationId: scope.organizationId,
        version: auditEventId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      mapRepositoryError(error);
    }
  }

  public async revokeInvitation(
    context: AccountRequestContext,
    invitationId: string,
  ): Promise<void> {
    requireIdempotencyKey(context);
    const scope = await this.#requireActiveCapability(context, "invitations:manage");
    const auditEventId = this.#idFactory();
    try {
      const revoked = await this.#repositories.revokeInvitation(this.#pool, {
        actorUserId: context.principal.userId,
        audit: safeAudit(context, auditEventId),
        invitationId,
        organizationId: scope.organizationId,
      });
      if (revoked) {
        await this.#realtime.invalidateOrganization({
          organizationId: scope.organizationId,
          version: auditEventId,
        });
      }
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async revokeOtherSessions(context: AccountRequestContext): Promise<void> {
    requireIdempotencyKey(context);
    const sessions = await this.#repositories.listSafeSessions(
      this.#pool,
      context.principal.userId,
    );
    const count = await this.#repositories.withTransaction(this.#pool, async (transaction) => {
      const revokedCount = await this.#repositories.revokeAllOtherSessions(transaction, {
        currentSessionId: context.principal.sessionId,
        userId: context.principal.userId,
      });
      if (revokedCount === 0) return 0;
      await this.#repositories.insertAuditEvent(transaction, {
        ...safeAudit(context, this.#idFactory()),
        action: "session.others_revoked",
        metadata: { count: revokedCount },
        targetId: context.principal.userId,
        targetType: "user",
      });
      return revokedCount;
    });
    if (count === 0) return;
    await Promise.all(
      sessions.flatMap((session) =>
        session.id === context.principal.sessionId || session.activeOrganizationId === null
          ? []
          : [
              this.#realtime.revokeOrganizationAccess({
                organizationId: session.activeOrganizationId,
                reason: "session-revoked",
                target: { kind: "session", sessionId: session.id },
              }),
            ],
      ),
    );
  }

  public async revokeProvider(
    context: AccountRequestContext,
    provider: AuthProviderId,
  ): Promise<void> {
    requireIdempotencyKey(context);
    const [linked, viewer, sessions] = await Promise.all([
      this.#repositories.listLinkedAccountProviders(this.#pool, {
        sessionId: context.principal.sessionId,
        userId: context.principal.userId,
      }),
      this.#repositories.getViewerContext(this.#pool, context.principal),
      this.#repositories.listSafeSessions(this.#pool, context.principal.userId),
    ]);
    if (viewer === null) {
      throw new AccountHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const target = linked.find((account) => account.providerId === provider);
    if (target === undefined) return;
    const eventId = this.#idFactory();
    try {
      const unlinked = await this.#tombstones.execute(
        {
          accountId: target.accountRecordId,
          eventId,
          operation: "provider-unlink",
          scopeKind: "provider",
          userId: context.principal.userId,
        },
        async (transaction) =>
          this.#repositories.unlinkLinkedAccountWithTombstone(transaction, {
            accountRecordId: target.accountRecordId,
            audit: safeAudit(context, eventId),
            currentSessionId: context.principal.sessionId,
            magicLinkRemainsUsable: viewer.emailVerified,
            providerId: provider,
            recentAfter: this.#recentAfter(),
            tombstoneEventId: eventId,
            tombstoneScopeKind: "provider",
            usableProviderIds: this.#publicConfiguration.providers
              .filter((item) => item.enabled)
              .map((item) => item.id),
            userId: context.principal.userId,
          }),
      );
      if (unlinked) {
        await Promise.all(
          sessions.flatMap((session) =>
            session.id === context.principal.sessionId || session.activeOrganizationId === null
              ? []
              : [
                  this.#realtime.revokeOrganizationAccess({
                    organizationId: session.activeOrganizationId,
                    reason: "session-revoked",
                    target: { kind: "session", sessionId: session.id },
                  }),
                ],
          ),
        );
      }
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async revokeSession(context: AccountRequestContext, sessionId: string): Promise<void> {
    requireIdempotencyKey(context);
    if (sessionId === context.principal.sessionId) {
      conflict("Use logout to revoke the current session.");
    }
    const target = (
      await this.#repositories.listSafeSessions(this.#pool, context.principal.userId)
    ).find((session) => session.id === sessionId);
    const revoked = await this.#repositories.withTransaction(this.#pool, async (transaction) => {
      const changed = await this.#repositories.revokeSession(transaction, {
        sessionId,
        userId: context.principal.userId,
      });
      if (!changed) return false;
      await this.#repositories.insertAuditEvent(transaction, {
        ...safeAudit(context, this.#idFactory()),
        action: "session.revoked",
        targetId: sessionId,
        targetType: "session",
      });
      return true;
    });
    const activeOrganizationId = target?.activeOrganizationId;
    if (revoked && activeOrganizationId !== null && activeOrganizationId !== undefined) {
      await this.#realtime.revokeOrganizationAccess({
        organizationId: activeOrganizationId,
        reason: "session-revoked",
        target: { kind: "session", sessionId },
      });
    }
  }

  public async switchOrganization(
    context: AccountRequestContext,
    input: OrganizationSwitchRequest,
  ): Promise<void> {
    requireIdempotencyKey(context);
    const previous = await this.#repositories.getActiveOrganizationSummary(
      this.#pool,
      context.principal,
    );
    try {
      await this.#repositories.withTransaction(this.#pool, async (transaction) => {
        const switched = await this.#repositories.setActiveOrganization(transaction, {
          organizationId: input.organizationId,
          sessionId: context.principal.sessionId,
          userId: context.principal.userId,
        });
        if (!switched) forbidden();
        await this.#repositories.insertAuditEvent(transaction, {
          ...safeAudit(context, this.#idFactory()),
          action: "organization.active_switched",
          organizationId: input.organizationId,
          targetId: input.organizationId,
          targetType: "organization",
        });
      });
      if (previous !== null && previous.id !== input.organizationId) {
        await this.#realtime.revokeOrganizationAccess({
          organizationId: previous.id,
          reason: "active-organization-changed",
          target: { kind: "session", sessionId: context.principal.sessionId },
        });
      }
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async updateMemberRole(
    context: AccountRequestContext,
    memberId: string,
    input: MemberRoleUpdateRequest,
  ): Promise<void> {
    requireIdempotencyKey(context);
    const scope = await this.#requireActiveCapability(context, "members:change-role");
    const target = await this.#membershipTarget(scope.organizationId, memberId);
    if (target === null || target.role === input.role) return;
    try {
      if (target.role === "member" && input.role === "editor") {
        const auditEventId = this.#idFactory();
        const promoted = await this.#repositories.promoteMembershipToEditor(this.#pool, {
          actorSessionId: context.principal.sessionId,
          actorUserId: context.principal.userId,
          audit: safeAudit(context, auditEventId),
          organizationId: scope.organizationId,
          targetMembershipId: memberId,
        });
        if (promoted) {
          await this.#realtime.invalidateOrganization({
            organizationId: scope.organizationId,
            version: auditEventId,
          });
        }
        return;
      }

      const eventId = this.#idFactory();
      const ownership = target.role === "owner";
      const reduced = await this.#tombstones.execute(
        {
          eventId,
          membershipId: memberId,
          operation: ownership ? "ownership-change" : "membership-demote",
          organizationId: scope.organizationId,
          scopeKind: ownership ? "ownership" : "membership",
          userId: target.userId,
        },
        async (transaction) =>
          this.#repositories.applyMembershipReduction(transaction, {
            actorSessionId: context.principal.sessionId,
            actorUserId: context.principal.userId,
            audit: safeAudit(context, eventId),
            newRole: input.role,
            organizationId: scope.organizationId,
            recentAfter: this.#recentAfter(),
            targetMembershipId: memberId,
            tombstoneEventId: eventId,
            tombstoneScopeKind: ownership ? "ownership" : "membership",
          }),
      );
      if (reduced) {
        await this.#realtime.revokeOrganizationAccess({
          organizationId: scope.organizationId,
          reason: "membership-revoked",
          target: { kind: "user", userId: target.userId },
        });
        await this.#realtime.invalidateOrganization({
          organizationId: scope.organizationId,
          version: eventId,
        });
      }
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async updateOrganization(
    context: AccountRequestContext,
    input: OrganizationUpdateRequest,
  ): Promise<void> {
    requireIdempotencyKey(context);
    const organization = await this.#activeOrganization(context);
    const auditEventId = this.#idFactory();
    try {
      const changed = await this.#repositories.updateActiveOrganizationDisplayName(this.#pool, {
        audit: safeAudit(context, auditEventId),
        name: input.displayName,
        sessionId: context.principal.sessionId,
        userId: context.principal.userId,
      });
      if (changed) {
        await this.#realtime.invalidateOrganization({
          organizationId: organization.id,
          version: auditEventId,
        });
      }
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  public async updateProfile(
    context: AccountRequestContext,
    input: ProfileUpdateRequest,
  ): Promise<void> {
    requireIdempotencyKey(context);
    const activeOrganization = await this.#repositories.getActiveOrganizationSummary(
      this.#pool,
      context.principal,
    );
    const auditEventId = this.#idFactory();
    await this.#repositories.withTransaction(this.#pool, async (transaction) => {
      const changed = await this.#repositories.updateOwnDisplayName(transaction, {
        name: input.displayName,
        sessionId: context.principal.sessionId,
        userId: context.principal.userId,
      });
      if (!changed) {
        throw new AccountHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      }
      await this.#repositories.insertAuditEvent(transaction, {
        ...safeAudit(context, auditEventId),
        action: "identity.profile_updated",
        targetId: context.principal.userId,
        targetType: "user",
      });
    });
    if (activeOrganization !== null) {
      await this.#realtime.invalidateOrganization({
        organizationId: activeOrganization.id,
        version: auditEventId,
      });
    }
  }

  async #activeOrganization(context: AccountRequestContext): Promise<OrganizationSummary> {
    const organization = await this.#repositories.getActiveOrganizationSummary(
      this.#pool,
      context.principal,
    );
    if (organization === null) noActiveOrganization();
    return {
      displayName: organization.name,
      id: organization.id,
      locator: organization.slug,
      role: organization.role,
    };
  }

  #canonicalEmail(value: string): string {
    try {
      return canonicalizeEmail(value);
    } catch {
      throw new AccountHttpError(400, "INVALID_EMAIL", "Enter a valid email address.");
    }
  }

  async #invitationTarget(
    organizationId: string,
    invitationId: string,
  ): Promise<InvitationTarget | null> {
    const result = await this.#pool.query<{
      email: string;
      id: string;
      role: "editor" | "member";
      status: string;
    }>(
      `SELECT id, email, role, status
         FROM app.invitation
        WHERE id = $1 AND "organizationId" = $2`,
      [invitationId, organizationId],
    );
    return result.rows[0] ?? null;
  }

  async #membershipTarget(
    organizationId: string,
    membershipId: string,
  ): Promise<MembershipTarget | null> {
    const result = await this.#pool.query<{
      id: string;
      role: OrganizationRole;
      user_id: string;
    }>(
      `SELECT id, role, "userId" AS user_id
         FROM app.member
        WHERE id = $1 AND "organizationId" = $2 AND status = 'active'`,
      [membershipId, organizationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id, role: row.role, userId: row.user_id };
  }

  async #requireActiveCapability(
    context: AccountRequestContext,
    capability: OrganizationCapability,
  ) {
    try {
      return await this.#repositories.requireActiveOrganizationCapability(this.#pool, {
        capability,
        sessionId: context.principal.sessionId,
        userId: context.principal.userId,
      });
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) forbidden();
      throw error;
    }
  }

  #requireConfiguredProvider(provider: AuthProviderId): void {
    const configured = this.#publicConfiguration.providers.some(
      (item) => item.id === provider && item.enabled,
    );
    if (!configured) {
      throw new AccountHttpError(
        404,
        "PROVIDER_UNAVAILABLE",
        "This sign-in method is unavailable.",
      );
    }
  }

  async #requireRecentSession(context: AccountRequestContext): Promise<void> {
    const result = await this.#pool.query(
      `SELECT id
         FROM app."session"
        WHERE id = $1
          AND "userId" = $2
          AND "expiresAt" > statement_timestamp()
          AND "createdAt" >= $3`,
      [context.principal.sessionId, context.principal.userId, this.#recentAfter()],
    );
    if (result.rowCount !== 1) {
      throw new AccountHttpError(
        403,
        "RECENT_AUTHENTICATION_REQUIRED",
        "Sign in again to continue.",
      );
    }
  }

  #recentAfter(): Date {
    return new Date(this.#clock().getTime() - this.#recentAuthenticationSeconds * 1000);
  }
}

export function createPostgresAccountHttpService(
  options: PostgresAccountServiceOptions,
): AccountHttpService {
  return new PostgresAccountHttpService(options);
}
