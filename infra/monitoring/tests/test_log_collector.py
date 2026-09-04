from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MONITORING_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MONITORING_ROOT))

from log_collector import (  # noqa: E402
    MAX_FILE_BYTES,
    MAX_MESSAGE_BYTES,
    MAX_RAW_COMMAND_BYTES,
    MAX_RAW_LINE_BYTES,
    RAW_TRUNCATION_MESSAGE,
    SYSTEMD_LOG_SOURCES,
    _timestamp_prefix,
    bound_entries,
    collect,
    collect_logs_for_container,
    collect_systemd_logs,
    normalize_line,
    normalize_systemd_record,
    redact,
    render_snapshot,
    run_bounded_log_command,
)


NOW = 1_788_350_400.0


def completed(arguments: tuple[str, ...], stdout: str = "", returncode: int = 0):
    return subprocess.CompletedProcess(arguments, returncode, stdout, "")


class LogCollectorTests(unittest.TestCase):
    def test_redaction_removes_sensitive_and_unbounded_material(self):
        hostile = (
            "\x1b[31mERROR authorization=Bearer.top cookie=session-value "
            "email=operator@example.com ip=203.0.113.12 "
            "url=https://user:pass@example.com/api/auth/callback?code=unique-code "
            "operator=/api/operator-auth/two-factor/verify-totp?code=operator-code "
            "relative=/verify/magic-value?token=relative-token other=/ordinary?code=query-code "
            "TOTP secret ABCDEFGH env=VALUE DATABASE_URL=postgres://db:pw@host/db "
            "command=/usr/bin/tool SQL=SELECT 'secret-value' FROM users "
            "/etc/myapp/secrets/password\n  at secret (/srv/app/private.js:12:4)"
        )
        sanitized = redact(hostile)
        for sentinel in (
            "Bearer.top",
            "session-value",
            "operator@example.com",
            "203.0.113.12",
            "unique-code",
            "operator-code",
            "magic-value",
            "relative-token",
            "query-code",
            "ABCDEFGH",
            "postgres://",
            "secret-value",
            "/etc/myapp",
            "/srv/app",
            "\x1b",
        ):
            self.assertNotIn(sentinel, sanitized)
        self.assertLessEqual(len(sanitized.encode("utf-8")), MAX_MESSAGE_BYTES)

    def test_redaction_consumes_complete_sensitive_headers_and_multiword_values(self):
        cases = {
            "Authorization: Bearer super-secret-token": ("super-secret-token",),
            "Proxy-Authorization=Basic cHJveHk6c2VjcmV0": ("cHJveHk6c2VjcmV0",),
            "Cookie: session=first; csrf=second": ("first", "second"),
            "Set-Cookie: session=third; Path=/; Secure": ("third",),
            "ERROR password=correct horse battery staple": (
                "correct",
                "horse",
                "battery",
                "staple",
            ),
        }
        for raw, sentinels in cases.items():
            with self.subTest(raw=raw):
                sanitized = redact(raw)
                self.assertIn("[REDACTED]", sanitized)
                for sentinel in sentinels:
                    self.assertNotIn(sentinel, sanitized)

    def test_redaction_covers_normalized_token_and_secret_key_names(self):
        for key in (
            "access_token",
            "refresh_token",
            "id_token",
            "csrf_token",
            "client_secret",
            "session",
            "api_token",
            "auth_token",
            "smtp_password",
            "API key",
        ):
            with self.subTest(key=key):
                sanitized = redact(f"ERROR {key}=Zx91kLmN23")
                self.assertNotIn("Zx91kLmN23", sanitized)
                self.assertIn("[REDACTED]", sanitized)
        natural_language = redact("ERROR password is correct horse battery staple")
        for sentinel in ("correct", "horse", "battery", "staple"):
            self.assertNotIn(sentinel, natural_language)

    def test_redaction_removes_quoted_and_nested_sensitive_fields(self):
        hostile = (
            'ERROR request body {"password":"correct horse battery staple",'
            '"token":"opaque-token","cookie":"sid=session-secret",'
            '"authorization":"Bearer abc.def",'
            '"body":{"set-cookie":"refresh=hidden","safe":"omitted conservatively"}}'
        )
        sanitized = redact(hostile)
        for sentinel in (
            "correct",
            "horse",
            "battery",
            "staple",
            "opaque-token",
            "session-secret",
            "abc.def",
            "refresh=hidden",
            "omitted conservatively",
        ):
            self.assertNotIn(sentinel, sanitized)
        self.assertIn("[REDACTED]", sanitized)

    def test_redaction_decodes_escaped_keys_and_double_encoded_json(self):
        cases = {
            r'ERROR payload {"pass\u0077ord":"escaped-key-secret"}': "escaped-key-secret",
            r'ERROR diagnostic "prefix {\"nested\":{\"to\u006ben\":\"double-encoded-secret\"}}"': "double-encoded-secret",
            r'ERROR payload {"pass\u0077ord":"malformed-secret"': "malformed-secret",
        }
        for raw, sentinel in cases.items():
            with self.subTest(raw=raw):
                sanitized = redact(raw)
                self.assertNotIn(sentinel, sanitized)
                self.assertIn("[REDACTED]", sanitized)

        legitimate = 'ERROR detail {"worker":"delayed","attempt":2}'
        self.assertEqual(redact(legitimate), legitimate)
        bracketed = "ERROR worker [job-1] failed with template {name}"
        self.assertEqual(redact(bracketed), bracketed)

    def test_caddy_errors_are_routed_by_exact_host(self):
        staging = normalize_line(
            line='2026-09-02T12:00:00Z {"status":502,"msg":"upstream failed","request":{"host":"staging.esmii.app"}}',
            service="caddy",
            default_environment="shared",
            now=NOW,
        )
        production = normalize_line(
            line='2026-09-02T12:00:00Z {"status":503,"msg":"upstream failed","request":{"host":"esmii.app"}}',
            service="caddy",
            default_environment="shared",
            now=NOW,
        )
        unknown = normalize_line(
            line='2026-09-02T12:00:00Z {"status":500,"msg":"failed","request":{"host":"attacker.invalid"}}',
            service="caddy",
            default_environment="shared",
            now=NOW,
        )
        self.assertEqual([item["environment"] for item in staging], ["staging"])
        self.assertEqual([item["environment"] for item in production], ["production"])
        self.assertEqual(unknown, [])

    def test_caddy_records_without_a_recognized_host_never_cross_environments(self):
        for message in (
            "dial production-dashboard:3000: connection refused",
            "staging-dashboard.esmii.app upstream failed",
        ):
            with self.subTest(message=message):
                result = normalize_line(
                    line=(
                        '2026-09-02T12:00:00Z {"level":"error","msg":'
                        + json.dumps(message)
                        + "}"
                    ),
                    service="caddy",
                    default_environment="shared",
                    now=NOW,
                )
                self.assertEqual(result, [])

    def test_request_ids_keep_only_internal_generated_formats(self):
        safe = normalize_line(
            line='2026-09-02T12:00:00Z {"level":"error","msg":"failed","requestId":"req-42"}',
            service="staging-api",
            default_environment="staging",
            now=NOW,
        )
        self.assertEqual(safe[0]["requestId"], "req-42")
        for hostile in ("192.0.2.10", "sk_live_opaque_secret", "req-sk-live-secret"):
            with self.subTest(hostile=hostile):
                result = normalize_line(
                    line=(
                        '2026-09-02T12:00:00Z {"level":"error","msg":"failed","requestId":'
                        + json.dumps(hostile)
                        + "}"
                    ),
                    service="staging-api",
                    default_environment="staging",
                    now=NOW,
                )
                self.assertNotIn("requestId", result[0])

    def test_systemd_reader_passes_only_the_fixed_unit_allowlist(self):
        record = {
            "_SYSTEMD_UNIT": "esmii-health-check.service",
            "__REALTIME_TIMESTAMP": str(int(NOW * 1_000_000)),
            "PRIORITY": "4",
            "MESSAGE": "warning: capacity threshold reached",
        }

        def runner(arguments):
            arguments = tuple(arguments)
            units = {value.removeprefix("--unit=") for value in arguments if value.startswith("--unit=")}
            self.assertEqual(units, set(SYSTEMD_LOG_SOURCES))
            return completed(arguments, json.dumps(record) + "\n" + json.dumps({**record, "_SYSTEMD_UNIT": "ssh.service"}) + "\n")

        self.assertEqual(collect_systemd_logs(since=NOW - 30, runner=runner), [record])

    def test_streaming_reader_stops_oversized_output_without_retaining_a_secret_tail(self):
        command = (
            sys.executable,
            "-c",
            "import os\nchunk=b'raw-secret-tail-'*4096\nwhile True: os.write(1,chunk)",
        )
        result = run_bounded_log_command(
            command,
            aggregate_bytes=128 * 1024,
            line_bytes=1024,
            max_lines=10,
            timeout_seconds=5,
        )
        self.assertTrue(result.input_truncated)
        self.assertLessEqual(len(result.lines), 2)
        self.assertTrue(all(line.text is None for line in result.lines))
        self.assertLess(MAX_RAW_COMMAND_BYTES, 64 * 1024 * 1024)
        self.assertLess(MAX_RAW_LINE_BYTES, MAX_RAW_COMMAND_BYTES)

    def test_streaming_reader_enforces_the_hard_line_record_cap(self):
        result = run_bounded_log_command(
            (sys.executable, "-c", "import os\nos.write(1,b'x\\n'*10000)"),
            aggregate_bytes=128 * 1024,
            line_bytes=1024,
            max_lines=10,
            timeout_seconds=5,
        )
        self.assertTrue(result.input_truncated)
        self.assertEqual(len(result.lines), 10)

    def test_oversized_docker_line_emits_a_safe_marker_and_preserves_cursor_timestamp(self):
        timestamp = "2026-09-02T11:59:59Z"
        sentinel = "docker-secret-tail"

        def runner(arguments):
            return completed(tuple(arguments), f"{timestamp} ERROR {sentinel * 10_000}\n")

        lines = collect_logs_for_container(
            container={"Id": "a" * 64},
            since=NOW - 30,
            runner=runner,
        )
        self.assertEqual(len(lines), 1)
        self.assertIn(RAW_TRUNCATION_MESSAGE, lines[0])
        self.assertNotIn(sentinel, lines[0])
        cursor, _payload = _timestamp_prefix(lines[0])
        self.assertEqual(cursor, NOW - 1)
        caddy = normalize_line(
            line=lines[0],
            service="caddy",
            default_environment="shared",
            now=NOW,
        )
        self.assertEqual({entry["environment"] for entry in caddy}, {"staging", "production"})

    def test_aggregate_docker_cap_preserves_only_an_observed_cursor_and_generic_marker(self):
        sentinel = "aggregate-secret-tail"

        def runner(arguments):
            return completed(
                tuple(arguments),
                (
                    '2026-09-02T11:59:58Z {"level":"warning","msg":"safe warning"}\n'
                    f"2026-09-02T11:59:59Z ERROR {sentinel * 300_000}\n"
                ),
            )

        lines = collect_logs_for_container(
            container={"Id": "a" * 64},
            since=NOW - 30,
            runner=runner,
        )
        self.assertTrue(any(RAW_TRUNCATION_MESSAGE in line for line in lines))
        self.assertNotIn(sentinel, "\n".join(lines))
        self.assertEqual(max(_timestamp_prefix(line)[0] for line in lines), NOW - 1)

    def test_oversized_journal_line_keeps_only_safe_metadata_and_marker(self):
        sentinel = "journal-secret-tail"
        record = {
            "MESSAGE": sentinel * 10_000,
            "PRIORITY": "3",
            "__REALTIME_TIMESTAMP": str(int((NOW - 2) * 1_000_000)),
            "_SYSTEMD_UNIT": "esmii-health-check.service",
        }

        def runner(arguments):
            return completed(tuple(arguments), json.dumps(record) + "\n")

        records = collect_systemd_logs(since=NOW - 30, runner=runner)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["MESSAGE"], RAW_TRUNCATION_MESSAGE)
        self.assertEqual(records[0]["_SYSTEMD_UNIT"], "esmii-health-check.service")
        self.assertEqual(records[0]["__REALTIME_TIMESTAMP"], record["__REALTIME_TIMESTAMP"])
        self.assertNotIn(sentinel, json.dumps(records[0]))
        normalized = normalize_systemd_record(records[0], NOW)
        self.assertEqual({entry["environment"] for entry in normalized}, {"staging", "production"})

    def test_collect_duplicates_shared_journal_warning_but_separates_environment_source(self):
        shared = {
            "_SYSTEMD_UNIT": "esmii-health-check.service",
            "__REALTIME_TIMESTAMP": str(int((NOW - 5) * 1_000_000)),
            "PRIORITY": "4",
            "MESSAGE": "warning: disk threshold reached",
        }
        staging = {
            "_SYSTEMD_UNIT": "esmii-staging-pull.service",
            "__REALTIME_TIMESTAMP": str(int((NOW - 4) * 1_000_000)),
            "PRIORITY": "3",
            "MESSAGE": "failed to activate revision",
        }

        def runner(arguments):
            arguments = tuple(arguments)
            if arguments[1:4] == ("container", "ls", "--all"):
                return completed(arguments, "")
            if arguments[0] == "/usr/bin/journalctl":
                return completed(arguments, json.dumps(shared) + "\n" + json.dumps(staging) + "\n")
            self.fail(f"unexpected command: {arguments}")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging_output = root / "staging" / "services.ndjson"
            production_output = root / "production" / "services.ndjson"
            collect(
                staging_output=staging_output,
                production_output=production_output,
                state_path=root / "state.json",
                runner=runner,
                now=NOW,
                output_group=os.getgid(),
            )
            staging_rows = [json.loads(line) for line in staging_output.read_text().splitlines()]
            production_rows = [json.loads(line) for line in production_output.read_text().splitlines()]

        self.assertEqual({row["service"] for row in staging_rows}, {"esmii-health-check.service", "esmii-staging-pull.service"})
        self.assertEqual({row["service"] for row in production_rows}, {"esmii-health-check.service"})

    def test_retention_count_and_byte_caps_keep_newest_entries(self):
        entries = []
        for index in range(12):
            entries.append(
                {
                    "environment": "staging",
                    "id": str(index),
                    "message": "x" * 64,
                    "service": "staging-api",
                    "severity": "warning",
                    "timestamp": "2026-09-02T12:00:00Z",
                    "timestampUnix": NOW - (12 - index),
                }
            )
        entries.append({**entries[0], "id": "expired", "timestampUnix": NOW - 90_000})
        bounded = bound_entries(entries, now=NOW, maximum_entries=5, maximum_bytes=2_000)
        self.assertEqual([entry["id"] for entry in bounded], ["7", "8", "9", "10", "11"])
        self.assertLessEqual(len(render_snapshot(bounded).encode("utf-8")), 2_000)
        self.assertEqual(MAX_FILE_BYTES, 20 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
