import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decodeLogCursor,
  encodeLogCursor,
  readSanitizedLogs,
  sanitizeLogRecord,
} from "../lib/monitoring/log-source.ts";

describe("sanitized log source", () => {
  it("keeps allowlisted fields while redacting credentials and personal addresses", () => {
    const result = sanitizeLogRecord(
      {
        extra: { unsafe: true },
        message: "Authorization=Bearer-secret email operator@example.test token=abc123",
        requestId: "req-1",
        service: "api",
        severity: "ERROR",
        timestamp: "2026-09-02T10:00:00.000Z",
      },
      1,
    );
    expect(result?.message).toBe(
      "Authorization=[redacted] email [redacted-email] token=[redacted]",
    );
    expect(result?.requestId).toBe("req-1");
    expect(result).not.toHaveProperty("extra");
  });

  it("drops IP and token-shaped request identifiers from current or legacy snapshots", () => {
    for (const requestId of ["192.0.2.10", "sk_live_opaque_secret", "req-sk-live-secret"]) {
      const result = sanitizeLogRecord(
        {
          message: "failed safely",
          requestId,
          service: "api",
          severity: "error",
          timestamp: "2026-09-02T10:00:00.000Z",
        },
        1,
      );
      expect(result?.requestId).toBeNull();
    }
  });

  it("redacts quoted sensitive fields again before returning a snapshot record", () => {
    const result = sanitizeLogRecord(
      {
        message:
          'request body {"password":"correct horse battery staple","cookie":"sid=session-secret","authorization":"Bearer abc.def","nested":{"token":"opaque-token"}}',
        service: "api",
        severity: "error",
        timestamp: "2026-09-02T10:00:00.000Z",
      },
      1,
    );
    for (const sentinel of [
      "correct",
      "horse",
      "battery",
      "staple",
      "session-secret",
      "abc.def",
      "opaque-token",
    ]) {
      expect(result?.message).not.toContain(sentinel);
    }
    expect(result?.message).toContain("[redacted-field]");
  });

  it("decodes escaped keys and nested serialized JSON before returning logs", () => {
    for (const [message, sentinel] of [
      [String.raw`ERROR payload {"pass\u0077ord":"escaped-key-secret"}`, "escaped-key-secret"],
      [
        String.raw`ERROR diagnostic "prefix {\"nested\":{\"to\u006ben\":\"double-encoded-secret\"}}"`,
        "double-encoded-secret",
      ],
      [String.raw`ERROR payload {"pass\u0077ord":"malformed-secret"`, "malformed-secret"],
    ] as const) {
      const result = sanitizeLogRecord(
        {
          message,
          service: "api",
          severity: "error",
          timestamp: "2026-09-02T10:00:00.000Z",
        },
        1,
      );
      expect(result?.message).not.toContain(sentinel);
      expect(result?.message).toContain("[redacted-field]");
    }

    const legitimate = sanitizeLogRecord(
      {
        message: 'ERROR detail {"worker":"delayed","attempt":2}',
        service: "worker",
        severity: "warning",
        timestamp: "2026-09-02T10:00:00.000Z",
      },
      2,
    );
    expect(legitimate?.message).toBe('ERROR detail {"worker":"delayed","attempt":2}');
    const bracketed = sanitizeLogRecord(
      {
        message: "ERROR worker [job-1] failed with template {name}",
        service: "worker",
        severity: "warning",
        timestamp: "2026-09-02T10:00:00.000Z",
      },
      3,
    );
    expect(bracketed?.message).toBe("ERROR worker [job-1] failed with template {name}");
  });

  it("preserves the approved 4 KiB message ceiling without breaking Unicode", () => {
    const result = sanitizeLogRecord(
      {
        message: "é".repeat(3_000),
        service: "worker",
        severity: "warning",
        timestamp: "2026-09-02T10:00:00.000Z",
      },
      2,
    );
    expect(Buffer.byteLength(result?.message ?? "", "utf8")).toBeLessThanOrEqual(4_096);
    expect(result?.message.endsWith("�")).toBe(false);
  });

  it("round-trips bounded opaque cursors", () => {
    const entry = sanitizeLogRecord(
      {
        message: "safe",
        service: "api",
        severity: "warning",
        timestamp: "2026-09-02T10:00:00.000Z",
      },
      3,
    );
    expect(entry).not.toBeNull();
    expect(decodeLogCursor(encodeLogCursor(entry!))).toEqual({
      id: entry?.id,
      timestamp: entry?.timestamp,
    });
    expect(decodeLogCursor("not-json")).toBeNull();
  });

  it("streams a bounded tail and returns newest matching records first", async () => {
    const directory = await mkdtemp(join(tmpdir(), "esmii-dashboard-logs-"));
    const file = join(directory, "services.ndjson");
    try {
      const records = Array.from({ length: 12 }, (_, index) =>
        JSON.stringify({
          id: `event-${index.toString().padStart(2, "0")}`,
          message: `bounded event ${index}`,
          service: index % 2 === 0 ? "api" : "worker",
          severity: index % 3 === 0 ? "error" : "warning",
          timestamp: new Date(Date.UTC(2026, 8, 2, 10, index)).toISOString(),
        }),
      );
      await writeFile(file, `${"x".repeat(20_000)}\n${records.join("\n")}\n`, "utf8");
      const newest = await readSanitizedLogs(file, 1_000_000, {
        cursor: null,
        limit: 3,
        search: null,
        service: null,
        severity: null,
      });
      expect(newest.map((entry) => entry.id)).toEqual(["event-11", "event-10", "event-09"]);
      const older = await readSanitizedLogs(file, 1_000_000, {
        cursor: decodeLogCursor(encodeLogCursor(newest[2]!)),
        limit: 2,
        search: "bounded",
        service: "api",
        severity: "warning",
      });
      expect(older.map((entry) => entry.id)).toEqual(["event-08", "event-04"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
