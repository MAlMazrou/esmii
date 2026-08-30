import { describe, expect, it, vi } from "vitest";

import type { AuthenticationSeam } from "../src/account/seams.js";
import {
  organizationAccessRevokedEvent,
  organizationInvalidationEvent,
} from "../src/realtime/events.js";
import {
  createOrganizationRealtimePublisher,
  type OrganizationAudienceSocket,
  type OrganizationRealtimeAudience,
} from "../src/realtime/publisher.js";
import {
  authorizeOrganizationHandshake,
  joinAuthorizedOrganizationRoom,
  type AuthorizedOrganizationHandshake,
  type RealtimeAccessResolver,
} from "../src/realtime/rooms.js";
import {
  isAllowedRealtimeOrigin,
  registerOrganizationRealtimeHandlers,
  type OrganizationHandshakeSocket,
  type OrganizationSocketRegistrationPort,
} from "../src/realtime/server.js";

const authorizedOrganization = "org_authorized";

function authorization(
  overrides: Partial<AuthorizedOrganizationHandshake> = {},
): AuthorizedOrganizationHandshake {
  return {
    organizationId: authorizedOrganization,
    room: `organization:${authorizedOrganization}`,
    sessionId: "session_authorized",
    userId: "user_authorized",
    ...overrides,
  };
}

class CapturedAudienceSocket implements OrganizationAudienceSocket {
  public readonly authorization: AuthorizedOrganizationHandshake;
  public readonly calls: string[] = [];
  public readonly payloads: unknown[] = [];

  public constructor(value: AuthorizedOrganizationHandshake) {
    this.authorization = value;
  }

  public disconnect(): void {
    this.calls.push("disconnect");
  }

  public emitAccessRevoked(payload: unknown): void {
    this.calls.push(organizationAccessRevokedEvent);
    this.payloads.push(payload);
  }

  public async leaveRoom(room: string): Promise<void> {
    this.calls.push(`leave:${room}`);
  }
}

describe("Socket.IO organization handshake", () => {
  it("derives the only allowed room from the authenticated server session", async () => {
    const authentication: AuthenticationSeam = {
      authenticate: vi.fn(async () => ({
        sessionId: "session_authorized",
        userId: "user_authorized",
      })),
    };
    const resolveAccess: RealtimeAccessResolver = vi.fn(async () => ({
      activeOrganizationId: authorizedOrganization,
      membershipActive: true,
    }));

    const result = await authorizeOrganizationHandshake(
      authentication,
      resolveAccess,
      "session=opaque; organizationId=org_client_supplied",
      "request_synthetic",
    );

    expect(authentication.authenticate).toHaveBeenCalledWith({
      cookieHeader: "session=opaque; organizationId=org_client_supplied",
      requestId: "request_synthetic",
    });
    expect(resolveAccess).toHaveBeenCalledWith({
      sessionId: "session_authorized",
      userId: "user_authorized",
    });
    expect(result).toEqual(authorization());
  });

  it("fails closed for missing authentication, inactive membership, or an unsafe room id", async () => {
    const noAuthentication: AuthenticationSeam = { authenticate: async () => null };
    const resolver = vi.fn<RealtimeAccessResolver>(async () => ({
      activeOrganizationId: authorizedOrganization,
      membershipActive: true,
    }));
    await expect(
      authorizeOrganizationHandshake(
        noAuthentication,
        resolver,
        undefined,
        "request_unauthenticated",
      ),
    ).resolves.toBeNull();
    expect(resolver).not.toHaveBeenCalled();

    const authentication: AuthenticationSeam = {
      authenticate: async () => ({ sessionId: "session_authorized", userId: "user_authorized" }),
    };
    await expect(
      authorizeOrganizationHandshake(
        authentication,
        async () => ({ activeOrganizationId: authorizedOrganization, membershipActive: false }),
        "session=opaque",
        "request_inactive",
      ),
    ).resolves.toBeNull();
    await expect(
      authorizeOrganizationHandshake(
        authentication,
        async () => ({ activeOrganizationId: "../org", membershipActive: true }),
        "session=opaque",
        "request_unsafe",
      ),
    ).rejects.toThrow("organizationId is invalid");
  });

  it("joins exactly the pre-authorized room", async () => {
    const join = vi.fn(async () => undefined);
    await joinAuthorizedOrganizationRoom({ join }, authorization());
    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith("organization:org_authorized");
  });

  it("registers one server authorization middleware and no client join handler", async () => {
    type Middleware = Parameters<OrganizationSocketRegistrationPort["use"]>[0];
    type ConnectionListener = Parameters<OrganizationSocketRegistrationPort["onConnection"]>[0];
    let middleware: Middleware | undefined;
    let connectionListener: ConnectionListener | undefined;
    const registration: OrganizationSocketRegistrationPort = {
      onConnection(listener) {
        connectionListener = listener;
      },
      use(value) {
        middleware = value;
      },
    };
    const authentication: AuthenticationSeam = {
      authenticate: async () => ({
        sessionId: "session_authorized",
        userId: "user_authorized",
      }),
    };
    registerOrganizationRealtimeHandlers(
      registration,
      {
        authentication,
        resolveAccess: async () => ({
          activeOrganizationId: authorizedOrganization,
          membershipActive: true,
        }),
      },
      () => "request_server_generated",
    );
    if (middleware === undefined || connectionListener === undefined) {
      throw new Error("realtime handlers were not registered");
    }

    const socket: OrganizationHandshakeSocket = {
      data: {},
      disconnect: vi.fn(),
      handshake: { headers: { cookie: "session=opaque" } },
      join: vi.fn(async () => undefined),
    };
    const next = vi.fn();
    await middleware(socket, next);
    connectionListener(socket);
    await Promise.resolve();

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.authorization).toEqual(authorization());
    expect(socket.join).toHaveBeenCalledOnce();
    expect(socket.join).toHaveBeenCalledWith("organization:org_authorized");
  });

  it("accepts only the exact same application origin", () => {
    expect(isAllowedRealtimeOrigin("https://esmii.app", "https://esmii.app")).toBe(true);
    expect(isAllowedRealtimeOrigin("https://staging.esmii.app", "https://esmii.app")).toBe(false);
    expect(isAllowedRealtimeOrigin(undefined, "https://esmii.app")).toBe(false);
    expect(isAllowedRealtimeOrigin(["https://esmii.app"], "https://esmii.app")).toBe(false);
  });
});

