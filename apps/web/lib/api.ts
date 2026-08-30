export type OrganizationRole = "owner" | "editor" | "member";
export type ProviderId = "google" | "microsoft" | "apple";
export type ProviderMode = "oauth" | "mock";

export const apiPaths = {
  acceptInvitation: "/api/invitation/accept",
  accountProfile: "/api/account/profile",
  accountProviders: "/api/account/providers",
  authResult: "/api/auth/result",
  deleteOrganization: "/api/organization/delete",
  invitation: "/api/invitation",
  invitations: "/api/organization/invitations",
  logout: "/api/account/logout",
  magicLinkRequest: "/api/auth/magic-link/request",
  members: "/api/organization/members",
  mockSocial: "/api/auth/mock-social",
  organization: "/api/organization",
  organizations: "/api/organizations",
  publicConfig: "/api/public/config",
  revokeOtherSessions: "/api/account/sessions/revoke-others",
  sessions: "/api/account/sessions",
  socialSignIn: "/api/auth/sign-in/social",
  switchOrganization: "/api/organizations/switch",
  viewer: "/api/viewer",
  invitationAction: (invitationId: string, action: "resend" | "revoke") =>
    `/api/organization/invitations/${encodeURIComponent(invitationId)}/${action}`,
  member: (memberId: string) => `/api/organization/members/${encodeURIComponent(memberId)}`,
  grantOwner: (memberId: string) =>
    `/api/organization/members/${encodeURIComponent(memberId)}/grant-owner`,
  provider: (provider: ProviderId) => `/api/account/providers/${provider}`,
  providerLink: (provider: ProviderId) => `/api/account/providers/${provider}/link`,
  session: (sessionId: string) => `/api/account/sessions/${encodeURIComponent(sessionId)}`,
} as const;

export interface PublicProvider {
  id: ProviderId;
  enabled: boolean;
  mode: ProviderMode;
}

export interface PublicConfig {
  applicationName: string;
  providers: PublicProvider[];
}

export interface UserSummary {
  id: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
}

export interface OrganizationSummary {
  id: string;
  displayName: string;
  locator: string;
  role: OrganizationRole;
}

export interface ViewerResponse {
  user: UserSummary;
  organizations: OrganizationSummary[];
  activeOrganization: OrganizationSummary | null;
}

export interface MemberSummary {
  id: string;
  displayName: string;
  email: string;
  role: OrganizationRole;
  joinedAt: string;
  isCurrentUser: boolean;
  emailVerified: boolean;
}

export interface MembersResponse {
  items: MemberSummary[];
  total: number;
  nextCursor: string | null;
}

export type InvitationStatus = "pending" | "expired" | "accepted" | "revoked";

export interface InvitationSummary {
  id: string;
  email: string;
  role: Exclude<OrganizationRole, "owner">;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
}

export interface InvitationsResponse {
  items: InvitationSummary[];
  total: number;
  pendingCount: number;
  nextCursor: string | null;
}

export interface SessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  clientLabel: string;
}

export interface SessionsResponse {
  items: SessionSummary[];
}

export interface AccountProviderSummary {
  id: ProviderId;
  label: string;
  configured: boolean;
  connected: boolean;
  canDisconnect: boolean;
}

export interface AccountProvidersResponse {
  items: AccountProviderSummary[];
}

export type InvitationAcceptanceState =
  | "needs_authentication"
  | "ready"
  | "wrong_email"
  | "expired"
  | "revoked"
  | "consumed"
  | "organization_deleted"
  | "accepted";

export interface InvitationResponse {
  state: InvitationAcceptanceState;
  organization?: {
    displayName: string;
  };
  role?: Exclude<OrganizationRole, "owner">;
}

export type AuthResultState =
  | "expired"
  | "used"
  | "superseded"
  | "invalid"
  | "provider_cancelled"
  | "provider_failed"
  | "unsafe_link_rejected";

export interface AuthResultResponse {
  state: AuthResultState;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
}

interface ErrorEnvelope {
  error?: Partial<ApiErrorBody>;
}

interface RedirectResponse {
  redirectUrl?: string;
  url?: string;
}

