import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { PublicConfiguration } from "@esmii/contracts";
import type { DatabaseClient, SqlExecutor } from "@esmii/database";

import type { AccountRequestContext } from "../src/http/account-routes.js";
import type { OrganizationRealtimePublisher } from "../src/realtime/publisher.js";
import {
  PostgresAccountHttpService,
  type AccessReductionRequest,
  type ActionExchangeSeam,
  type AccountRepositories,
  type PostgresAccountServiceOptions,
  type ProviderLinkingSeam,
  type SecurityTombstoneOrchestrator,
  type SessionTerminationSeam,
} from "../src/services/account-service.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const context: AccountRequestContext = {
  cookieHeader: "better-auth.session=synthetic-session-cookie",
  idempotencyKey: "request:00000000-0000-4000-8000-000000000001",
  principal: { sessionId: "session-1", userId: "user-1" },
  requestId: "request-1",
};

const publicConfiguration: PublicConfiguration = {
  applicationName: "Esmii",
  applicationSlug: "esmii",
  providers: [{ enabled: true, id: "google", mode: "mock" }],
};

function identifierFactory(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
  };
}

interface Harness {
  actionExchange: ActionExchangeSeam;
  pool: DatabaseClient["pool"];
  poolQuery: ReturnType<typeof vi.fn>;
  providerLinking: ProviderLinkingSeam;
  realtime: OrganizationRealtimePublisher;
  reductions: AccessReductionRequest[];
  service: PostgresAccountHttpService;
  sessionTermination: SessionTerminationSeam;
  transaction: SqlExecutor;
}

