import type { EmailTransport } from "@esmii/email";
import type { StorageAdapter } from "@esmii/storage";

/** Narrow application boundaries used by authentication and account services. */
export interface AuthenticatedPrincipal {
  sessionId: string;
  userId: string;
}

export interface AuthenticationRequest {
  cookieHeader?: string;
  requestId: string;
}

/** Prompt 03 owns the concrete Better Auth implementation. */
export interface AuthenticationSeam {
  authenticate(request: AuthenticationRequest): Promise<AuthenticatedPrincipal | null>;
}

export interface JobRuntimeSeam {
  close(): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
}

export interface RealtimeInvalidation {
  resourceId: string;
  resourceVersion: string;
  scopeId: string;
}

/** Prompt 03 may publish only post-commit invalidation hints through this seam. */
export interface RealtimePublisherSeam {
  publish(invalidation: Readonly<RealtimeInvalidation>): Promise<void>;
}

export interface ServerCapabilities {
  authentication: AuthenticationSeam;
  email: EmailTransport;
  jobs: JobRuntimeSeam;
  realtime: RealtimePublisherSeam;
  storage: StorageAdapter;
}