describe("Socket.IO organization publisher", () => {
  it("emits only a version hint to the server-authorized organization room", async () => {
    const emissions: unknown[] = [];
    const audience: OrganizationRealtimeAudience = {
      emitInvalidation(room, payload) {
        emissions.push({ event: organizationInvalidationEvent, payload, room });
      },
      async socketsIn() {
        return [];
      },
    };
    const publisher = createOrganizationRealtimePublisher(audience);

    await publisher.invalidateOrganization({
      organizationId: authorizedOrganization,
      version: "membership:42",
    });

    expect(emissions).toEqual([
      {
        event: organizationInvalidationEvent,
        payload: { version: "membership:42" },
        room: "organization:org_authorized",
      },
    ]);
    expect(JSON.stringify(emissions)).not.toContain("user_authorized");
  });

  it("notifies, leaves, and disconnects only matching authorized user sockets", async () => {
    const first = new CapturedAudienceSocket(authorization());
    const second = new CapturedAudienceSocket(authorization({ sessionId: "session_second" }));
    const differentUser = new CapturedAudienceSocket(
      authorization({ sessionId: "session_other", userId: "user_other" }),
    );
    const inconsistentRoom = new CapturedAudienceSocket(
      authorization({ organizationId: "org_other", room: "organization:org_other" }),
    );
    const audience: OrganizationRealtimeAudience = {
      emitInvalidation() {},
      async socketsIn() {
        return [first, second, differentUser, inconsistentRoom];
      },
    };
    const publisher = createOrganizationRealtimePublisher(audience);

    await expect(
      publisher.revokeOrganizationAccess({
        organizationId: authorizedOrganization,
        reason: "membership-revoked",
        target: { kind: "user", userId: "user_authorized" },
      }),
    ).resolves.toBe(2);

    for (const socket of [first, second]) {
      expect(socket.calls).toEqual([
        organizationAccessRevokedEvent,
        "leave:organization:org_authorized",
        "disconnect",
      ]);
      expect(socket.payloads).toEqual([{ reason: "membership-revoked" }]);
      expect(JSON.stringify(socket.payloads)).not.toMatch(/org_|session_|user_/u);
    }
    expect(differentUser.calls).toEqual([]);
    expect(inconsistentRoom.calls).toEqual([]);
  });

  it("supports session-only and whole-organization revocation without client room input", async () => {
    const first = new CapturedAudienceSocket(authorization());
    const second = new CapturedAudienceSocket(
      authorization({ sessionId: "session_second", userId: "user_second" }),
    );
    const audience: OrganizationRealtimeAudience = {
      emitInvalidation() {},
      async socketsIn() {
        return [first, second];
      },
    };
    const publisher = createOrganizationRealtimePublisher(audience);

    await expect(
      publisher.revokeOrganizationAccess({
        organizationId: authorizedOrganization,
        reason: "session-revoked",
        target: { kind: "session", sessionId: "session_authorized" },
      }),
    ).resolves.toBe(1);
    expect(first.calls).toHaveLength(3);
    expect(second.calls).toEqual([]);

    await expect(
      publisher.revokeOrganizationAccess({
        organizationId: authorizedOrganization,
        reason: "organization-deleted",
        target: { kind: "organization" },
      }),
    ).resolves.toBe(2);
    expect(second.payloads).toEqual([{ reason: "organization-deleted" }]);
  });

  it("rejects unsafe room, target, and invalidation identifiers", async () => {
    const publisher = createOrganizationRealtimePublisher({
      emitInvalidation() {},
      async socketsIn() {
        return [];
      },
    });

    await expect(
      publisher.invalidateOrganization({ organizationId: "../org", version: "1" }),
    ).rejects.toThrow("organizationId is invalid");
    await expect(
      publisher.invalidateOrganization({ organizationId: authorizedOrganization, version: "" }),
    ).rejects.toThrow("invalidation version is invalid");
    await expect(
      publisher.revokeOrganizationAccess({
        organizationId: authorizedOrganization,
        reason: "session-revoked",
        target: { kind: "session", sessionId: "../session" },
      }),
    ).rejects.toThrow("sessionId is invalid");
  });
});
