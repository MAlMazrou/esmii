import pino, { type Logger } from "pino";

const redactedPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "authorization",
  "cookie",
  "databaseUrl",
  "valkeyUrl",
  "operationsHealthToken",
  "*.authorization",
  "*.cookie",
  "*.databaseUrl",
  "*.valkeyUrl",
  "*.operationsHealthToken",
];

const redactedActionTarget = "/[REDACTED_ACTION_ROUTE]";

export function sanitizeRequestTarget(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  const path = value.split(/[?#]/u, 1)[0] || "/";
  if (
    path === "/api/auth" ||
    path.startsWith("/api/auth/") ||
    path === "/api/invitation" ||
    path.startsWith("/api/invitation/") ||
    path === "/accept-invitation" ||
    path.startsWith("/accept-invitation/")
  ) {
    return redactedActionTarget;
  }
  return path;
}

export function serializeRequestForLog(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") return { url: "/" };
  const request = value as {
    headers?: { host?: unknown };
    method?: unknown;
    socket?: { remoteAddress?: unknown; remotePort?: unknown };
    url?: unknown;
  };

  return {
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    url: sanitizeRequestTarget(request.url),
    ...(typeof request.headers?.host === "string" ? { host: request.headers.host } : {}),
    ...(typeof request.socket?.remoteAddress === "string"
      ? { remoteAddress: request.socket.remoteAddress }
      : {}),
    ...(typeof request.socket?.remotePort === "number"
      ? { remotePort: request.socket.remotePort }
      : {}),
  };
}

export function createApplicationLogger(level = "info"): Logger {
  return pino({
    level,
    redact: {
      censor: "[REDACTED]",
      paths: redactedPaths,
    },
    serializers: { req: serializeRequestForLog },
  });
}

export const applicationLogRedactionPaths = redactedPaths;
