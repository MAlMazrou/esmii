#!/usr/bin/env python3
"""Build bounded, sanitized warning/error snapshots from allowlisted sources."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import selectors
import sqlite3
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Mapping, Sequence

from monitoring_common import (
    MONITORED_SERVICES,
    CommandRunner,
    default_runner,
    docker_inventory,
    parse_rfc3339,
    read_json_object,
    select_service_containers,
    write_json_object,
)


RETENTION_SECONDS = 24 * 60 * 60
MAX_ENTRIES = 10_000
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_MESSAGE_BYTES = 4 * 1024
FIRST_RUN_TAIL = 500
MAX_RAW_COMMAND_BYTES = 4 * 1024 * 1024
MAX_RAW_LINE_BYTES = 64 * 1024
MAX_RAW_LINES = FIRST_RUN_TAIL + 100
RAW_TRUNCATION_MESSAGE = "ERROR monitoring log content omitted at the raw collection limit"
RAW_TRUNCATION_EVENT = "collector.raw_log_truncated"
COLLECTOR_DIAGNOSTIC_SERVICE = "esmii-log-collector.service"

STAGING_HOSTS = frozenset(("staging.esmii.app", "staging-dashboard.esmii.app"))
PRODUCTION_HOSTS = frozenset(("esmii.app", "dashboard.esmii.app"))

# The journal reader is deliberately fixed. It accepts no unit from CLI,
# configuration, Docker labels, or dashboard input.
SYSTEMD_LOG_SOURCES: Mapping[str, tuple[str, ...]] = {
    "esmii-staging-pull.service": ("staging",),
    "esmii-production-pull.service": ("production",),
    "esmii-deployment-reconciler.service": ("staging",),
    "esmii-health-check.service": ("staging", "production"),
    "esmii-host-prune.service": ("staging", "production"),
    "esmii-maintenance.service": ("staging", "production"),
    "esmii-database-backup.service": ("production",),
    "esmii-state-backup.service": ("production",),
    "esmii-restore-check.service": ("production",),
    "esmii-docker-firewall.service": ("staging", "production"),
    "esmii-node-exporter.service": ("staging", "production"),
    "esmii-node-exporter-staging-proxy.service": ("staging",),
    "esmii-node-exporter-production-proxy.service": ("production",),
    "esmii-container-metrics-collector.service": ("staging", "production"),
}
ALLOWED_LOG_SERVICES = frozenset(
    {item.compose_service for item in MONITORED_SERVICES}
    | set(SYSTEMD_LOG_SOURCES)
    | {COLLECTOR_DIAGNOSTIC_SERVICE}
)

_QUOTED_SENSITIVE_FIELD = re.compile(
    r'''(?ix)
    (?P<prefix>
      (?P<quote>["'])
      (?:
        authorization|proxy-authorization|cookie|set-cookie
        |(?:(?:access|refresh|id|csrf|client|auth|api|smtp)[ _-]*)?(?:password|passwd|secret|token)
        |session|api[ _-]*key|database[-_]?url|valkey[-_]?url|smtp[-_]?url
        |headers?|body|payload|request|response|query|sql|statement|subject|content
        |smtp|oauth|totp|otp|code|command|cmd|argv|environment|env
      )
      (?P=quote)\s*:\s*
    )
    (?:
      "(?:\\.|[^"\\])*"
      |'(?:\\.|[^'\\])*'
      |\{[^\r\n]*\}
      |\[[^\r\n]*\]
      |[^,}\]\r\n]+
    )
    '''
)
_SENSITIVE_HEADER = re.compile(
    r"(?i)\b(authorization|proxy-authorization|cookie|set-cookie)\b(\s*[:=]\s*)[^\r\n]*"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?ix)\b("
    r"(?:(?:access|refresh|id|csrf|client|auth|api|smtp)[ _-]*)?(?:password|passwd|secret|token)"
    r"|session|api[ _-]*key|database[-_]?url|valkey[-_]?url|smtp[-_]?url"
    r")\b(\s*(?:[:=]|\bis\b)\s*)"
    r"(?:\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|[^\r\n,;]+)"
)
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_BASIC = re.compile(r"(?i)\bBasic\s+[A-Za-z0-9+/=]+")
_URL_CREDENTIAL = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/@\s:]+:[^/@\s]+@")
_URL = re.compile(r"(?i)\b(?:https?|postgres(?:ql)?|redis|valkey|smtp)://[^\s<>'\"]+")
_EMAIL = re.compile(r"(?i)(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])")
_IPV4 = re.compile(r"(?<![0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9])")
_ACTION_URL = re.compile(
    r"(?i)/(?:api/(?:auth|operator-auth|invitation)|auth|invitation|magic-link|verify|verification|callback|reset|action)(?:/[^\s?#]*)?(?:\?[^\s#]*)?"
)
_RELATIVE_QUERY = re.compile(r"(?i)(?<![A-Za-z0-9])/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\?[^\s#<>\"']*")
_BARE_SENSITIVE_QUERY = re.compile(r"(?i)\?(?:[^\s#&]+&)*(?:token|code|state|secret|key)=[^\s#]*")
_SENSITIVE_ASSIGNMENT = re.compile(
    r"(?i)\b(headers?|body|payload|request|response|query|sql|statement|subject|content|"
    r"smtp|oauth|totp|otp|code|command|cmd|argv|environment|env)\b"
    r"(\s*[:=]\s*)(?:\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|\{[^\r\n]*\}|\[[^\r\n]*\]|[^\s,;]+)"
)
_ENV_ASSIGNMENT = re.compile(r"\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s,;]+")
_FILESYSTEM_PATH = re.compile(r"(?<![A-Za-z0-9._-])/(?:etc|var|srv|home|root|run|proc|sys|tmp|usr|opt)(?:/[^\s,;:()]+)+")
_STACK_FRAME = re.compile(r"(?i)(?:\bat\s+[A-Za-z0-9_.$<>]+\s*\([^)]*\)|\bFile\s+\"[^\"]+\",\s+line\s+\d+)")
_OAUTH_TOTP = re.compile(r"(?i)\b(?:oauth|totp|otp)(?:\s+(?:code|token|secret|value))?\s*[:=]?\s*[A-Za-z0-9._~+/=-]{4,}")
_SMTP_ENVELOPE = re.compile(r"(?i)\b(?:MAIL\s+FROM|RCPT\s+TO|AUTH\s+(?:PLAIN|LOGIN)|DATA)\b[^\r\n]*")
_SQL_STATEMENT = re.compile(r"(?i)\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b.*")
_ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_IPV6 = re.compile(r"(?i)(?<![0-9a-f:])(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{0,39}(?![0-9a-f:])")
_WARNING_WORD = re.compile(r"(?i)\b(warn(?:ing)?|degraded|retry|timeout|refused|unavailable)\b")
_ERROR_WORD = re.compile(r"(?i)\b(error|failed|failure|fatal|panic|critical|emerg|alert|oom(?:-killed)?)\b")
_SAFE_EVENT = re.compile(r"[a-z][a-z0-9_.-]{0,79}")
_SAFE_REQUEST_ID = re.compile(
    r"(?:req-[0-9]{1,19}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})",
    re.IGNORECASE,
)
_SYSTEMD_TIMESTAMP_BYTES = re.compile(
    rb'"__REALTIME_TIMESTAMP"\s*:\s*"?([0-9]{10,20})'
)
_SYSTEMD_UNIT_BYTES = re.compile(rb'"_SYSTEMD_UNIT"\s*:\s*"([^"\\]{1,160})"')
_STRUCTURED_REDACTION_MAX_DEPTH = 4
_STRUCTURED_REDACTED = "[REDACTED]"
_STRUCTURED_SENSITIVE_KEYS = frozenset(
    (
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
    )
)


def truncate_utf8(value: str, maximum_bytes: int = MAX_MESSAGE_BYTES) -> str:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= maximum_bytes:
        return value
    suffix = "...[truncated]"
    budget = max(0, maximum_bytes - len(suffix.encode("utf-8")))
    return encoded[:budget].decode("utf-8", errors="ignore") + suffix


def _looks_like_nested_json(value: str) -> bool:
    return value.lstrip().startswith(("{", "[", '"'))


def _looks_like_json_opening(value: str, index: int) -> bool:
    opening = value[index]
    remainder = value[index + 1 :].lstrip()
    if not remainder:
        return False
    if opening == "{":
        return remainder[0] in {'"', "}"}
    if opening == "[":
        return remainder[0] in {'"', "{", "[", "]", "-", "t", "f", "n"} or remainder[0].isdigit()
    return False


def _contains_structured_fragment(value: str) -> bool:
    return any(
        character in "{[" and _looks_like_json_opening(value, index)
        for index, character in enumerate(value)
    )


def _is_sensitive_structured_key(value: str) -> bool:
    normalized = re.sub(r"[ _-]+", "", value).lower()
    return normalized in _STRUCTURED_SENSITIVE_KEYS or normalized.endswith(
        ("password", "passwd", "secret", "token")
    )


def _redact_json_value(value: object, depth: int = 0) -> tuple[object, bool]:
    if depth >= _STRUCTURED_REDACTION_MAX_DEPTH:
        if isinstance(value, (dict, list)) or (
            isinstance(value, str) and _contains_structured_fragment(value)
        ):
            return (_STRUCTURED_REDACTED, True)
        return (value, False)

    if isinstance(value, dict):
        changed = False
        sanitized: dict[str, object] = {}
        for key, item in value.items():
            if _is_sensitive_structured_key(key):
                sanitized[key] = _STRUCTURED_REDACTED
                changed = True
                continue
            sanitized_item, item_changed = _redact_json_value(item, depth + 1)
            sanitized[key] = sanitized_item
            changed = changed or item_changed
        return (sanitized if changed else value, changed)

    if isinstance(value, list):
        changed = False
        sanitized_items: list[object] = []
        for item in value:
            sanitized_item, item_changed = _redact_json_value(item, depth + 1)
            sanitized_items.append(sanitized_item)
            changed = changed or item_changed
        return (sanitized_items if changed else value, changed)

    if isinstance(value, str) and _contains_structured_fragment(value):
        if len(value.encode("utf-8", errors="replace")) > MAX_MESSAGE_BYTES:
            return (_STRUCTURED_REDACTED, True)
        if _looks_like_nested_json(value):
            try:
                nested = json.loads(value)
            except json.JSONDecodeError:
                return (_STRUCTURED_REDACTED, True)
            sanitized_nested, nested_changed = _redact_json_value(nested, depth + 1)
            if nested_changed:
                return (
                    json.dumps(sanitized_nested, ensure_ascii=False, separators=(",", ":")),
                    True,
                )
        else:
            sanitized_fragments = _redact_structured_fragments(value, depth + 1)
            if sanitized_fragments != value:
                return (sanitized_fragments, True)
    return (value, False)


def _redact_structured_fragments(value: str, depth: int = 0) -> str:
    if len(value.encode("utf-8", errors="replace")) > MAX_MESSAGE_BYTES:
        # Parsing is deliberately capped at the same boundary as a stored
        # message. Oversized structured diagnostics are discarded rather than
        # risking a partial parse that returns credentials.
        return _STRUCTURED_REDACTED if _contains_structured_fragment(value) else value

    decoder = json.JSONDecoder()
    output: list[str] = []
    index = 0
    while index < len(value):
        character = value[index]
        if character not in '{["' or (
            character in "{[" and not _looks_like_json_opening(value, index)
        ):
            output.append(character)
            index += 1
            continue
        try:
            decoded, end = decoder.raw_decode(value, index)
        except json.JSONDecodeError:
            quoted_structure = character == '"' and _contains_structured_fragment(
                value[index + 1 :]
            )
            if character in "{[" or quoted_structure:
                output.append(_STRUCTURED_REDACTED)
                break
            output.append(character)
            index += 1
            continue

        if character == '"' and not (
            isinstance(decoded, str) and _contains_structured_fragment(decoded)
        ):
            output.append(value[index:end])
            index = end
            continue
        sanitized, changed = _redact_json_value(decoded, depth)
        output.append(
            json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"))
            if changed
            else value[index:end]
        )
        index = end
    return "".join(output)


def safe_timestamp(value: object, fallback: float = 0.0) -> float:
    if isinstance(value, bool):
        return fallback
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(parsed) or parsed <= 0 or parsed > 253_402_300_799:
        return fallback
    return parsed


def journal_timestamp(value: object, fallback: float = 0.0) -> float:
    try:
        microseconds = float(value)
    except (TypeError, ValueError):
        return fallback
    return safe_timestamp(microseconds / 1_000_000, fallback)


def redact(value: object) -> str:
    # A newline normally starts a stack trace or multi-line payload. Only the
    # bounded summary is useful to the dashboard.
    text = str(value).splitlines()[0] if str(value).splitlines() else ""
    text = _ANSI_ESCAPE.sub("", text)
    text = _CONTROL.sub(" ", text)
    text = _redact_structured_fragments(text)
    text = _QUOTED_SENSITIVE_FIELD.sub(
        lambda match: f'{match.group("prefix")}"[REDACTED]"', text
    )
    text = _SQL_STATEMENT.sub("[REDACTED_SQL]", text)
    text = _SENSITIVE_HEADER.sub(
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text
    )
    text = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text)
    text = _SENSITIVE_ASSIGNMENT.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text)
    text = _ENV_ASSIGNMENT.sub("[REDACTED_ENV]", text)
    text = _BEARER.sub("Bearer [REDACTED]", text)
    text = _BASIC.sub("Basic [REDACTED]", text)
    text = _URL_CREDENTIAL.sub(r"\1[REDACTED]@", text)
    text = _ACTION_URL.sub("[REDACTED_ACTION_URL]", text)
    text = _RELATIVE_QUERY.sub("[REDACTED_RELATIVE_URL]", text)
    text = _BARE_SENSITIVE_QUERY.sub("?[REDACTED]", text)
    text = _URL.sub("[REDACTED_URL]", text)
    text = _OAUTH_TOTP.sub("[REDACTED_AUTH_MATERIAL]", text)
    text = _SMTP_ENVELOPE.sub("[REDACTED_SMTP]", text)
    text = _STACK_FRAME.sub("[REDACTED_STACK]", text)
    text = _FILESYSTEM_PATH.sub("[REDACTED_PATH]", text)
    text = _EMAIL.sub("[REDACTED_EMAIL]", text)
    text = _IPV4.sub("[REDACTED_IP]", text)
    text = _IPV6.sub("[REDACTED_IP]", text)
    return truncate_utf8(text)


def severity_for(payload: object, fallback: str) -> str | None:
    if isinstance(payload, dict):
        raw_level = payload.get("level")
        if isinstance(raw_level, (int, float)):
            if raw_level >= 50:
                return "error"
            if raw_level >= 40:
                return "warning"
        if isinstance(raw_level, str):
            lowered = raw_level.lower()
            if lowered in {"fatal", "panic", "critical", "alert", "emerg", "error", "err"}:
                return "error"
            if lowered in {"warning", "warn"}:
                return "warning"
        status = payload.get("status")
        if isinstance(status, int):
            if status >= 500:
                return "error"
            if status >= 400:
                return "warning"
    if _ERROR_WORD.search(fallback):
        return "error"
    if _WARNING_WORD.search(fallback):
        return "warning"
    return None


def caddy_environments(payload: object) -> tuple[str, ...]:
    if not isinstance(payload, dict):
        return ()
    request = payload.get("request")
    host = request.get("host") if isinstance(request, dict) else payload.get("host")
    if not isinstance(host, str) or not host:
        return ()
    hostname = host.lower().split(":", 1)[0]
    if hostname in STAGING_HOSTS:
        return ("staging",)
    if hostname in PRODUCTION_HOSTS:
        return ("production",)
    return ()


def _timestamp_prefix(line: str) -> tuple[float, str]:
    timestamp_raw, separator, payload = line.partition(" ")
    if not separator:
        return (0.0, line)
    timestamp = parse_rfc3339(timestamp_raw)
    return (timestamp, payload if timestamp else line)


def normalize_line(
    *,
    line: str,
    service: str,
    default_environment: str,
    now: float,
) -> list[dict[str, object]]:
    timestamp, raw_payload = _timestamp_prefix(line)
    if timestamp <= 0:
        timestamp = now
    try:
        payload: object = json.loads(raw_payload)
    except json.JSONDecodeError:
        payload = raw_payload

    if isinstance(payload, dict):
        candidate = payload.get("msg", payload.get("message", raw_payload))
        raw_message = candidate if isinstance(candidate, str) else "Structured diagnostic details omitted"
    else:
        raw_message = payload
    severity = severity_for(payload, str(raw_message))
    if severity is None:
        return []

    collector_truncation = (
        isinstance(payload, dict)
        and payload.get("event") == RAW_TRUNCATION_EVENT
        and payload.get("msg") == RAW_TRUNCATION_MESSAGE
    )
    environments = (
        ("staging", "production")
        if service == "caddy" and collector_truncation
        else caddy_environments(payload)
        if service == "caddy"
        else (default_environment,)
    )
    if not environments:
        return []
    message = redact(raw_message)
    event = payload.get("event") if isinstance(payload, dict) else None
    event = event if isinstance(event, str) and _SAFE_EVENT.fullmatch(event) else None
    request_id = payload.get("requestId") if isinstance(payload, dict) else None
    request_id = (
        request_id
        if isinstance(request_id, str) and _SAFE_REQUEST_ID.fullmatch(request_id)
        else None
    )

    result: list[dict[str, object]] = []
    for environment in environments:
        identity_source = f"{environment}\0{service}\0{timestamp:.9f}\0{severity}\0{message}"
        entry: dict[str, object] = {
            "environment": environment,
            "id": hashlib.sha256(identity_source.encode("utf-8")).hexdigest(),
            "message": message,
            "service": service,
            "severity": severity,
            "timestamp": datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z"),
            "timestampUnix": timestamp,
        }
        if event is not None:
            entry["event"] = event
        if request_id is not None:
            entry["requestId"] = request_id
        result.append(entry)
    return result


def iter_snapshot(path: Path, expected_environment: str) -> Iterator[dict[str, object]]:
    if not path.is_file() or path.is_symlink():
        return
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict) or value.get("environment") != expected_environment:
                continue
            service = value.get("service")
            if not isinstance(service, str) or service not in ALLOWED_LOG_SERVICES:
                continue
            severity = value.get("severity")
            timestamp = safe_timestamp(value.get("timestampUnix"))
            if severity not in {"warning", "error"} or timestamp <= 0:
                continue
            message = redact(value.get("message", ""))
            identity_source = f"{expected_environment}\0{service}\0{timestamp:.9f}\0{severity}\0{message}"
            entry: dict[str, object] = {
                "environment": expected_environment,
                "id": hashlib.sha256(identity_source.encode("utf-8")).hexdigest(),
                "message": message,
                "service": service,
                "severity": severity,
                "timestamp": datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z"),
                "timestampUnix": timestamp,
            }
            event = value.get("event")
            if isinstance(event, str) and _SAFE_EVENT.fullmatch(event):
                entry["event"] = event
            request_id = value.get("requestId")
            if isinstance(request_id, str) and _SAFE_REQUEST_ID.fullmatch(request_id):
                entry["requestId"] = request_id
            yield entry


def read_snapshot(path: Path, expected_environment: str) -> list[dict[str, object]]:
    return list(iter_snapshot(path, expected_environment))


def bound_entries(
    entries: Iterable[dict[str, object]],
    *,
    now: float,
    retention_seconds: int = RETENTION_SECONDS,
    maximum_entries: int = MAX_ENTRIES,
    maximum_bytes: int = MAX_FILE_BYTES,
) -> list[dict[str, object]]:
    cutoff = now - retention_seconds
    deduplicated: dict[str, dict[str, object]] = {}
    for entry in entries:
        timestamp = entry.get("timestampUnix")
        identity = entry.get("id")
        if not isinstance(timestamp, (int, float)) or timestamp < cutoff or timestamp > now + 60:
            continue
        if not isinstance(identity, str):
            continue
        deduplicated[identity] = entry

    newest = sorted(
        deduplicated.values(), key=lambda entry: float(entry["timestampUnix"]), reverse=True
    )[:maximum_entries]
    selected: list[dict[str, object]] = []
    used_bytes = 0
    for entry in newest:
        line_size = len(json.dumps(entry, sort_keys=True, separators=(",", ":")).encode("utf-8")) + 1
        if line_size > maximum_bytes or used_bytes + line_size > maximum_bytes:
            continue
        selected.append(entry)
        used_bytes += line_size
    selected.reverse()
    return selected


def render_snapshot(entries: Iterable[dict[str, object]]) -> str:
    return "".join(
        json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n" for entry in entries
    )


def store_entry(database: sqlite3.Connection, entry: Mapping[str, object]) -> None:
    environment = entry.get("environment")
    identity = entry.get("id")
    timestamp = safe_timestamp(entry.get("timestampUnix"))
    if environment not in {"staging", "production"} or not isinstance(identity, str) or timestamp <= 0:
        return
    line = json.dumps(entry, sort_keys=True, separators=(",", ":"))
    database.execute(
        "INSERT OR REPLACE INTO entries(environment,id,timestamp_unix,line,line_bytes) VALUES(?,?,?,?,?)",
        (environment, identity, timestamp, line, len(line.encode("utf-8")) + 1),
    )


def write_database_snapshot(
    database: sqlite3.Connection,
    *,
    environment: str,
    path: Path,
    now: float,
    output_group: int,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    query = """
        WITH ranked AS (
          SELECT id, line, timestamp_unix,
                 ROW_NUMBER() OVER (ORDER BY timestamp_unix DESC, id DESC) AS row_number,
                 SUM(line_bytes) OVER (
                   ORDER BY timestamp_unix DESC, id DESC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS cumulative_bytes
          FROM entries
          WHERE environment = ? AND timestamp_unix >= ? AND timestamp_unix <= ?
        )
        SELECT line FROM ranked
        WHERE row_number <= ? AND cumulative_bytes <= ?
        ORDER BY timestamp_unix ASC, id ASC
    """
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            for (line,) in database.execute(
                query,
                (environment, now - RETENTION_SECONDS, now + 60, MAX_ENTRIES, MAX_FILE_BYTES),
            ):
                handle.write(str(line))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o640)
        os.chown(temporary, -1, output_group)
        os.replace(temporary, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class BoundedRawLine:
    text: str | None
    timestamp: float
    systemd_unit: str | None
    truncated: bool


@dataclass(frozen=True)
class BoundedLogCommandResult:
    returncode: int
    lines: tuple[BoundedRawLine, ...]
    input_truncated: bool


class _BoundedLineAccumulator:
    def __init__(self, *, line_bytes: int, max_lines: int) -> None:
        self._line_bytes = line_bytes
        self._max_lines = max_lines
        self._retained = bytearray()
        self._prefix = bytearray()
        self._metadata_tail = b""
        self._timestamp_microseconds: int | None = None
        self._systemd_unit: str | None = None
        self._line_had_bytes = False
        self._line_truncated = False
        self.lines: list[BoundedRawLine] = []

    def _scan_metadata(self, value: bytes) -> None:
        combined = self._metadata_tail + value
        if self._timestamp_microseconds is None:
            match = _SYSTEMD_TIMESTAMP_BYTES.search(combined)
            if match is not None:
                try:
                    candidate = int(match.group(1))
                except ValueError:
                    candidate = 0
                if candidate > 0:
                    self._timestamp_microseconds = candidate
        if self._systemd_unit is None:
            match = _SYSTEMD_UNIT_BYTES.search(combined)
            if match is not None:
                candidate = match.group(1).decode("utf-8", errors="replace")
                if candidate in SYSTEMD_LOG_SOURCES:
                    self._systemd_unit = candidate
        self._metadata_tail = combined[-512:]

    def _append_segment(self, value: bytes) -> None:
        if not value:
            return
        self._line_had_bytes = True
        self._scan_metadata(value)
        prefix_remaining = 256 - len(self._prefix)
        if prefix_remaining > 0:
            self._prefix.extend(value[:prefix_remaining])
        retained_remaining = self._line_bytes - len(self._retained)
        if retained_remaining > 0:
            self._retained.extend(value[:retained_remaining])
        if len(value) > retained_remaining:
            self._line_truncated = True

    def _finish_line(self, *, forced_truncation: bool = False) -> None:
        if not self._line_had_bytes and not forced_truncation:
            return
        if len(self.lines) >= self._max_lines:
            self._reset_line()
            return
        truncated = self._line_truncated or forced_truncation
        prefix_text = self._prefix.decode("utf-8", errors="replace")
        timestamp_raw, separator, _remainder = prefix_text.partition(" ")
        timestamp = parse_rfc3339(timestamp_raw) if separator else 0.0
        if timestamp <= 0 and self._timestamp_microseconds is not None:
            timestamp = safe_timestamp(self._timestamp_microseconds / 1_000_000)
        text = None
        if not truncated:
            text = self._retained.decode("utf-8", errors="replace").removesuffix("\r")
        self.lines.append(
            BoundedRawLine(
                text=text,
                timestamp=timestamp,
                systemd_unit=self._systemd_unit,
                truncated=truncated,
            )
        )
        self._reset_line()

    def _reset_line(self) -> None:
        self._retained.clear()
        self._prefix.clear()
        self._metadata_tail = b""
        self._timestamp_microseconds = None
        self._systemd_unit = None
        self._line_had_bytes = False
        self._line_truncated = False

    def feed(self, value: bytes) -> bool:
        offset = 0
        while offset < len(value):
            newline = value.find(b"\n", offset)
            if newline < 0:
                self._append_segment(value[offset:])
                return True
            self._append_segment(value[offset:newline])
            self._finish_line()
            if len(self.lines) >= self._max_lines:
                return False
            offset = newline + 1
        return True

    def finish(self, *, forced_truncation: bool = False) -> None:
        if self._line_had_bytes or forced_truncation:
            self._finish_line(forced_truncation=forced_truncation)


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=1)


def run_bounded_log_command(
    arguments: Sequence[str],
    *,
    runner: CommandRunner = default_runner,
    aggregate_bytes: int = MAX_RAW_COMMAND_BYTES,
    line_bytes: int = MAX_RAW_LINE_BYTES,
    max_lines: int = MAX_RAW_LINES,
    timeout_seconds: float = 20.0,
) -> BoundedLogCommandResult:
    if aggregate_bytes <= 0 or line_bytes <= 0 or max_lines <= 0 or timeout_seconds <= 0:
        raise ValueError("raw log command limits must be positive")
    if runner is not default_runner:
        return _bounded_completed_process(
            runner(arguments),
            aggregate_bytes=aggregate_bytes,
            line_bytes=line_bytes,
            max_lines=max_lines,
        )
    process = subprocess.Popen(
        list(arguments),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={"HOME": "/var/empty", "LANG": "C.UTF-8", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
    )
    if process.stdout is None:
        _terminate_process(process)
        raise RuntimeError("raw log command did not create an output pipe")

    accumulator = _BoundedLineAccumulator(line_bytes=line_bytes, max_lines=max_lines)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout_seconds
    observed_bytes = 0
    input_truncated = False
    try:
        while True:
            remaining_time = deadline - time.monotonic()
            if remaining_time <= 0:
                _terminate_process(process)
                raise subprocess.TimeoutExpired(list(arguments), timeout_seconds)
            if observed_bytes >= aggregate_bytes:
                input_truncated = True
                _terminate_process(process)
                break
            events = selector.select(timeout=remaining_time)
            if not events:
                if process.poll() is not None:
                    break
                continue
            chunk = os.read(
                process.stdout.fileno(), min(64 * 1024, aggregate_bytes - observed_bytes)
            )
            if not chunk:
                break
            observed_bytes += len(chunk)
            if not accumulator.feed(chunk):
                input_truncated = True
                _terminate_process(process)
                break
        if input_truncated:
            accumulator.finish(forced_truncation=True)
        else:
            accumulator.finish()
        returncode = process.wait(timeout=max(0.1, deadline - time.monotonic()))
    except Exception:
        _terminate_process(process)
        raise
    finally:
        selector.close()
        process.stdout.close()
    return BoundedLogCommandResult(
        returncode=returncode,
        lines=tuple(accumulator.lines),
        input_truncated=input_truncated,
    )


def _bounded_completed_process(
    result: subprocess.CompletedProcess[str],
    *,
    aggregate_bytes: int,
    line_bytes: int,
    max_lines: int,
) -> BoundedLogCommandResult:
    accumulator = _BoundedLineAccumulator(
        line_bytes=line_bytes,
        max_lines=max_lines,
    )
    observed_bytes = 0
    input_truncated = False
    for text in (result.stdout, result.stderr):
        value = text.encode("utf-8", errors="replace")
        remaining = aggregate_bytes - observed_bytes
        if remaining <= 0:
            input_truncated = True
            break
        selected = value[:remaining]
        observed_bytes += len(selected)
        if not accumulator.feed(selected):
            input_truncated = True
            break
        if len(selected) != len(value):
            input_truncated = True
            break
        if selected and not selected.endswith(b"\n"):
            accumulator.feed(b"\n")
    accumulator.finish(forced_truncation=input_truncated)
    return BoundedLogCommandResult(
        returncode=result.returncode,
        lines=tuple(accumulator.lines),
        input_truncated=input_truncated,
    )


def _timestamp_text(value: float) -> str | None:
    if value <= 0:
        return None
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def _docker_truncation_line(timestamp: float) -> str:
    payload = json.dumps(
        {
            "event": RAW_TRUNCATION_EVENT,
            "level": "error",
            "msg": RAW_TRUNCATION_MESSAGE,
        },
        separators=(",", ":"),
    )
    prefix = _timestamp_text(timestamp)
    return f"{prefix} {payload}" if prefix is not None else payload


def collect_logs_for_container(
    *,
    container: Mapping[str, object],
    since: float,
    runner: CommandRunner,
) -> list[str]:
    identifier = container.get("Id")
    if not isinstance(identifier, str) or not identifier:
        return []
    since_argument = f"{max(0.0, since - 2.0):.3f}" if since > 0 else "24h"
    result = run_bounded_log_command(
        (
            "/usr/bin/docker",
            "container",
            "logs",
            "--timestamps",
            "--since",
            since_argument,
            "--tail",
            str(FIRST_RUN_TAIL),
            identifier,
        ),
        runner=runner,
    )
    if result.returncode != 0 and not result.input_truncated:
        raise RuntimeError("allowlisted Docker log read failed")
    lines = [
        line.text if line.text is not None else _docker_truncation_line(line.timestamp)
        for line in result.lines
    ]
    if result.input_truncated:
        last_timestamp = max((line.timestamp for line in result.lines), default=0.0)
        lines.append(_docker_truncation_line(last_timestamp))
    return lines


def collect_systemd_logs(*, since: float, runner: CommandRunner) -> list[dict[str, object]]:
    since_argument = f"@{max(0.0, since - 2.0):.3f}" if since > 0 else "-24h"
    arguments = [
        "/usr/bin/journalctl",
        "--no-pager",
        "--output=json",
        f"--since={since_argument}",
        f"--lines={FIRST_RUN_TAIL}",
    ]
    for unit in SYSTEMD_LOG_SOURCES:
        arguments.append(f"--unit={unit}")
    result = run_bounded_log_command(tuple(arguments), runner=runner)
    if result.returncode != 0 and not result.input_truncated:
        raise RuntimeError("allowlisted systemd journal read failed")

    records: list[dict[str, object]] = []
    for line in result.lines:
        if line.truncated:
            record: dict[str, object] = {
                "MESSAGE": RAW_TRUNCATION_MESSAGE,
                "PRIORITY": "3",
                "__REALTIME_TIMESTAMP": str(int(line.timestamp * 1_000_000))
                if line.timestamp > 0
                else "0",
            }
            if line.systemd_unit is None:
                record["_ESMII_COLLECTOR_DIAGNOSTIC"] = True
            else:
                record["_SYSTEMD_UNIT"] = line.systemd_unit
            records.append(record)
            continue
        if line.text is None:
            continue
        try:
            value = json.loads(line.text)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict) or value.get("_SYSTEMD_UNIT") not in SYSTEMD_LOG_SOURCES:
            continue
        records.append(value)
    if result.input_truncated:
        last_timestamp = max((line.timestamp for line in result.lines), default=0.0)
        records.append(
            {
                "MESSAGE": RAW_TRUNCATION_MESSAGE,
                "PRIORITY": "3",
                "_ESMII_COLLECTOR_DIAGNOSTIC": True,
                "__REALTIME_TIMESTAMP": str(int(last_timestamp * 1_000_000))
                if last_timestamp > 0
                else "0",
            }
        )
    return records


def normalize_systemd_record(record: Mapping[str, object], now: float) -> list[dict[str, object]]:
    unit = record.get("_SYSTEMD_UNIT")
    collector_diagnostic = record.get("_ESMII_COLLECTOR_DIAGNOSTIC") is True
    if collector_diagnostic:
        unit = COLLECTOR_DIAGNOSTIC_SERVICE
        environments = ("staging", "production")
    else:
        if not isinstance(unit, str) or unit not in SYSTEMD_LOG_SOURCES:
            return []
        environments = SYSTEMD_LOG_SOURCES[unit]
    raw_timestamp = record.get("__REALTIME_TIMESTAMP")
    timestamp = journal_timestamp(raw_timestamp, now)
    if timestamp > now + 60:
        timestamp = now
    message = record.get("MESSAGE", "")
    priority = record.get("PRIORITY")
    try:
        priority_number = int(str(priority))
    except ValueError:
        priority_number = 7
    payload: dict[str, object] = {"message": message}
    if priority_number <= 3:
        payload["level"] = "error"
    elif priority_number == 4:
        payload["level"] = "warning"

    normalized: list[dict[str, object]] = []
    timestamp_text = datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")
    line = f"{timestamp_text} {json.dumps(payload, separators=(',', ':'))}"
    for environment in environments:
        normalized.extend(
            normalize_line(
                line=line,
                service=unit,
                default_environment=environment,
                now=now,
            )
        )
    return normalized


def collect(
    *,
    staging_output: Path,
    production_output: Path,
    state_path: Path,
    runner: CommandRunner = default_runner,
    now: float | None = None,
    output_group: int = 10003,
) -> None:
    observed_at = time.time() if now is None else now
    inventory = docker_inventory(runner)
    selected, _counts = select_service_containers(inventory)
    state = read_json_object(state_path)
    cursors = state.get("cursors")
    cursors = cursors if isinstance(cursors, dict) else {}
    next_cursors: dict[str, float] = {}

    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    database_descriptor, database_name = tempfile.mkstemp(
        prefix=".log-collector.", suffix=".sqlite", dir=state_path.parent
    )
    os.close(database_descriptor)
    os.chmod(database_name, 0o600)
    database = sqlite3.connect(database_name)
    database.execute("PRAGMA journal_mode=OFF")
    database.execute("PRAGMA synchronous=OFF")
    database.execute("PRAGMA temp_store=FILE")
    database.execute("PRAGMA cache_size=-2048")
    database.execute(
        "CREATE TABLE entries(environment TEXT NOT NULL,id TEXT NOT NULL,timestamp_unix REAL NOT NULL,line TEXT NOT NULL,line_bytes INTEGER NOT NULL,PRIMARY KEY(environment,id))"
    )
    try:
        for entry in iter_snapshot(staging_output, "staging"):
            store_entry(database, entry)
        for entry in iter_snapshot(production_output, "production"):
            store_entry(database, entry)

        for definition in MONITORED_SERVICES:
            name = definition.compose_service
            container = selected.get(name)
            prior_cursor = safe_timestamp(cursors.get(name, 0.0))
            latest_cursor = prior_cursor
            if container is None:
                next_cursors[name] = latest_cursor
                continue
            lines = collect_logs_for_container(container=container, since=prior_cursor, runner=runner)
            for line in lines:
                timestamp, _payload = _timestamp_prefix(line)
                if timestamp > 0:
                    latest_cursor = max(latest_cursor, timestamp)
                for entry in normalize_line(
                    line=line,
                    service=name,
                    default_environment=definition.environment,
                    now=observed_at,
                ):
                    store_entry(database, entry)
            next_cursors[name] = latest_cursor

        systemd_cursor = safe_timestamp(cursors.get("systemd", 0.0))
        latest_systemd_cursor = systemd_cursor
        for record in collect_systemd_logs(since=systemd_cursor, runner=runner):
            record_timestamp = journal_timestamp(record.get("__REALTIME_TIMESTAMP", 0.0))
            latest_systemd_cursor = max(latest_systemd_cursor, record_timestamp)
            for entry in normalize_systemd_record(record, observed_at):
                store_entry(database, entry)
        next_cursors["systemd"] = latest_systemd_cursor

        database.commit()
        write_database_snapshot(
            database,
            environment="staging",
            path=staging_output,
            now=observed_at,
            output_group=output_group,
        )
        write_database_snapshot(
            database,
            environment="production",
            path=production_output,
            now=observed_at,
            output_group=output_group,
        )
        write_json_object(state_path, {"cursors": next_cursors, "version": 1})
    finally:
        database.close()
        Path(database_name).unlink(missing_ok=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--staging-output",
        type=Path,
        default=Path("/var/lib/esmii/monitoring/staging/logs/services.ndjson"),
    )
    result.add_argument(
        "--production-output",
        type=Path,
        default=Path("/var/lib/esmii/monitoring/production/logs/services.ndjson"),
    )
    result.add_argument(
        "--state",
        type=Path,
        default=Path("/var/lib/esmii/monitoring/shared/state/log-collector.json"),
    )
    return result


def main(arguments: Sequence[str] | None = None) -> int:
    options = parser().parse_args(arguments)
    collect(
        staging_output=options.staging_output,
        production_output=options.production_output,
        state_path=options.state,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
