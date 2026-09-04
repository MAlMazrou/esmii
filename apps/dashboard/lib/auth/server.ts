import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";

import { parseDashboardAuthConfig, type DashboardAuthConfig } from "../config/server.ts";
import {
  createOperatorRateLimitStorage,
  openOperatorDatabase,
  readOperatorSecurityState,
  writeOperatorAudit,
  writeOperatorSecurityState,
  type OperatorDatabase,
} from "./database.ts";

export const OPERATOR_AUTH_BASE_PATH = "/api/operator-auth";
export const OPERATOR_SESSION_SECONDS = 8 * 60 * 60;
export const OPERATOR_AUTH_BODY_LIMIT_BYTES = 2_048;

const textEncoder = new TextEncoder();

export async function readBoundedOperatorAuthBody(request: Request): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > OPERATOR_AUTH_BODY_LIMIT_BYTES)
  ) {
    return null;
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > OPERATOR_AUTH_BODY_LIMIT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function normalizeOperatorTotpBody(body: Uint8Array | null): Uint8Array {
  if (body !== null) {
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const code = (parsed as { readonly code?: unknown }).code;
        if (typeof code === "string" && /^\d{6}$/u.test(code)) {
          return textEncoder.encode(JSON.stringify({ code, trustDevice: false }));
        }
      }
    } catch {
      // A bounded invalid payload is deliberately forwarded through Better Auth's limiter.
    }
  }
  return textEncoder.encode(JSON.stringify({ code: "", trustDevice: false }));
}

export function normalizeOperatorSignInBody(body: Uint8Array | null): Uint8Array {
  if (body !== null) {
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as { readonly email?: unknown; readonly password?: unknown };
        if (typeof record.email === "string" && typeof record.password === "string") {
          return textEncoder.encode(
            JSON.stringify({ email: record.email, password: record.password, rememberMe: true }),
          );
        }
      }
    } catch {
      // A bounded invalid payload is deliberately forwarded through Better Auth's limiter.
    }
  }
  return textEncoder.encode(JSON.stringify({ email: "", password: "", rememberMe: true }));
}

export function normalizeOperatorPasswordChangeBody(body: Uint8Array | null): Uint8Array {
  if (body !== null) {
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as {
          readonly currentPassword?: unknown;
          readonly newPassword?: unknown;
        };
        if (
          typeof record.currentPassword === "string" &&
          record.currentPassword.length <= 128 &&
          typeof record.newPassword === "string" &&
          record.newPassword.length >= 14 &&
          record.newPassword.length <= 128 &&
          record.newPassword !== record.currentPassword
        ) {
          return textEncoder.encode(
            JSON.stringify({
              currentPassword: record.currentPassword,
              newPassword: record.newPassword,
              revokeOtherSessions: true,
            }),
          );
        }
      }
    } catch {
      // A bounded invalid payload is deliberately forwarded as a safe rejection.
    }
  }
  return textEncoder.encode(
    JSON.stringify({ currentPassword: "", newPassword: "", revokeOtherSessions: true }),
  );
}

function rebuildAuthRequest(request: Request, body: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const bodyBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(bodyBuffer).set(body);
  return new Request(request.url, {
    body: bodyBuffer,
    headers,
    method: request.method,
    signal: request.signal,
  });
}

export function buildOperatorAuthOptions(
  config: DashboardAuthConfig,
  database: OperatorDatabase,
  options: { readonly provisioning?: boolean } = {},
): BetterAuthOptions {
  return {
    advanced: {
      cookiePrefix: `esmii-dashboard-${config.environment}`,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "strict",
        secure: config.origin.startsWith("https://"),
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: config.origin.startsWith("https://"),
    },
    appName: `Esmii ${config.environment} monitoring`,
    basePath: OPERATOR_AUTH_BASE_PATH,
    baseURL: config.origin,
    database,
    emailAndPassword: {
      disableSignUp: options.provisioning !== true,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 14,
      requireEmailVerification: false,
    },
    plugins: [
      twoFactor({
        accountLockout: {
          durationSeconds: 15 * 60,
          enabled: true,
          maxFailedAttempts: 5,
        },
        allowPasswordless: false,
        issuer: `Esmii ${config.environment} monitoring`,
        skipVerificationOnEnable: false,
        trustDeviceMaxAge: 1,
        twoFactorCookieMaxAge: 10 * 60,
      }),
    ],
    rateLimit: {
      customStorage: createOperatorRateLimitStorage(database),
      customRules: {
        "/sign-in/email": { max: 5, window: 15 * 60 },
        "/two-factor/verify-totp": { max: 5, window: 15 * 60 },
      },
      enabled: true,
      max: 20,
      storage: "database",
      window: 60,
    },
    secret: config.secret,
    session: {
      cookieCache: { enabled: false },
      disableSessionRefresh: true,
      expiresIn: OPERATOR_SESSION_SECONDS,
      freshAge: 10 * 60,
      updateAge: 60 * 60,
    },
    trustedOrigins: [config.origin],
  };
}

