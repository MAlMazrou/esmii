const AUTH_CALLBACK_CACHE_CONTROL = "no-store";

export const authCallbackSecurityHeaders = Object.freeze({
  "Cache-Control": AUTH_CALLBACK_CACHE_CONTROL,
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
} as const);

export function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function parseExactOrigin(value: string): URL {
  if (value !== value.trim() || containsAsciiControlCharacter(value)) {
    throw new TypeError("application origin must not contain whitespace or control characters");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("application origin must be an absolute HTTP(S) URL");
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("application origin must be an exact HTTP(S) origin");
  }

  return parsed;
}

export function normalizeApplicationOrigin(value: string): string {
  return parseExactOrigin(value).origin;
}

export function validateCleanSameOriginCallback(
  candidate: string,
  applicationOrigin: string,
): string {
  const origin = parseExactOrigin(applicationOrigin);
  if (
    candidate.length === 0 ||
    candidate !== candidate.trim() ||
    candidate.includes("\\") ||
    containsAsciiControlCharacter(candidate)
  ) {
    throw new TypeError("callback must be a clean same-origin path");
  }

  let callback: URL;
  try {
    callback = new URL(candidate, origin);
  } catch {
    throw new TypeError("callback must be a valid same-origin URL");
  }

  if (
    callback.origin !== origin.origin ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.search !== "" ||
    callback.hash !== "" ||
    !callback.pathname.startsWith("/")
  ) {
    throw new TypeError("callback must be query-free, fragment-free, and same-origin");
  }

  return callback.pathname;
}

export function applyAuthCallbackSecurityHeaders(headers: Headers = new Headers()): Headers {
  for (const [name, value] of Object.entries(authCallbackSecurityHeaders)) {
    headers.set(name, value);
  }
  return headers;
}

export function redactAuthRequestTarget(rawTarget: string): string {
  try {
    const parsed = new URL(rawTarget, "http://request-target.invalid");
    const suffix = parsed.search === "" && parsed.hash === "" ? "" : "?[REDACTED]";
    return `${parsed.pathname}${suffix}`;
  } catch {
    return "[INVALID_REQUEST_TARGET]";
  }
}
