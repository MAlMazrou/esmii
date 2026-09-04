from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MONITORING_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MONITORING_ROOT))

from container_metrics_collector import (  # noqa: E402
    _heartbeat_from_logs,
    collect,
    update_restart_state,
)


NOW = 1_788_350_400.0


def completed(arguments: tuple[str, ...], stdout: str = "", returncode: int = 0):
    return subprocess.CompletedProcess(arguments, returncode, stdout, "")


def api_container(restarts: int = 0):
    return {
        "Id": "a" * 64,
        "Created": "2026-09-02T12:00:00Z",
        "RestartCount": restarts,
        "Config": {
            "Labels": {
                "com.docker.compose.project": "esmii",
                "com.docker.compose.service": "staging-api",
            }
        },
        "State": {
            "Running": True,
            "OOMKilled": False,
            "StartedAt": "2026-09-02T12:00:00Z",
            "Health": {"Status": "healthy"},
        },
    }


class ContainerMetricsCollectorTests(unittest.TestCase):
    def test_worker_heartbeat_reader_discards_an_oversized_line_and_continues(self):
        sentinel = "worker-secret-tail"
        heartbeat_timestamp = "2026-09-02T11:59:59Z"

        def runner(arguments):
            return completed(
                tuple(arguments),
                (
                    f"2026-09-02T11:59:58Z ERROR {sentinel * 10_000}\n"
                    f'{heartbeat_timestamp} {{"event":"worker_heartbeat"}}\n'
                ),
            )

        heartbeat = _heartbeat_from_logs(api_container(), NOW - 30, runner)
        self.assertEqual(heartbeat, NOW - 1)

    def test_restart_state_tracks_current_rolling_and_last_restart(self):
        first_state, first_values = update_restart_state({}, {"staging-api": api_container(1)}, NOW)
        self.assertEqual(first_values["staging-api"]["current"], 1)
        self.assertEqual(first_values["staging-api"]["rolling"], 1)

        second = api_container(3)
        second["State"]["StartedAt"] = "2026-09-02T12:01:00Z"
        _, second_values = update_restart_state(first_state, {"staging-api": second}, NOW + 60)
        self.assertEqual(second_values["staging-api"]["current"], 3)
        self.assertEqual(second_values["staging-api"]["rolling"], 3)
        self.assertGreater(second_values["staging-api"]["last_restart"], 0)

    def test_collector_writes_only_fixed_numeric_metric_families(self):
        inspected = [api_container(2)]

        def runner(arguments):
            arguments = tuple(arguments)
            if arguments[1:4] == ("container", "ls", "--all"):
                return completed(arguments, "a" * 64 + "\n")
            if arguments[1:3] == ("container", "inspect"):
                return completed(arguments, json.dumps(inspected))
            if arguments[1] == "stats":
                row = {
                    "ID": "a" * 12,
                    "CPUPerc": "4.25%",
                    "MemUsage": "12MiB / 256MiB",
                    "NetIO": "3MB / 4MB",
                    "BlockIO": "5MB / 6MB",
                    "PIDs": "7",
                }
                return completed(arguments, json.dumps(row) + "\n")
            if arguments[0:2] == ("/usr/bin/systemctl", "show"):
                units = [value for value in arguments[2:] if value.endswith((".timer", ".service"))]
                blocks = []
                for unit in units:
                    blocks.append(
                        "\n".join(
                            (
                                f"Id={unit}",
                                "ActiveState=active",
                                "LastTriggerUSec=Wed 2026-09-02 12:00:00 UTC",
                                "NextElapseUSecRealtime=Wed 2026-09-02 12:05:00 UTC",
                                "Result=success",
                                "ExecMainStatus=0",
                                "InactiveExitTimestamp=Wed 2026-09-02 12:00:01 UTC",
                            )
                        )
                    )
                return completed(arguments, "\n\n".join(blocks) + "\n")
            self.fail(f"unexpected command: {arguments}")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging_record = root / "staging.env"
            staging_record.write_text(
                "REVISION=" + "b" * 40 + "\nAPP_VERSION=v1.2.3\nSECRET=must-not-appear\n",
                encoding="utf-8",
            )
            output = root / "metrics.prom"
            state = root / "state.json"
            collect(
                output_path=output,
                state_path=state,
                runner=runner,
                now=NOW,
                deployment_records={"staging": staging_record},
            )
            rendered = output.read_text(encoding="utf-8")

        self.assertIn('esmii_container_running{environment="staging",service="staging-api"} 1.000000', rendered)
        self.assertIn('esmii_container_restart_count_rolling_24h{environment="staging",service="staging-api"} 2.000000', rendered)
        self.assertIn('esmii_container_cpu_percent{environment="staging",service="staging-api"} 4.250000', rendered)
        self.assertIn('revision="' + "b" * 40 + '"', rendered)
        self.assertIn(
            'esmii_systemd_timer_active{environment="staging",unit="esmii-deployment-reconciler.timer"}',
            rendered,
        )
        self.assertNotIn(
            'esmii_systemd_timer_active{environment="shared",unit="esmii-deployment-reconciler.timer"}',
            rendered,
        )
        self.assertIn(
            'esmii_systemd_timer_active{environment="shared",unit="esmii-container-metrics-collector.timer"}',
            rendered,
        )
        self.assertIn(
            'esmii_systemd_timer_active{environment="shared",unit="esmii-log-collector.timer"}',
            rendered,
        )
        self.assertNotIn("must-not-appear", rendered)
        self.assertNotIn("container_id", rendered)


if __name__ == "__main__":
    unittest.main()
