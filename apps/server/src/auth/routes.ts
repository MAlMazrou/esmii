import { containsAsciiControlCharacter } from "./security.js";

export type PublicAuthRouteDisposition = "application" | "better-auth" | "deny" | "not-auth";

const AUTH_BASE_PATH = "/api/auth";

const applicationOwnedRoutes = new Set([
  "/account-info",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/get-access-token",
  "/get-session",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/magic-link/request",
  "/magic-link/verify",
  "/refresh-token",
  "/result",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/sign-in/magic-link",
  "/unlink-account",
  "/update-session",
  "/update-user",
]);

const passwordOrAutomaticEmailTokenRoutes = new Set([
  "/change-password",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/sign-in/email",
  "/sign-up/email",
  "/verify-email",
  "/verify-password",
]);

function pathnameFromTarget(rawTarget: string): string | null {
  if (
    !rawTarget.startsWith("/") ||
    rawTarget.startsWith("//") ||
    rawTarget.includes("\\") ||
    rawTarget !== rawTarget.trim() ||
    containsAsciiControlCharacter(rawTarget)
  ) {
    return null;
  }

  try {
    return new URL(rawTarget, "http://auth-route.invalid").pathname;
  } catch {
    return null;
  }
}

function relativeAuthPath(pathname: string): string | null {
  if (pathname === AUTH_BASE_PATH || pathname === `${AUTH_BASE_PATH}/`) {
    return "/";
  }
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
    return null;
  }

  const path = pathname.slice(AUTH_BASE_PATH.length);
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function isProviderCallback(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.length === 3 &&
    segments[1] === "callback" &&
    typeof segments[2] === "string" &&
    (segments[2] === "google" || segments[2] === "microsoft" || segments[2] === "apple")
  );
}

export function classifyPublicAuthRoute(
  method: string,
  rawTarget: string,
): PublicAuthRouteDisposition {
  const pathname = pathnameFromTarget(rawTarget);
  if (pathname === null) {
    return "deny";
  }

  const path = relativeAuthPath(pathname);
  if (path === null) {
    return "not-auth";
  }

  if (path === "/organization" || path.startsWith("/organization/")) {
    return "application";
  }
  if (applicationOwnedRoutes.has(path)) {
    return "application";
  }
  if (passwordOrAutomaticEmailTokenRoutes.has(path) || path.startsWith("/reset-password/")) {
    return "deny";
  }

  const normalizedMethod = method.toUpperCase();
  if (path === "/sign-in/social" && normalizedMethod === "POST") {
    return "better-auth";
  }
  if (path === "/sign-out" && normalizedMethod === "POST") {
    return "better-auth";
  }
  if (isProviderCallback(path) && (normalizedMethod === "GET" || normalizedMethod === "POST")) {
    return "better-auth";
  }

  return "deny";
}

export function mayForwardPublicAuthRouteToBetterAuth(method: string, rawTarget: string): boolean {
  return classifyPublicAuthRoute(method, rawTarget) === "better-auth";
}