export interface OperatorAuthRealm {
  readonly auth: Auth;
  readonly config: DashboardAuthConfig;
  readonly database: OperatorDatabase;
}

export function createOperatorAuthRealm(options: {
  readonly config: DashboardAuthConfig;
  readonly database?: OperatorDatabase;
  readonly provisioning?: boolean;
}): OperatorAuthRealm {
  const database = options.database ?? openOperatorDatabase(options.config.databaseFile);
  const auth = betterAuth(
    buildOperatorAuthOptions(
      options.config,
      database,
      options.provisioning === undefined ? {} : { provisioning: options.provisioning },
    ),
  );
  return { auth, config: options.config, database };
}

let singleton: OperatorAuthRealm | undefined;

export function getOperatorAuthRealm(): OperatorAuthRealm {
  singleton ??= createOperatorAuthRealm({ config: parseDashboardAuthConfig() });
  return singleton;
}

export function resetOperatorAuthRealmForTests(): void {
  singleton = undefined;
}

const PUBLIC_AUTH_REQUESTS = new Set([
  "GET /bootstrap-status",
  "POST /change-password",
  "POST /sign-in/email",
  "POST /sign-out",
  "POST /two-factor/verify-totp",
]);

export function isPublicOperatorAuthRequestAllowed(method: string, pathname: string): boolean {
  const suffix = pathname.startsWith(OPERATOR_AUTH_BASE_PATH)
    ? pathname.slice(OPERATOR_AUTH_BASE_PATH.length) || "/"
    : pathname;
  return PUBLIC_AUTH_REQUESTS.has(`${method.toUpperCase()} ${suffix}`);
}

const TOKEN_FREE_AUTH_SUCCESS = {
  "POST /change-password": { passwordChanged: true },
  "POST /sign-in/email": { twoFactorRequired: true },
  "POST /sign-out": { signedOut: true },
  "POST /two-factor/verify-totp": { authenticated: true },
} as const;

type TokenFreeAuthAction = keyof typeof TOKEN_FREE_AUTH_SUCCESS;

