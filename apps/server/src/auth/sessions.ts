export interface SessionPresentationSource {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly id: string;
  readonly ipAddress?: string | null;
  readonly updatedAt: Date;
  readonly userAgent?: string | null;
  readonly userId: string;
}

export interface SafeActiveSession {
  readonly createdAt: string;
  readonly current: boolean;
  readonly expiresAt: string;
  readonly id: string;
  readonly ipAddress: string | null;
  readonly updatedAt: string;
  readonly userAgent: string | null;
}

export function serializeSafeSession<T extends SessionPresentationSource>(
  session: T,
  currentSessionId: string,
): SafeActiveSession {
  return {
    createdAt: session.createdAt.toISOString(),
    current: session.id === currentSessionId,
    expiresAt: session.expiresAt.toISOString(),
    id: session.id,
    ipAddress: session.ipAddress ?? null,
    updatedAt: session.updatedAt.toISOString(),
    userAgent: session.userAgent ?? null,
  };
}

export function serializeSafeSessions<T extends SessionPresentationSource>(
  sessions: readonly T[],
  currentSessionId: string,
): SafeActiveSession[] {
  return sessions
    .map((session) => serializeSafeSession(session, currentSessionId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export interface OwnedSessionRevocationStore {
  revokeOtherOwnedSessions(input: {
    readonly currentSessionId: string;
    readonly userId: string;
  }): Promise<number>;
  revokeOwnedSessionById(input: {
    readonly currentSessionId: string;
    readonly sessionId: string;
    readonly userId: string;
  }): Promise<boolean>;
}

export type OwnedSessionRevocationResult = "current-session" | "not-found" | "revoked";

export async function revokeOwnedSessionById(
  store: OwnedSessionRevocationStore,
  input: {
    readonly currentSessionId: string;
    readonly sessionId: string;
    readonly userId: string;
  },
): Promise<OwnedSessionRevocationResult> {
  if (input.sessionId === input.currentSessionId) {
    return "current-session";
  }

  return (await store.revokeOwnedSessionById(input)) ? "revoked" : "not-found";
}

export async function revokeOtherOwnedSessions(
  store: OwnedSessionRevocationStore,
  input: {
    readonly currentSessionId: string;
    readonly userId: string;
  },
): Promise<number> {
  return store.revokeOtherOwnedSessions(input);
}
