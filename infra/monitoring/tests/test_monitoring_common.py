from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path


MONITORING_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MONITORING_ROOT))

from monitoring_common import (  # noqa: E402
    MONITORED_SERVICES,
    docker_inventory,
    parse_pair,
    parse_rfc3339,
    parse_size,
    select_service_containers,
)


def completed(arguments: tuple[str, ...], stdout: str = "", returncode: int = 0):
    return subprocess.CompletedProcess(arguments, returncode, stdout, "")


def container(identifier: str, service: str, *, project: str = "esmii", running: bool = True):
    return {
        "Id": identifier,
        "Created": "2026-09-02T12:00:00Z",
        "Config": {
            "Labels": {
                "com.docker.compose.project": project,
                "com.docker.compose.service": service,
            }
        },
        "State": {"Running": running},
    }


class MonitoringCommonTests(unittest.TestCase):
    def test_allowlist_is_the_exact_thirteen_steady_services(self):
        self.assertEqual(
            [item.compose_service for item in MONITORED_SERVICES],
            [
                "caddy",
                "staging-web",
                "staging-api",
                "staging-worker",
                "staging-postgres",
                "staging-valkey",
                "staging-mailpit",
                "production-web",
                "production-api",
                "production-worker",
                "production-postgres",
                "production-valkey",
                "production-stalwart",
            ],
        )

    def test_inventory_rechecks_project_and_service_allowlists(self):
        rows = [
            container("a" * 64, "staging-api"),
            container("b" * 64, "unknown-service"),
            container("c" * 64, "production-api", project="other"),
        ]

        def runner(arguments):
            arguments = tuple(arguments)
            if arguments[1:4] == ("container", "ls", "--all"):
                return completed(arguments, "\n".join(row["Id"] for row in rows) + "\n")
            if arguments[1:3] == ("container", "inspect"):
                return completed(arguments, json.dumps(rows))
            self.fail(f"unexpected command: {arguments}")

        self.assertEqual([row["Id"] for row in docker_inventory(runner)], ["a" * 64])

    def test_container_selection_prefers_running_candidate(self):
        stopped = container("a" * 64, "staging-api", running=False)
        running = container("b" * 64, "staging-api", running=True)
        selected, counts = select_service_containers([stopped, running])
        self.assertEqual(counts, {"staging-api": 2})
        self.assertEqual(selected["staging-api"]["Id"], "b" * 64)

    def test_size_pair_and_timestamp_parsers_fail_closed(self):
        self.assertEqual(parse_size("1.5 MiB"), 1.5 * 1024 * 1024)
        self.assertEqual(parse_pair("2MB / 3GB"), (2_000_000, 3_000_000_000))
        self.assertEqual(parse_size("1 PB"), 0)
        self.assertEqual(parse_pair("not-a-pair"), (0, 0))
        self.assertEqual(parse_rfc3339("not-a-date"), 0)
        self.assertGreater(parse_rfc3339("2026-09-02T12:00:00.123456789Z"), 0)


if __name__ == "__main__":
    unittest.main()
