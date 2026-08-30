import {
  createOrganizationAccessRevokedPayload,
  createOrganizationInvalidationPayload,
  type OrganizationAccessRevokedPayload,
  type OrganizationAccessRevokedReason,
  type OrganizationInvalidationPayload,
} from "./events.js";
import { organizationRoom, type AuthorizedOrganizationHandshake } from "./rooms.js";

export type OrganizationAccessRevocationTarget =
  | { readonly kind: "organization" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "user"; readonly userId: string };

export interface OrganizationInvalidationInput {
  readonly organizationId: string;
  readonly version: string;
}

export interface OrganizationAccessRevocationInput {
  readonly organizationId: string;
  readonly reason: OrganizationAccessRevokedReason;
  readonly target: OrganizationAccessRevocationTarget;
}

export interface OrganizationAudienceSocket {
  readonly authorization: AuthorizedOrganizationHandshake;
  disconnect(): void;
  emitAccessRevoked(payload: OrganizationAccessRevokedPayload): void;
  leaveRoom(room: string): Promise<void>;
}

export interface OrganizationRealtimeAudience {
  emitInvalidation(room: string, payload: OrganizationInvalidationPayload): void;
  socketsIn(room: string): Promise<readonly OrganizationAudienceSocket[]>;
}

export interface OrganizationRealtimePublisher {
  invalidateOrganization(input: OrganizationInvalidationInput): Promise<void>;
  revokeOrganizationAccess(input: OrganizationAccessRevocationInput): Promise<number>;
}

const safeServerIdPattern = /^[A-Za-z0-9_-]{1,160}$/u;

function requireSafeServerId(value: string, name: string): void {
  if (!safeServerIdPattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function matchesTarget(
  authorization: AuthorizedOrganizationHandshake,
  target: OrganizationAccessRevocationTarget,
): boolean {
  switch (target.kind) {
    case "organization":
      return true;
    case "session":
      return authorization.sessionId === target.sessionId;
    case "user":
      return authorization.userId === target.userId;
  }
}

function validateTarget(target: OrganizationAccessRevocationTarget): void {
  if (target.kind === "session") {
    requireSafeServerId(target.sessionId, "sessionId");
  } else if (target.kind === "user") {
    requireSafeServerId(target.userId, "userId");
  }
}

async function revokeSocketAccess(
  socket: OrganizationAudienceSocket,
  room: string,
  payload: OrganizationAccessRevokedPayload,
): Promise<void> {
  try {
    socket.emitAccessRevoked(payload);
  } finally {
    try {
      await socket.leaveRoom(room);
    } finally {
      socket.disconnect();
    }
  }
}

export function createOrganizationRealtimePublisher(
  audience: OrganizationRealtimeAudience,
): OrganizationRealtimePublisher {
  return Object.freeze({
    async invalidateOrganization(input: OrganizationInvalidationInput): Promise<void> {
      const room = organizationRoom(input.organizationId);
      audience.emitInvalidation(room, createOrganizationInvalidationPayload(input.version));
    },

    async revokeOrganizationAccess(input: OrganizationAccessRevocationInput): Promise<number> {
      validateTarget(input.target);
      const room = organizationRoom(input.organizationId);
      const payload = createOrganizationAccessRevokedPayload(input.reason);
      const sockets = (await audience.socketsIn(room)).filter(
        (socket) =>
          socket.authorization.organizationId === input.organizationId &&
          socket.authorization.room === room &&
          matchesTarget(socket.authorization, input.target),
      );

      const results = await Promise.allSettled(
        sockets.map((socket) => revokeSocketAccess(socket, room, payload)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "failed to revoke one or more realtime connections");
      }
      return sockets.length;
    },
  });
}
