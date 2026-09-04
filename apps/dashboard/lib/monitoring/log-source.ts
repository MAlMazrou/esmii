import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { LogSeverity, SanitizedLogEntry } from "./types.ts";

export interface LogQuery {
  readonly cursor: LogCursor | null;
  readonly limit: number;
  readonly search: string | null;
  readonly service: string | null;
  readonly severity: LogSeverity | null;
}

export interface LogCursor {
  readonly id: string;
  readonly timestamp: string;
}

const MAX_LOG_LINE_BYTES = 16_384;
const STRUCTURED_REDACTION_MAX_DEPTH = 4;
const STRUCTURED_REDACTED = "[redacted-field]";
const STRUCTURED_SENSITIVE_KEYS = new Set([
  "apikey",
  "argv",
  "authorization",
  "body",
  "cmd",
  "code",
  "command",
  "content",
  "cookie",
  "databaseurl",
  "env",
  "environment",
  "header",
  "headers",
  "oauth",
  "otp",
  "payload",
  "proxyauthorization",
  "query",
  "request",
  "response",
  "session",
  "setcookie",
  "smtp",
  "smtpurl",
  "sql",
  "statement",
  "subject",
  "totp",
  "valkeyurl",
]);

const SENSITIVE_QUOTED_FIELD =
  /(["'])(?:authorization|proxy-authorization|cookie|set-cookie|(?:(?:access|refresh|id|csrf|client|auth|api|smtp)[ _-]*)?(?:password|passwd|secret|token)|session|api[ _-]*key|database[-_]?url|valkey[-_]?url|smtp[-_]?url|headers?|body|payload|request|response|query|sql|statement|subject|content|smtp|oauth|totp|otp|code|command|cmd|argv|environment|env)\1\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\{[^\r\n]*\}|\[[^\r\n]*\]|[^,}\]\r\n]+)/giu;
const SENSITIVE_VALUE =
  /(authorization|cookie|password|passwd|secret|token|api[-_ ]?key|session)[=: ]+([^\s,;]+)/giu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const SAFE_REQUEST_ID =
  /^(?:req-[0-9]{1,19}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function looksLikeNestedJson(value: string): boolean {
  const first = value.trimStart()[0];
  return first === "{" || first === "[" || first === '"';
}

function looksLikeJsonOpening(value: string, index: number): boolean {
  const opening = value[index];
  const first = value.slice(index + 1).trimStart()[0];
  if (first === undefined) return false;
  if (opening === "{") return first === '"' || first === "}";
  if (opening === "[") {
    return (
      first === '"' ||
      first === "{" ||
      first === "[" ||
      first === "]" ||
      first === "-" ||
      first === "t" ||
      first === "f" ||
      first === "n" ||
      /\d/u.test(first)
    );
  }
  return false;
}

function containsStructuredFragment(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if ((value[index] === "{" || value[index] === "[") && looksLikeJsonOpening(value, index)) {
      return true;
    }
  }
  return false;
}

function isSensitiveStructuredKey(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US").replace(/[ _-]+/gu, "");
  return (
    STRUCTURED_SENSITIVE_KEYS.has(normalized) ||
    /(?:password|passwd|secret|token)$/u.test(normalized)
  );
}

interface StructuredRedactionResult {
  readonly changed: boolean;
  readonly value: unknown;
}

function redactJsonValue(
  value: unknown,
  maximumBytes: number,
  depth = 0,
): StructuredRedactionResult {
  if (depth >= STRUCTURED_REDACTION_MAX_DEPTH) {
    if (
      Array.isArray(value) ||
      (typeof value === "object" && value !== null) ||
      (typeof value === "string" && containsStructuredFragment(value))
    ) {
      return { changed: true, value: STRUCTURED_REDACTED };
    }
    return { changed: false, value };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const sanitized = value.map((item) => {
      const result = redactJsonValue(item, maximumBytes, depth + 1);
      changed ||= result.changed;
      return result.value;
    });
    return { changed, value: changed ? sanitized : value };
  }

  if (typeof value === "object" && value !== null) {
    let changed = false;
    const entries: Array<readonly [string, unknown]> = [];
    for (const [key, item] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      if (isSensitiveStructuredKey(key)) {
        entries.push([key, STRUCTURED_REDACTED]);
        changed = true;
        continue;
      }
      const result = redactJsonValue(item, maximumBytes, depth + 1);
      entries.push([key, result.value]);
      changed ||= result.changed;
    }
    return { changed, value: changed ? Object.fromEntries(entries) : value };
  }

  if (typeof value === "string" && containsStructuredFragment(value)) {
    if (Buffer.byteLength(value, "utf8") > maximumBytes) {
      return { changed: true, value: STRUCTURED_REDACTED };
    }
    if (looksLikeNestedJson(value)) {
      let nested: unknown;
      try {
        nested = JSON.parse(value) as unknown;
      } catch {
        return { changed: true, value: STRUCTURED_REDACTED };
      }
      const result = redactJsonValue(nested, maximumBytes, depth + 1);
      if (result.changed) return { changed: true, value: JSON.stringify(result.value) };
    } else {
      const sanitized = redactStructuredFragments(value, maximumBytes, depth + 1);
      if (sanitized !== value) return { changed: true, value: sanitized };
    }
  }
  return { changed: false, value };
}

function findJsonValueEnd(value: string, start: number): number | null {
  if (value[start] === '"') {
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return index + 1;
      }
    }
    return null;
  }

  const opening = value[start];
  if (opening !== "{" && opening !== "[") return null;
  const stack = [opening === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      stack.push("}");
    } else if (character === "[") {
      stack.push("]");
    } else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return null;
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

function redactStructuredFragments(value: string, maximumBytes: number, depth = 0): string {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    return containsStructuredFragment(value) ? STRUCTURED_REDACTED : value;
  }

  let output = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (
      (character !== "{" && character !== "[" && character !== '"') ||
      ((character === "{" || character === "[") && !looksLikeJsonOpening(value, index))
    ) {
      output += character;
      index += 1;
      continue;
    }
    const end = findJsonValueEnd(value, index);
    const quotedStructure = character === '"' && containsStructuredFragment(value.slice(index + 1));
    if (end === null) {
      if (character === "{" || character === "[" || quotedStructure) {
        return output + STRUCTURED_REDACTED;
      }
      output += character;
      index += 1;
      continue;
    }
    const raw = value.slice(index, end);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      if (character === "{" || character === "[" || quotedStructure) {
        return output + STRUCTURED_REDACTED;
      }
      output += raw;
      index = end;
      continue;
    }
    if (
      character === '"' &&
      !(typeof decoded === "string" && containsStructuredFragment(decoded))
    ) {
      output += raw;
      index = end;
      continue;
    }
    const result = redactJsonValue(decoded, maximumBytes, depth);
    output += result.changed ? JSON.stringify(result.value) : raw;
    index = end;
  }
  return output;
}