export class ApiRequestError extends Error {
  public readonly code: string;
  public readonly requestId: string | null;
  public readonly status: number;

  public constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const providerAuthorizationOrigins: Readonly<Record<ProviderId, string>> = {
  apple: "https://appleid.apple.com",
  google: "https://accounts.google.com",
  microsoft: "https://login.microsoftonline.com",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }

  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function apiErrorFrom(response: Response, payload: unknown): ApiRequestError {
  const envelope = isRecord(payload) ? (payload as ErrorEnvelope) : undefined;
  const error = envelope?.error;
  const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
  const message =
    typeof error?.message === "string" ? error.message : "The request could not be completed.";
  const requestId = typeof error?.requestId === "string" ? error.requestId : null;
  return new ApiRequestError(response.status, code, message, requestId);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers,
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw apiErrorFrom(response, payload);
  }

  return payload as T;
}

export function createIdempotencyKey(scope: string): string {
  return `${scope}:${crypto.randomUUID()}`;
}

function jsonRequest(
  method: "DELETE" | "PATCH" | "POST",
  body?: unknown,
  key?: string,
): RequestInit {
  const headers = new Headers();
  if (key !== undefined) {
    headers.set("Idempotency-Key", key);
  }

  const base = { headers, method } satisfies RequestInit;
  return body === undefined ? base : { ...base, body: JSON.stringify(body) };
}

export function postJson<T>(path: string, body?: unknown, key?: string): Promise<T> {
  return apiRequest<T>(path, jsonRequest("POST", body, key));
}

export function patchJson<T>(path: string, body: unknown, key?: string): Promise<T> {
  return apiRequest<T>(path, jsonRequest("PATCH", body, key));
}

export function deleteJson<T>(path: string, body?: unknown, key?: string): Promise<T> {
  return apiRequest<T>(path, jsonRequest("DELETE", body, key));
}

function getRedirectTarget(response: RedirectResponse): string | null {
  const target = response.redirectUrl ?? response.url;
  return typeof target === "string" && target.length > 0 ? target : null;
}

export function navigateToTrustedRedirect(rawTarget: string, provider: ProviderId): void {
  let target: URL;
  try {
    target = new URL(rawTarget, window.location.origin);
  } catch {
    throw new ApiRequestError(502, "UNTRUSTED_REDIRECT", "Sign-in could not be started.", null);
  }
  const isSameOrigin = target.origin === window.location.origin;
  const isProviderOrigin = target.origin === providerAuthorizationOrigins[provider];

  if (!isSameOrigin && !isProviderOrigin) {
    throw new ApiRequestError(502, "UNTRUSTED_REDIRECT", "Sign-in could not be started.", null);
  }

  window.location.assign(target.href);
}

export async function startSocialSignIn(provider: PublicProvider): Promise<void> {
  const response =
    provider.mode === "mock"
      ? await postJson<RedirectResponse>(apiPaths.mockSocial, {
          provider: provider.id,
          scenario: "success",
        })
      : await postJson<RedirectResponse>(apiPaths.socialSignIn, {
          callbackURL: "/app",
          provider: provider.id,
        });

  const target = getRedirectTarget(response);
  if (target === null && provider.mode === "mock") {
    window.location.assign("/app");
    return;
  }
  if (target === null) {
    throw new ApiRequestError(502, "MISSING_REDIRECT", "Sign-in could not be started.", null);
  }

  navigateToTrustedRedirect(target, provider.id);
}

export async function startProviderLink(provider: ProviderId): Promise<void> {
  const response = await postJson<RedirectResponse>(apiPaths.providerLink(provider), {
    callbackURL: "/app/account",
  });
  const target = getRedirectTarget(response);
  if (target === null) {
    throw new ApiRequestError(
      502,
      "MISSING_REDIRECT",
      "The sign-in method could not be linked.",
      null,
    );
  }

  navigateToTrustedRedirect(target, provider);
}

export function roleLabel(role: OrganizationRole): string {
  if (role === "owner") return "Owner";
  if (role === "editor") return "Editor";
  return "Member";
}

export function providerLabel(provider: ProviderId): string {
  if (provider === "google") return "Google";
  if (provider === "microsoft") return "Microsoft";
  return "Apple";
}
