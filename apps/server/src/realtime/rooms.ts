import type { AuthenticationSeam } from "../account/seams.js";

export interface RealtimeOrganizationAccess {
  activeOrganizationId: string | null;
  membershipActive: boolean;
}

export type RealtimeAccessResolver = (input: {
  sessionId: string;
  userId: string;
}) => Promise<RealtimeOrganizationAccess>;

export interface AuthorizedOrganizationHandshake {
  readonly organizationId: string;
  readonly room: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface OrganizationRoomJoiner {
  join(room: string): Promise<void> | void;
}

export function organizationRoom(organizationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(organizationId)) {
    throw new TypeError("organizationId is invalid");
  }
  return `organization:${organizationId}`;
}

export async function authorizeOrganizationHandshake(
  authentication: AuthenticationSeam,
  resolveAccess: RealtimeAccessResolver,
  cookieHeader: string | undefined,
  requestId: string,
): Promise<AuthorizedOrganizationHandshake | null> {
  const principal = await authentication.authenticate({
    ...(cookieHeader === undefined ? {} : { cookieHeader }),
    requestId,
  });
  if (principal === null) return null;
  const access = await resolveAccess(principal);
  if (!access.membershipActive || access.activeOrganizationId === null) return null;
  return {
    organizationId: access.activeOrganizationId,
    room: organizationRoom(access.activeOrganizationId),
    sessionId: principal.sessionId,
    userId: principal.userId,
  };
}

export async function joinAuthorizedOrganizationRoom(
  socket: OrganizationRoomJoiner,
  authorization: AuthorizedOrganizationHandshake,
): Promise<void> {
  await socket.join(authorization.room);
}