export function projectTokenFreeAuthSuccess(
  response: Response,
  action: TokenFreeAuthAction,
  requestId: string,
): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-request-id", requestId);
  return Response.json(TOKEN_FREE_AUTH_SUCCESS[action], {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function projectGenericAuthFailure(response: Response, requestId: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  const rawRetryAfter = response.headers.get("x-retry-after");
  if (
    response.status === 429 &&
    rawRetryAfter !== null &&
    /^\d+$/u.test(rawRetryAfter) &&
    Number(rawRetryAfter) >= 1 &&
    Number(rawRetryAfter) <= 15 * 60
  ) {
    headers.set("retry-after", rawRetryAfter);
  }
  return Response.json(
    { error: { code: "AUTHENTICATION_FAILED", message: "Authentication failed", requestId } },
    { headers, status: response.status === 429 ? 429 : 401 },
  );
}

export async function handleOperatorAuthRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requestId = request.headers.get("x-request-id")?.slice(0, 96) || crypto.randomUUID();
  if (!isPublicOperatorAuthRequestAllowed(request.method, url.pathname)) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Not found", requestId } },
      { headers: { "cache-control": "no-store" }, status: 404 },
    );
  }
  const action = `${request.method.toUpperCase()} ${url.pathname.slice(OPERATOR_AUTH_BASE_PATH.length)}`;
  let realm: OperatorAuthRealm | null = null;
  try {
    let forwardedRequest = request;
    if (request.method.toUpperCase() === "POST") {
      const boundedBody = await readBoundedOperatorAuthBody(request);
      const safeBody =
        action === "POST /two-factor/verify-totp"
          ? normalizeOperatorTotpBody(boundedBody)
          : action === "POST /sign-in/email"
            ? normalizeOperatorSignInBody(boundedBody)
            : action === "POST /change-password"
              ? normalizeOperatorPasswordChangeBody(boundedBody)
              : (boundedBody ?? textEncoder.encode("{}"));
      forwardedRequest = rebuildAuthRequest(request, safeBody);
    }
    realm = getOperatorAuthRealm();
    if (action === "GET /bootstrap-status") {
      const session = await realm.auth.api.getSession({ headers: request.headers });
      if (session === null) {
        return Response.json(
          { error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId } },
          { headers: { "cache-control": "no-store" }, status: 401 },
        );
      }
      const state = readOperatorSecurityState(realm.database, session.user.id);
      return Response.json(
        {
          passwordChangeRequired: state?.passwordChanged !== true,
          totpEnrollmentVerified: state?.totpEnrollmentVerified === true,
        },
        { headers: { "cache-control": "no-store" }, status: 200 },
      );
    }

    const preChangeSession =
      action === "POST /change-password"
        ? await realm.auth.api.getSession({ headers: forwardedRequest.headers })
        : null;
    const response = await realm.auth.handler(forwardedRequest);
    let outcome = response.ok ? "success" : `rejected_${response.status}`;
    if (action === "POST /sign-in/email" && response.ok) {
      const payload = (await response
        .clone()
        .json()
        .catch(() => null)) as { readonly twoFactorRedirect?: unknown } | null;
      if (payload?.twoFactorRedirect !== true) {
        outcome = "totp_not_enrolled";
        writeOperatorAudit(realm.database, { action, outcome, requestId });
        return Response.json(
          {
            error: {
              code: "TOTP_REQUIRED",
              message: "This operator account is not fully provisioned",
              requestId,
            },
          },
          { headers: { "cache-control": "no-store" }, status: 403 },
        );
      }
    }
    if (action === "POST /change-password" && response.ok && preChangeSession !== null) {
      writeOperatorSecurityState(realm.database, preChangeSession.user.id, {
        passwordChanged: true,
      });
    }
    if (
      !response.ok &&
      (action === "POST /change-password" ||
        action === "POST /sign-in/email" ||
        action === "POST /two-factor/verify-totp")
    ) {
      writeOperatorAudit(realm.database, { action, outcome, requestId });
      return projectGenericAuthFailure(response, requestId);
    }
    writeOperatorAudit(realm.database, { action, outcome, requestId });
    if (response.ok && action in TOKEN_FREE_AUTH_SUCCESS) {
      return projectTokenFreeAuthSuccess(response, action as TokenFreeAuthAction, requestId);
    }
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-request-id", requestId);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    if (realm !== null) {
      try {
        writeOperatorAudit(realm.database, { action, outcome: "error", requestId });
      } catch {
        // Authentication failures must still resolve to the same generic response.
      }
    }
    return Response.json(
      {
        error: {
          code: "AUTH_UNAVAILABLE",
          message: "Authentication is temporarily unavailable",
          requestId,
        },
      },
      { headers: { "cache-control": "no-store" }, status: 503 },
    );
  }
}

export async function requireOperatorSession(
  headers: Headers,
): Promise<{ readonly id: string; readonly email: string } | null> {
  const { auth } = getOperatorAuthRealm();
  const session = await auth.api.getSession({ headers });
  if (session === null) return null;
  const user = session.user as typeof session.user & { readonly twoFactorEnabled?: boolean };
  if (user.twoFactorEnabled !== true) return null;
  const state = readOperatorSecurityState(getOperatorAuthRealm().database, user.id);
  if (state?.passwordChanged !== true || state.totpEnrollmentVerified !== true) return null;
  return { email: user.email, id: user.id };
}