function harness(
  repositories: Partial<AccountRepositories> = {},
  options: Partial<Omit<PostgresAccountServiceOptions, "repositories">> = {},
): Harness {
  const poolQuery = vi.fn(async () => ({ rowCount: 0, rows: [] }));
  const pool = { query: poolQuery } as unknown as DatabaseClient["pool"];
  const transaction: SqlExecutor = {
    query: poolQuery as unknown as SqlExecutor["query"],
  };
  const reductions: AccessReductionRequest[] = [];
  const tombstones: SecurityTombstoneOrchestrator = {
    async execute<Result>(
      request: Readonly<AccessReductionRequest>,
      mutate: (transaction: SqlExecutor) => Promise<Result>,
    ): Promise<Result> {
      reductions.push({ ...request });
      return mutate(transaction);
    },
  };
  const actionExchange: ActionExchangeSeam = {
    getAuthResult: vi.fn(async () => ({ state: "invalid" as const })),
    getInvitation: vi.fn(async () => ({ state: "needs_authentication" as const })),
  };
  const providerLinking: ProviderLinkingSeam = {
    begin: vi.fn(async () => ({ redirectUrl: "https://accounts.google.com/authorize" })),
  };
  const realtime: OrganizationRealtimePublisher = {
    invalidateOrganization: vi.fn(async () => undefined),
    revokeOrganizationAccess: vi.fn(async () => 0),
  };
  const sessionTermination: SessionTerminationSeam = {
    expire: vi.fn(async () => ({
      setCookieHeaders: ["better-auth.session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
    })),
  };
  const service = new PostgresAccountHttpService({
    actionExchange,
    appEnvironment: "test",
    clock: () => new Date(now),
    idFactory: identifierFactory(),
    pool,
    providerLinking,
    publicConfiguration,
    realtime,
    recentAuthenticationSeconds: 600,
    repositories,
    sessionTermination,
    tombstones,
    ...options,
  });
  return {
    actionExchange,
    pool,
    poolQuery,
    providerLinking,
    realtime,
    reductions,
    service,
    sessionTermination,
    transaction,
  };
}

function immediateTransactions(transaction: SqlExecutor): AccountRepositories["withTransaction"] {
  return (async (_pool, work) =>
    work(transaction as never)) as AccountRepositories["withTransaction"];
}

describe("PostgresAccountHttpService", () => {
  it("maps the server-derived viewer and active organization without client scope", async () => {
    const getViewerContext = vi.fn(async () => ({
      activeOrganizationId: "org-2",
      email: "viewer@example.test",
      emailVerified: true,
      id: "user-1",
      image: null,
      memberships: [
        {
          createdAt: now,
          membershipId: "member-1",
          organizationId: "org-1",
          organizationName: "First Organization",
          organizationSlug: "first-organization",
          role: "member" as const,
        },
        {
          createdAt: now,
          membershipId: "member-2",
          organizationId: "org-2",
          organizationName: "Second Organization",
          organizationSlug: "second-organization",
          role: "owner" as const,
        },
      ],
      name: "Synthetic Viewer",
    }));
    const { service } = harness({
      getViewerContext: getViewerContext as AccountRepositories["getViewerContext"],
    });

    await expect(service.getViewer(context)).resolves.toEqual({
      activeOrganization: {
        displayName: "Second Organization",
        id: "org-2",
        locator: "second-organization",
        role: "owner",
      },
      organizations: [
        {
          displayName: "First Organization",
          id: "org-1",
          locator: "first-organization",
          role: "member",
        },
        {
          displayName: "Second Organization",
          id: "org-2",
          locator: "second-organization",
          role: "owner",
        },
      ],
      user: {
        displayName: "Synthetic Viewer",
        email: "viewer@example.test",
        emailVerified: true,
        id: "user-1",
      },
    });
    expect(getViewerContext).toHaveBeenCalledWith(expect.anything(), context.principal);
  });

  it("creates a canonical, token-free magic-link intent and outbox transaction", async () => {
    const createIntent = vi.fn(
      async (
        _executor: SqlExecutor,
        _input: Parameters<AccountRepositories["createActionIntentWithOutbox"]>[1],
      ) => {
        void _executor;
        void _input;
      },
    );
    const temporary = harness();
    const { service } = harness({
      createActionIntentWithOutbox:
        createIntent as AccountRepositories["createActionIntentWithOutbox"],
      withTransaction: immediateTransactions(temporary.transaction),
    });

    await service.requestMagicLink({
      callbackId: "app",
      email: " Viewer+tag@Example.Test ",
      idempotencyKey: "magic-request:00000000-0000-4000-8000-000000000001",
      requestId: "request-magic-1",
    });

    expect(createIntent).toHaveBeenCalledOnce();
    const input = createIntent.mock.calls[0]?.[1];
    expect(input).toMatchObject({
      aggregateVersion: 1,
      callbackIdentifier: "magic_login_callback",
      correlationId: "request-magic-1",
      environment: "test",
      generation: 1,
      invitationId: null,
      purpose: "magic_login",
      recipientEmail: "viewer+tag@example.test",
    });
    expect(input?.dispatchNotAfter.toISOString()).toBe("2026-08-30T12:10:00.000Z");
    expect(JSON.stringify(input)).not.toMatch(/token|https?:\/\//iu);
    expect(input?.outboxIdempotencyKey).toMatch(/^magic-link:[0-9a-f]{64}$/u);

    await expect(
      service.requestMagicLink({
        callbackId: "app",
        email: "syntactically-invalid",
        idempotencyKey: "magic-request:00000000-0000-4000-8000-000000000002",
        requestId: "request-magic-2",
      }),
    ).resolves.toBeUndefined();
    expect(createIntent).toHaveBeenCalledOnce();
  });

  it("fails staging closed without an admission policy and silently declines an ineligible address", async () => {
    const base = harness();
    expect(
      () =>
        new PostgresAccountHttpService({
          actionExchange: base.actionExchange,
          appEnvironment: "staging",
          pool: base.pool,
          providerLinking: base.providerLinking,
          publicConfiguration,
          realtime: base.realtime,
          recentAuthenticationSeconds: 600,
          sessionTermination: base.sessionTermination,
          tombstones: {
            async execute<Result>(
              _request: AccessReductionRequest,
              _mutate: (transaction: SqlExecutor) => Promise<Result>,
            ): Promise<Result> {
              void _request;
              void _mutate;
              throw new Error("not called");
            },
          },
        }),
    ).toThrow("staging requires an explicit magic-link recipient admission policy");

    const createIntent = vi.fn(async () => undefined);
    const { service } = harness(
      {
        createActionIntentWithOutbox:
          createIntent as AccountRepositories["createActionIntentWithOutbox"],
      },
      {
        appEnvironment: "staging",
        isMagicLinkRecipientAllowed: () => false,
      },
    );
    await service.requestMagicLink({
      callbackId: "app",
      email: "not-allowed@example.test",
      idempotencyKey: null,
      requestId: "request-staging-1",
    });
    expect(createIntent).not.toHaveBeenCalled();
  });

  it("maps safe sessions/providers and requires a recent session before provider linking", async () => {
    const temporary = harness();
    const listSafeSessions = vi.fn(async () => [
      {
        activeOrganizationId: "org-1",
        createdAt: new Date("2026-08-30T10:00:00.000Z"),
        expiresAt: new Date("2026-09-30T10:00:00.000Z"),
        id: "session-1",
        ipAddress: "192.0.2.1",
        updatedAt: new Date("2026-08-30T11:55:00.000Z"),
        userAgent: "Synthetic Browser",
      },
    ]);
    const listProviders = vi.fn(async () => [
      {
        accountRecordId: "account-google-1",
        createdAt: now,
        providerId: "google",
        updatedAt: now,
      },
    ]);
    const getViewer = vi.fn(async () => ({
      activeOrganizationId: null,
      email: "viewer@example.test",
      emailVerified: true,
      id: "user-1",
      image: null,
      memberships: [],
      name: "Viewer",
    }));
    const insertAudit = vi.fn(async () => undefined);
    const { poolQuery, providerLinking, service } = harness({
      getViewerContext: getViewer as AccountRepositories["getViewerContext"],
      insertAuditEvent: insertAudit as AccountRepositories["insertAuditEvent"],
      listLinkedAccountProviders:
        listProviders as AccountRepositories["listLinkedAccountProviders"],
      listSafeSessions: listSafeSessions as AccountRepositories["listSafeSessions"],
      withTransaction: immediateTransactions(temporary.transaction),
    });
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "session-1" }] });

    await expect(service.listSessions(context)).resolves.toEqual({
      items: [
        {
          clientLabel: "Synthetic Browser",
          createdAt: "2026-08-30T10:00:00.000Z",
          current: true,
          id: "session-1",
          lastSeenAt: "2026-08-30T11:55:00.000Z",
        },
      ],
    });
    await expect(service.listProviders(context)).resolves.toMatchObject({
      items: [{ canDisconnect: true, configured: true, connected: true, id: "google" }],
    });
    await expect(service.linkProvider(context, "google")).resolves.toEqual({
      redirectUrl: "https://accounts.google.com/authorize",
    });
    expect(providerLinking.begin).toHaveBeenCalledWith({
      cookieHeader: context.cookieHeader,
      idempotencyKey: context.idempotencyKey,
      provider: "google",
      requestId: context.requestId,
      sessionId: context.principal.sessionId,
      userId: context.principal.userId,
    });
    expect(poolQuery.mock.calls.at(-1)?.[1]?.[2]).toEqual(new Date("2026-08-30T11:50:00.000Z"));
    expect(insertAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "identity.provider_link_requested" }),
    );
  });

  it("routes membership reductions, organization deletion, and provider unlink through tombstones", async () => {
    const requireCapability = vi.fn(async (_executor, input: { capability: string }) => ({
      membershipId: "actor-membership-1",
      organizationId: "org-1",
      organizationVersion: 2,
      role: input.capability === "members:manage-non-owner" ? "owner" : "owner",
    }));
    const reduceMembership = vi.fn(
      async (
        _executor: SqlExecutor,
        _input: Parameters<AccountRepositories["applyMembershipReduction"]>[1],
      ) => {
        void _executor;
        void _input;
        return true;
      },
    );
    const deleteOrganization = vi.fn(
      async (
        _executor: SqlExecutor,
        _input: Parameters<AccountRepositories["applyOrganizationSoftDeletion"]>[1],
      ) => {
        void _executor;
        void _input;
        return true;
      },
    );
    const unlinkProvider = vi.fn(
      async (
        _executor: SqlExecutor,
        _input: Parameters<AccountRepositories["unlinkLinkedAccountWithTombstone"]>[1],
      ) => {
        void _executor;
        void _input;
        return true;
      },
    );
    const listProviders = vi.fn(async () => [
      {
        accountRecordId: "account-google-1",
        createdAt: now,
        providerId: "google",
        updatedAt: now,
      },
    ]);
    const getOrganization = vi.fn(async () => ({
      createdAt: now,
      id: "org-1",
      logo: null,
      name: "Synthetic Organization",
      role: "owner" as const,
      slug: "synthetic-organization",
      updatedAt: now,
      version: 2,
    }));
    const getViewer = vi.fn(async () => ({
      activeOrganizationId: "org-1",
      email: "viewer@example.test",
      emailVerified: true,
      id: "user-1",
      image: null,
      memberships: [],
      name: "Synthetic Viewer",
    }));
    const { poolQuery, realtime, reductions, service } = harness({
      applyMembershipReduction: reduceMembership as AccountRepositories["applyMembershipReduction"],
      applyOrganizationSoftDeletion:
        deleteOrganization as AccountRepositories["applyOrganizationSoftDeletion"],
      getActiveOrganizationSummary:
        getOrganization as AccountRepositories["getActiveOrganizationSummary"],
      getViewerContext: getViewer as AccountRepositories["getViewerContext"],
      listLinkedAccountProviders:
        listProviders as AccountRepositories["listLinkedAccountProviders"],
      requireActiveOrganizationCapability:
        requireCapability as AccountRepositories["requireActiveOrganizationCapability"],
      unlinkLinkedAccountWithTombstone:
        unlinkProvider as AccountRepositories["unlinkLinkedAccountWithTombstone"],
    });
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "membership-editor-1", role: "editor", user_id: "user-2" }],
    });

    await service.updateMemberRole(context, "membership-editor-1", { role: "member" });
    await service.deleteOrganization(context, { confirmation: "Synthetic Organization" });
    await service.revokeProvider(context, "google");

    expect(reductions.map((reduction) => reduction.operation)).toEqual([
      "membership-demote",
      "organization-delete",
      "provider-unlink",
    ]);
    expect(reduceMembership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        newRole: "member",
        organizationId: "org-1",
        tombstoneScopeKind: "membership",
      }),
    );
    expect(deleteOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1" }),
    );
    expect(unlinkProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountRecordId: "account-google-1",
        magicLinkRemainsUsable: true,
        providerId: "google",
      }),
    );
    expect(realtime.revokeOrganizationAccess).toHaveBeenCalledWith({
      organizationId: "org-1",
      reason: "membership-revoked",
      target: { kind: "user", userId: "user-2" },
    });
    expect(realtime.revokeOrganizationAccess).toHaveBeenCalledWith({
      organizationId: "org-1",
      reason: "organization-deleted",
      target: { kind: "organization" },
    });
    expect(reduceMembership.mock.calls[0]?.[1].tombstoneEventId).toBe(reductions[0]?.eventId);
    expect(reduceMembership.mock.calls[0]?.[1].audit.eventId).toBe(reductions[0]?.eventId);
    expect(deleteOrganization.mock.calls[0]?.[1].tombstoneEventId).toBe(reductions[1]?.eventId);
    expect(deleteOrganization.mock.calls[0]?.[1].audit.eventId).toBe(reductions[1]?.eventId);
    expect(unlinkProvider.mock.calls[0]?.[1].tombstoneEventId).toBe(reductions[2]?.eventId);
    expect(unlinkProvider.mock.calls[0]?.[1].audit.eventId).toBe(reductions[2]?.eventId);
  });

  it("uses repository idempotency/audits for organization, invitation, session, and profile mutations", async () => {
    const temporary = harness();
    const createOrganization = vi.fn(async () => ({ organizationId: "org-new", replayed: false }));
    const createInvitation = vi.fn(async () => ({
      expiresAt: new Date("2026-09-06T12:00:00.000Z"),
      invitationId: "invitation-1",
      resent: false,
      version: 1,
    }));
    const insertAudit = vi.fn(async () => undefined);
    const revokeOwnedSession = vi.fn(async () => true);
    const updateProfile = vi.fn(async () => true);
    const requireCapability = vi.fn(async () => ({
      membershipId: "member-owner-1",
      organizationId: "org-1",
      organizationVersion: 1,
      role: "owner" as const,
    }));
    const { service } = harness({
      createOrResendInvitation: createInvitation as AccountRepositories["createOrResendInvitation"],
      createOrganization: createOrganization as AccountRepositories["createOrganization"],
      insertAuditEvent: insertAudit as AccountRepositories["insertAuditEvent"],
      requireActiveOrganizationCapability:
        requireCapability as AccountRepositories["requireActiveOrganizationCapability"],
      revokeSession: revokeOwnedSession as AccountRepositories["revokeSession"],
      updateOwnDisplayName: updateProfile as AccountRepositories["updateOwnDisplayName"],
      withTransaction: immediateTransactions(temporary.transaction),
    });

    await service.createOrganization(context, { displayName: "Synthetic Organization" });
    await service.createInvitation(context, {
      email: "Invited@Example.Test",
      role: "editor",
    });
    await service.revokeSession(context, "session-2");
    await service.updateProfile(context, { displayName: "Updated Viewer" });

    expect(createOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "user-1",
        idempotencyKey: context.idempotencyKey,
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        slug: expect.stringMatching(/^synthetic-organization-[a-z0-9]+$/u),
      }),
    );
    expect(createInvitation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: "invited@example.test",
        organizationId: "org-1",
        outboxIdempotencyKey: expect.stringMatching(/^invitation:[0-9a-f]{64}$/u),
      }),
    );
    expect(insertAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "session.revoked", targetId: "session-2" }),
    );
    expect(insertAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "identity.profile_updated" }),
    );
  });

  it("maps public configuration, active organization, members, and invitations", async () => {
    const requireCapability = vi.fn(async () => ({
      membershipId: "member-owner-1",
      organizationId: "org-1",
      organizationVersion: 1,
      role: "owner" as const,
    }));
    const getOrganization = vi.fn(async () => ({
      createdAt: now,
      id: "org-1",
      logo: null,
      name: "Synthetic Organization",
      role: "owner" as const,
      slug: "synthetic-organization",
      updatedAt: now,
      version: 1,
    }));
    const listMembers = vi.fn(async () => [
      {
        createdAt: now,
        displayName: "Synthetic Member",
        email: "member@example.test",
        emailVerified: true,
        isCurrentUser: false,
        membershipId: "membership-2",
        role: "member" as const,
        userId: "user-2",
      },
    ]);
    const listInvitations = vi.fn(async () => [
      {
        acceptedAt: null,
        createdAt: new Date("2026-08-20T12:00:00.000Z"),
        email: "expired@example.test",
        expiresAt: new Date("2026-08-29T12:00:00.000Z"),
        id: "invitation-expired",
        inviterId: "user-1",
        inviterName: "Synthetic Owner",
        organizationId: "org-1",
        revokedAt: null,
        role: "editor" as const,
        status: "pending" as const,
        updatedAt: now,
        version: 1,
      },
      {
        acceptedAt: null,
        createdAt: new Date("2026-08-30T11:00:00.000Z"),
        email: "revoked@example.test",
        expiresAt: new Date("2026-09-06T11:00:00.000Z"),
        id: "invitation-revoked",
        inviterId: "user-1",
        inviterName: "Synthetic Owner",
        organizationId: "org-1",
        revokedAt: now,
        role: "member" as const,
        status: "canceled" as const,
        updatedAt: now,
        version: 2,
      },
    ]);
    const { service } = harness({
      getActiveOrganizationSummary:
        getOrganization as AccountRepositories["getActiveOrganizationSummary"],
      listActiveOrganizationMembers:
        listMembers as AccountRepositories["listActiveOrganizationMembers"],
      listOrganizationInvitations:
        listInvitations as AccountRepositories["listOrganizationInvitations"],
      requireActiveOrganizationCapability:
        requireCapability as AccountRepositories["requireActiveOrganizationCapability"],
    });

    await expect(service.getPublicConfiguration()).resolves.toEqual(publicConfiguration);
    await expect(service.getOrganization(context)).resolves.toEqual({
      displayName: "Synthetic Organization",
      id: "org-1",
      locator: "synthetic-organization",
      role: "owner",
    });
    await expect(service.listMembers(context)).resolves.toMatchObject({
      items: [
        {
          displayName: "Synthetic Member",
          email: "member@example.test",
          id: "membership-2",
          joinedAt: now.toISOString(),
          role: "member",
        },
      ],
      nextCursor: null,
      total: 1,
    });
    await expect(service.listInvitations(context)).resolves.toMatchObject({
      items: [
        { id: "invitation-expired", status: "expired" },
        { id: "invitation-revoked", status: "revoked" },
      ],
      nextCursor: null,
      pendingCount: 0,
      total: 2,
    });
    expect(requireCapability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capability: "members:list" }),
    );
    expect(requireCapability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capability: "invitations:manage" }),
    );
  });

  it("uses additive ownership, promotion, and tombstone-backed member removal", async () => {
    const grantOwner = vi.fn(async () => true);
    const promoteMember = vi.fn(async () => true);
    const reduceMembership = vi.fn(
      async (
        _executor: SqlExecutor,
        _input: Parameters<AccountRepositories["applyMembershipReduction"]>[1],
      ) => {
        void _executor;
        void _input;
        return true;
      },
    );
    const requireCapability = vi.fn(async () => ({
      membershipId: "member-owner-1",
      organizationId: "org-1",
      organizationVersion: 1,
      role: "owner" as const,
    }));
    const { poolQuery, realtime, reductions, service } = harness({
      applyMembershipReduction: reduceMembership as AccountRepositories["applyMembershipReduction"],
      grantOwnerAuthority: grantOwner as AccountRepositories["grantOwnerAuthority"],
      promoteMembershipToEditor: promoteMember as AccountRepositories["promoteMembershipToEditor"],
      requireActiveOrganizationCapability:
        requireCapability as AccountRepositories["requireActiveOrganizationCapability"],
    });
    poolQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "membership-member-1", role: "member", user_id: "user-2" }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "membership-editor-1", role: "editor", user_id: "user-3" }],
      });

    await service.grantOwner(context, "membership-member-1");
    await service.updateMemberRole(context, "membership-member-1", { role: "editor" });
    await service.removeMember(context, "membership-editor-1");

    expect(grantOwner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        recentAfter: new Date("2026-08-30T11:50:00.000Z"),
        targetMembershipId: "membership-member-1",
      }),
    );
    expect(promoteMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        targetMembershipId: "membership-member-1",
      }),
    );
    expect(reductions.map((reduction) => reduction.operation)).toEqual(["membership-remove"]);
    expect(reduceMembership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        newRole: null,
        targetMembershipId: "membership-editor-1",
        tombstoneScopeKind: "membership",
      }),
    );
    expect(realtime.invalidateOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" }),
    );
    expect(realtime.revokeOrganizationAccess).toHaveBeenCalledWith({
      organizationId: "org-1",
      reason: "membership-revoked",
      target: { kind: "user", userId: "user-3" },
    });
  });

  it("switches and updates organizations and revokes current and other sessions with audits", async () => {
    const temporary = harness();
    const setActiveOrganization = vi.fn(async () => true);
    const updateOrganization = vi.fn(async () => true);
    const revokeOwnedSession = vi.fn(async () => true);
    const revokeOthers = vi.fn(async () => 2);
    const insertAudit = vi.fn(async () => undefined);
    const getOrganization = vi
      .fn()
      .mockResolvedValueOnce({
        createdAt: now,
        id: "org-1",
        logo: null,
        name: "First Organization",
        role: "owner" as const,
        slug: "first-organization",
        updatedAt: now,
        version: 1,
      })
      .mockResolvedValueOnce({
        createdAt: now,
        id: "org-2",
        logo: null,
        name: "Second Organization",
        role: "owner" as const,
        slug: "second-organization",
        updatedAt: now,
        version: 1,
      });
    const listSessions = vi.fn(async () => [
      {
        activeOrganizationId: "org-2",
        createdAt: now,
        expiresAt: new Date("2026-09-30T12:00:00.000Z"),
        id: context.principal.sessionId,
        ipAddress: null,
        updatedAt: now,
        userAgent: "Synthetic Current Browser",
      },
      {
        activeOrganizationId: "org-1",
        createdAt: now,
        expiresAt: new Date("2026-09-30T12:00:00.000Z"),
        id: "session-2",
        ipAddress: null,
        updatedAt: now,
        userAgent: "Synthetic Other Browser",
      },
    ]);
    const { realtime, service, sessionTermination } = harness({
      getActiveOrganizationSummary:
        getOrganization as AccountRepositories["getActiveOrganizationSummary"],
      insertAuditEvent: insertAudit as AccountRepositories["insertAuditEvent"],
      listSafeSessions: listSessions as AccountRepositories["listSafeSessions"],
      revokeAllOtherSessions: revokeOthers as AccountRepositories["revokeAllOtherSessions"],
      revokeSession: revokeOwnedSession as AccountRepositories["revokeSession"],
      setActiveOrganization: setActiveOrganization as AccountRepositories["setActiveOrganization"],
      updateActiveOrganizationDisplayName:
        updateOrganization as AccountRepositories["updateActiveOrganizationDisplayName"],
      withTransaction: immediateTransactions(temporary.transaction),
    });

    await service.switchOrganization(context, { organizationId: "org-2" });
    await service.updateOrganization(context, { displayName: "Renamed Organization" });
    await service.revokeOtherSessions(context);
    await expect(service.logout(context)).resolves.toEqual({
      setCookieHeaders: ["better-auth.session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
    });

    expect(setActiveOrganization).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-2",
      sessionId: context.principal.sessionId,
      userId: context.principal.userId,
    });
    expect(updateOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "Renamed Organization",
        sessionId: context.principal.sessionId,
      }),
    );
    expect(revokeOwnedSession).toHaveBeenCalledWith(expect.anything(), {
      sessionId: context.principal.sessionId,
      userId: context.principal.userId,
    });
    expect(revokeOthers).toHaveBeenCalledWith(expect.anything(), {
      currentSessionId: context.principal.sessionId,
      userId: context.principal.userId,
    });
    expect(insertAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "organization.active_switched" }),
    );
    expect(insertAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "session.others_revoked", metadata: { count: 2 } }),
    );
    expect(realtime.revokeOrganizationAccess).toHaveBeenCalledWith({
      organizationId: "org-1",
      reason: "active-organization-changed",
      target: { kind: "session", sessionId: context.principal.sessionId },
    });
    expect(sessionTermination.expire).toHaveBeenCalledWith({
      cookieHeader: context.cookieHeader,
      requestId: context.requestId,
    });
    expect(realtime.revokeOrganizationAccess).toHaveBeenCalledWith({
      organizationId: "org-1",
      reason: "session-revoked",
      target: { kind: "session", sessionId: "session-2" },
    });
    expect(realtime.revokeOrganizationAccess).toHaveBeenCalledWith({
      organizationId: "org-2",
      reason: "session-revoked",
      target: { kind: "session", sessionId: context.principal.sessionId },
    });
  });

  it("resends and revokes only an invitation in the server-derived organization", async () => {
    const resend = vi.fn(async () => ({
      expiresAt: new Date("2026-09-06T12:00:00.000Z"),
      invitationId: "invitation-1",
      resent: true,
      version: 2,
    }));
    const revoke = vi.fn(async () => true);
    const requireCapability = vi.fn(async () => ({
      membershipId: "member-owner-1",
      organizationId: "org-1",
      organizationVersion: 1,
      role: "owner" as const,
    }));
    const { poolQuery, service } = harness({
      createOrResendInvitation: resend as AccountRepositories["createOrResendInvitation"],
      requireActiveOrganizationCapability:
        requireCapability as AccountRepositories["requireActiveOrganizationCapability"],
      revokeInvitation: revoke as AccountRepositories["revokeInvitation"],
    });
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          email: "invited@example.test",
          id: "invitation-1",
          role: "editor",
          status: "pending",
        },
      ],
    });

    await service.resendInvitation(context, "invitation-1");
    await service.revokeInvitation(context, "invitation-1");

    expect(resend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: "invited@example.test",
        invitationId: "invitation-1",
        organizationId: "org-1",
        outboxIdempotencyKey: expect.stringMatching(/^invitation:[0-9a-f]{64}$/u),
      }),
    );
    expect(revoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invitationId: "invitation-1", organizationId: "org-1" }),
    );
  });

  it("delegates only parsed callback continuations and refuses missing acceptance state", async () => {
    const { actionExchange, service } = harness();
    const continuationId = "00000000-0000-4000-8000-000000000099";
    const secret = "A".repeat(43);
    const cookieHeader = `esmii.invitation=${continuationId}.${secret}`;
    const request = {
      headers: { cookie: cookieHeader },
      id: "request-callback-1",
    } as FastifyRequest;
    const continuation = {
      continuationId,
      presentedSecretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
    };

    await expect(service.getAuthResult(request)).resolves.toEqual({ state: "invalid" });
    await expect(service.getInvitation(context.principal, request)).resolves.toEqual({
      state: "needs_authentication",
    });
    await expect(service.acceptInvitation(context)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      service.acceptInvitation({ ...context, idempotencyKey: null }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(actionExchange.getAuthResult).toHaveBeenCalledWith(request);
    expect(actionExchange.getInvitation).toHaveBeenCalledWith(
      context.principal,
      request,
      continuation,
    );
  });

  it("accepts only through the parsed, hash-authenticated invitation continuation", async () => {
    const acceptanceVersion = "00000000-0000-4000-8000-000000000088";
    const acceptFromContinuation = vi.fn(
      async (
        _pool: DatabaseClient["pool"],
        _input: Parameters<AccountRepositories["acceptInvitationFromContinuation"]>[1],
      ) => {
        void _pool;
        void _input;
        return { organizationId: "org-accepted", version: acceptanceVersion };
      },
    );
    const { realtime, service } = harness({
      acceptInvitationFromContinuation:
        acceptFromContinuation as AccountRepositories["acceptInvitationFromContinuation"],
    });
    const continuationId = "00000000-0000-4000-8000-000000000099";
    const secret = "B".repeat(43);

    await service.acceptInvitation({
      ...context,
      cookieHeader: `esmii.invitation=${continuationId}.${secret}`,
    });

    expect(acceptFromContinuation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        authorizationIdempotencyKey: expect.stringMatching(/^authorization:[0-9a-f]{64}$/u),
        continuationId,
        environment: "test",
        presentedSecretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
        userId: context.principal.userId,
      }),
    );
    expect(realtime.invalidateOrganization).toHaveBeenCalledWith({
      organizationId: "org-accepted",
      version: acceptanceVersion,
    });
  });
});