function cleanText(value: unknown, maximumBytes: number, structured = false): string {
  if (typeof value !== "string") return "";
  const normalized = stripControlCharacters(value);
  return truncateUtf8(
    (structured ? redactStructuredFragments(normalized, maximumBytes) : normalized)
      .replace(SENSITIVE_QUOTED_FIELD, "[redacted-field]")
      .replace(SENSITIVE_VALUE, "$1=[redacted]")
      .replace(EMAIL, "[redacted-email]")
      .replace(
        /https?:\/\/[^\s?#]+[?#][^\s]*/giu,
        (match) => match.split(/[?#]/u, 1)[0] ?? "[redacted-url]",
      )
      .trim(),
    maximumBytes,
  );
}

export function sanitizeLogRecord(value: unknown, index: number): SanitizedLogEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const rawSeverity = typeof record.severity === "string" ? record.severity.toLowerCase() : "";
  const severity: LogSeverity | null =
    rawSeverity === "error" || rawSeverity === "fatal"
      ? "error"
      : rawSeverity === "warning" || rawSeverity === "warn"
        ? "warning"
        : null;
  if (severity === null) return null;
  const timestamp =
    typeof record.timestamp === "string" ? new Date(record.timestamp) : new Date(Number.NaN);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const service = cleanText(record.service, 64).replace(/[^a-zA-Z0-9._-]/gu, "-");
  const message = cleanText(record.message, 4_096, true);
  if (service.length === 0 || message.length === 0) return null;
  const requestIdCandidate = cleanText(record.requestId ?? record.request_id, 96);
  const requestId = SAFE_REQUEST_ID.test(requestIdCandidate) ? requestIdCandidate : "";
  const explicitId = cleanText(record.id, 96);
  return {
    id: explicitId || `${timestamp.getTime()}-${index}`,
    message,
    requestId: requestId || null,
    service,
    severity,
    timestamp: timestamp.toISOString(),
  };
}

export async function readSanitizedLogs(
  filePath: string,
  maxBytes: number,
  query: LogQuery,
): Promise<readonly SanitizedLogEntry[]> {
  const stats = await stat(filePath);
  if (!stats.isFile()) throw new Error("Configured log source is not a regular file");
  const start = Math.max(0, stats.size - maxBytes);
  const loweredSearch = query.search?.toLocaleLowerCase("en-US") ?? null;
  const entries: SanitizedLogEntry[] = [];
  let carry = "";
  let discardPartialLine = start > 0;
  let lineIndex = 0;

  const considerLine = (line: string): void => {
    lineIndex += 1;
    if (discardPartialLine) {
      discardPartialLine = false;
      return;
    }
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_LOG_LINE_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const entry = sanitizeLogRecord(parsed, lineIndex);
    if (entry === null) return;
    if (
      query.cursor !== null &&
      (entry.timestamp > query.cursor.timestamp ||
        (entry.timestamp === query.cursor.timestamp && entry.id >= query.cursor.id))
    ) {
      return;
    }
    if (query.service !== null && entry.service !== query.service) return;
    if (query.severity !== null && entry.severity !== query.severity) return;
    if (
      loweredSearch !== null &&
      !`${entry.service} ${entry.message} ${entry.requestId ?? ""}`
        .toLocaleLowerCase("en-US")
        .includes(loweredSearch)
    ) {
      return;
    }
    entries.push(entry);
    if (entries.length > query.limit) entries.shift();
  };

  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1_024,
    start,
  });
  for await (const chunk of stream) {
    const text = carry + chunk;
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) considerLine(line);
    if (Buffer.byteLength(carry, "utf8") > MAX_LOG_LINE_BYTES) {
      carry = "";
      discardPartialLine = true;
    }
  }
  if (carry.length > 0 && !discardPartialLine) considerLine(carry);
  return entries.reverse();
}

export function encodeLogCursor(entry: SanitizedLogEntry): string {
  return Buffer.from(JSON.stringify({ id: entry.id, timestamp: entry.timestamp }), "utf8").toString(
    "base64url",
  );
}

export function decodeLogCursor(value: string | null): LogCursor | null {
  if (value === null || value.length === 0 || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as { readonly id?: unknown; readonly timestamp?: unknown };
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      record.id.length > 96 ||
      typeof record.timestamp !== "string" ||
      !Number.isFinite(new Date(record.timestamp).getTime())
    ) {
      return null;
    }
    return { id: record.id, timestamp: new Date(record.timestamp).toISOString() };
  } catch {
    return null;
  }
}
