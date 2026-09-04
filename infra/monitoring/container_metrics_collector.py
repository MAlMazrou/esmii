#!/usr/bin/env python3
"""Collect a fixed, sanitized Esmii container/operation metric set.

The collector is intentionally a root-owned host oneshot. It never exposes the
Docker socket to a container and writes only Prometheus textfile metrics.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from pathlib import Path
from typing import Mapping, Sequence

from log_collector import run_bounded_log_command
from monitoring_common import (
    MIGRATION_SERVICES,
    MONITORED_SERVICES,
    CommandRunner,
    atomic_write,
    default_runner,
    docker_inventory,
    parse_pair,
    parse_rfc3339,
    parse_systemd_timestamp,
    prometheus_labels,
    read_json_object,
    run_checked,
    select_service_containers,
    write_json_object,
)


ROLLING_RESTART_SECONDS = 24 * 60 * 60
DEPLOYMENT_RECORDS = {
    "staging": Path("/var/lib/esmii/staging-pull/current.env"),
    "production": Path("/var/lib/esmii/production-pull/current.env"),
}
TIMER_UNITS = {
    "esmii-staging-pull.timer": "staging",
    "esmii-production-pull.timer": "production",
    "esmii-deployment-reconciler.timer": "staging",
    "esmii-health-check.timer": "shared",
    "esmii-host-prune.timer": "shared",
    "esmii-maintenance.timer": "shared",
    "esmii-database-backup.timer": "production",
    "esmii-state-backup.timer": "production",
    "esmii-restore-check.timer": "production",
    "esmii-container-metrics-collector.timer": "shared",
    "esmii-log-collector.timer": "shared",
}


def _finite(value: object) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return parsed if math.isfinite(parsed) else 0.0


def _percentage(value: object) -> float:
    if not isinstance(value, str):
        return 0.0
    return _finite(value.strip().removesuffix("%"))


def _container_identifier(container: Mapping[str, object]) -> str:
    identifier = container.get("Id")
    return identifier if isinstance(identifier, str) else ""


def _container_state(container: Mapping[str, object]) -> Mapping[str, object]:
    state = container.get("State")
    return state if isinstance(state, dict) else {}


def collect_stats(
    containers: Mapping[str, Mapping[str, object]], runner: CommandRunner
) -> dict[str, dict[str, float]]:
    running_ids = [
        _container_identifier(container)
        for container in containers.values()
        if _container_state(container).get("Running") is True and _container_identifier(container)
    ]
    if not running_ids:
        return {}
    output = run_checked(
        runner,
        (
            "/usr/bin/docker",
            "stats",
            "--no-stream",
            "--format",
            "{{json .}}",
            *running_ids,
        ),
    )
    by_identifier: dict[str, dict[str, float]] = {}
    for line in output.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        short_identifier = row.get("ID")
        if not isinstance(short_identifier, str):
            continue
        memory_usage, memory_limit = parse_pair(row.get("MemUsage"))
        network_receive, network_transmit = parse_pair(row.get("NetIO"))
        block_read, block_write = parse_pair(row.get("BlockIO"))
        by_identifier[short_identifier] = {
            "cpu_percent": _percentage(row.get("CPUPerc")),
            "memory_usage_bytes": memory_usage,
            "memory_limit_bytes": memory_limit,
            "network_receive_bytes": network_receive,
            "network_transmit_bytes": network_transmit,
            "block_read_bytes": block_read,
            "block_write_bytes": block_write,
            "pids": _finite(row.get("PIDs")),
        }

    result: dict[str, dict[str, float]] = {}
    for service_name, container in containers.items():
        identifier = _container_identifier(container)
        for short_identifier, values in by_identifier.items():
            if identifier.startswith(short_identifier):
                result[service_name] = values
                break
    return result


def _heartbeat_from_logs(
    container: Mapping[str, object], since: float, runner: CommandRunner
) -> float:
    identifier = _container_identifier(container)
    if not identifier:
        return since
    since_value = max(0.0, since - 2.0)
    result = run_bounded_log_command(
        (
            "/usr/bin/docker",
            "container",
            "logs",
            "--timestamps",
            "--since",
            f"{since_value:.3f}",
            "--tail",
            "1000",
            identifier,
        ),
        runner=runner,
    )
    if result.returncode != 0 and not result.input_truncated:
        return since
    latest = since
    for line in result.lines:
        if line.text is None:
            continue
        timestamp_raw, separator, payload = line.text.partition(" ")
        if not separator:
            continue
        timestamp = parse_rfc3339(timestamp_raw)
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("event") == "worker_heartbeat":
            latest = max(latest, timestamp)
    return latest


def update_restart_state(
    previous: Mapping[str, object],
    containers: Mapping[str, Mapping[str, object]],
    now: float,
) -> tuple[dict[str, object], dict[str, dict[str, float]]]:
    previous_services = previous.get("services")
    if not isinstance(previous_services, dict):
        previous_services = {}
    next_services: dict[str, object] = {}
    values: dict[str, dict[str, float]] = {}

    for definition in MONITORED_SERVICES:
        name = definition.compose_service
        container = containers.get(name)
        old = previous_services.get(name)
        old = old if isinstance(old, dict) else {}
        old_events = old.get("restart_events")
        events = [
            _finite(event)
            for event in old_events
            if _finite(event) >= now - ROLLING_RESTART_SECONDS
        ] if isinstance(old_events, list) else []
        last_restart = _finite(old.get("last_restart"))

        if container is None:
            next_services[name] = {
                "container_id": "",
                "restart_count": 0,
                "restart_events": events,
                "last_restart": last_restart,
            }
            values[name] = {
                "current": 0.0,
                "rolling": float(len(events)),
                "last_restart": last_restart,
            }
            continue

        identifier = _container_identifier(container)
        state = _container_state(container)
        started_at = parse_rfc3339(state.get("StartedAt"))
        current = int(_finite(container.get("RestartCount")))
        previous_identifier = old.get("container_id")
        previous_count = int(_finite(old.get("restart_count")))

        if identifier == previous_identifier and current > previous_count:
            events.extend([started_at or now] * (current - previous_count))
            last_restart = started_at or now
        elif identifier != previous_identifier and current > 0:
            # Docker does not retain individual restart timestamps. On first
            # observation seed the known current count at the last start time.
            events.extend([started_at or now] * current)
            last_restart = started_at or now

        events = sorted(event for event in events if event >= now - ROLLING_RESTART_SECONDS)
        next_services[name] = {
            "container_id": identifier,
            "restart_count": current,
            "restart_events": events,
            "last_restart": last_restart,
        }
        values[name] = {
            "current": float(current),
            "rolling": float(len(events)),
            "last_restart": last_restart,
        }

    return {"version": 1, "services": next_services}, values


def collect_systemd(runner: CommandRunner) -> dict[str, dict[str, str]]:
    units = [*TIMER_UNITS, *(unit.removesuffix(".timer") + ".service" for unit in TIMER_UNITS)]
    output = run_checked(
        runner,
        (
            "/usr/bin/systemctl",
            "show",
            *units,
            "--property=Id",
            "--property=ActiveState",
            "--property=LastTriggerUSec",
            "--property=NextElapseUSecRealtime",
            "--property=Result",
            "--property=ExecMainStatus",
            "--property=InactiveExitTimestamp",
        ),
    )
    result: dict[str, dict[str, str]] = {}
    for block in output.strip().split("\n\n"):
        properties: dict[str, str] = {}
        for line in block.splitlines():
            key, separator, value = line.partition("=")
            if separator:
                properties[key] = value
        identifier = properties.get("Id")
        if identifier in units:
            result[identifier] = properties
    return result


def read_deployment_record(path: Path) -> tuple[bool, float, str, str]:
    if not path.is_file() or path.is_symlink():
        return (False, 0.0, "", "")
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"REVISION", "APP_VERSION"}:
            values[key] = value
    revision = values.get("REVISION", "")
    version = values.get("APP_VERSION", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        revision = ""
    if not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.[0-9]+\.[0-9]+", version):
        version = ""
    return (True, path.stat().st_mtime, revision, version)


class MetricDocument:
    def __init__(self) -> None:
        self._lines: list[str] = []
        self._declared: set[str] = set()

    def sample(
        self,
        name: str,
        help_text: str,
        metric_type: str,
        value: float,
        labels: Mapping[str, object],
    ) -> None:
        if name not in self._declared:
            self._lines.extend((f"# HELP {name} {help_text}", f"# TYPE {name} {metric_type}"))
            self._declared.add(name)
        self._lines.append(f"{name}{prometheus_labels(labels)} {value:.6f}")

    def render(self) -> str:
        return "\n".join(self._lines) + "\n"


def collect(
    *,
    output_path: Path,
    state_path: Path,
    runner: CommandRunner = default_runner,
    now: float | None = None,
    deployment_records: Mapping[str, Path] = DEPLOYMENT_RECORDS,
) -> None:
    observed_at = time.time() if now is None else now
    inventory = docker_inventory(runner)
    selected, counts = select_service_containers(inventory)
    runtime_containers = {name: selected[name] for name in selected if name in {s.compose_service for s in MONITORED_SERVICES}}
    statistics = collect_stats(runtime_containers, runner)

    previous = read_json_object(state_path)
    restart_state, restart_values = update_restart_state(previous, runtime_containers, observed_at)
    old_heartbeats = previous.get("worker_heartbeats")
    old_heartbeats = old_heartbeats if isinstance(old_heartbeats, dict) else {}
    heartbeats: dict[str, float] = {}
    for service in MONITORED_SERVICES:
        if not service.worker:
            continue
        previous_heartbeat = _finite(old_heartbeats.get(service.compose_service))
        container = runtime_containers.get(service.compose_service)
        heartbeats[service.compose_service] = (
            _heartbeat_from_logs(container, previous_heartbeat, runner)
            if container is not None
            else previous_heartbeat
        )
    restart_state["worker_heartbeats"] = heartbeats

    systemd = collect_systemd(runner)
    document = MetricDocument()
    health_codes = {"none": 0.0, "starting": 1.0, "healthy": 2.0, "unhealthy": 3.0}

    for service in MONITORED_SERVICES:
        name = service.compose_service
        labels = {"environment": service.environment, "service": name}
        container = runtime_containers.get(name)
        state = _container_state(container) if container is not None else {}
        health = state.get("Health")
        health_status = health.get("Status") if isinstance(health, dict) else "none"
        health_status = health_status if health_status in health_codes else "none"
        started_at = parse_rfc3339(state.get("StartedAt"))

        document.sample("esmii_container_expected", "Expected steady-state Esmii container.", "gauge", 1, labels)
        document.sample("esmii_container_instance_count", "Observed instances for the Compose service.", "gauge", counts.get(name, 0), labels)
        document.sample("esmii_container_running", "Whether the selected container is running.", "gauge", 1 if state.get("Running") is True else 0, labels)
        document.sample("esmii_container_healthcheck_configured", "Whether Docker health is configured.", "gauge", 1 if isinstance(health, dict) else 0, labels)
        document.sample("esmii_container_health_status", "Docker health code: 0 none, 1 starting, 2 healthy, 3 unhealthy.", "gauge", health_codes[health_status], labels)
        document.sample("esmii_container_oom_killed", "Whether the selected container was OOM-killed.", "gauge", 1 if state.get("OOMKilled") is True else 0, labels)
        document.sample("esmii_container_started_timestamp_seconds", "Current container start time.", "gauge", started_at, labels)
        document.sample("esmii_container_restart_count_current", "Docker restart count for the current container object.", "gauge", restart_values[name]["current"], labels)
        document.sample("esmii_container_restart_count_rolling_24h", "Observed Docker restarts in the last 24 hours.", "gauge", restart_values[name]["rolling"], labels)
        document.sample("esmii_container_last_restart_timestamp_seconds", "Last observed Docker restart time, excluding deployments.", "gauge", restart_values[name]["last_restart"], labels)

        for suffix, help_text in (
            ("cpu_percent", "Instantaneous container CPU percentage."),
            ("memory_usage_bytes", "Container memory usage."),
            ("memory_limit_bytes", "Container memory limit reported by Docker."),
            ("network_receive_bytes", "Container network bytes received."),
            ("network_transmit_bytes", "Container network bytes transmitted."),
            ("block_read_bytes", "Container block bytes read."),
            ("block_write_bytes", "Container block bytes written."),
            ("pids", "Container process count."),
        ):
            document.sample(
                f"esmii_container_{suffix}",
                help_text,
                "gauge",
                statistics.get(name, {}).get(suffix, 0.0),
                labels,
            )

        if service.worker:
            heartbeat = heartbeats.get(name, 0.0)
            document.sample("esmii_worker_heartbeat_timestamp_seconds", "Last observed worker heartbeat.", "gauge", heartbeat, labels)
            document.sample("esmii_worker_heartbeat_age_seconds", "Age of the last observed worker heartbeat.", "gauge", max(0.0, observed_at - heartbeat) if heartbeat else 0.0, labels)

    for migration_service, environment in MIGRATION_SERVICES.items():
        migration = selected.get(migration_service)
        state = _container_state(migration) if migration is not None else {}
        document.sample(
            "esmii_migration_active",
            "Whether an allowlisted one-shot migration container is running.",
            "gauge",
            1 if state.get("Running") is True else 0,
            {"environment": environment, "service": migration_service},
        )

    for environment, path in deployment_records.items():
        present, timestamp, revision, version = read_deployment_record(path)
        labels = {"environment": environment}
        document.sample("esmii_deployment_record_present", "Whether the environment activation record exists.", "gauge", 1 if present else 0, labels)
        document.sample("esmii_deployment_last_success_timestamp_seconds", "Timestamp of the last committed environment activation record.", "gauge", timestamp, labels)
        document.sample("esmii_migration_last_success_timestamp_seconds", "Conservative timestamp of the last activation that completed migration.", "gauge", timestamp, labels)
        if revision and version:
            document.sample("esmii_deployment_info", "Current recorded source revision and application version.", "gauge", 1, {**labels, "revision": revision, "version": version})

    for timer, environment in TIMER_UNITS.items():
        timer_values = systemd.get(timer, {})
        service_values = systemd.get(timer.removesuffix(".timer") + ".service", {})
        labels = {"environment": environment, "unit": timer}
        document.sample("esmii_systemd_timer_active", "Whether an allowlisted Esmii timer is active.", "gauge", 1 if timer_values.get("ActiveState") == "active" else 0, labels)
        document.sample("esmii_systemd_timer_last_trigger_timestamp_seconds", "Last trigger time for an allowlisted Esmii timer.", "gauge", parse_systemd_timestamp(timer_values.get("LastTriggerUSec")), labels)
        document.sample("esmii_systemd_timer_next_trigger_timestamp_seconds", "Next trigger time for an allowlisted Esmii timer.", "gauge", parse_systemd_timestamp(timer_values.get("NextElapseUSecRealtime")), labels)
        document.sample("esmii_systemd_service_last_run_success", "Whether the paired oneshot last completed successfully.", "gauge", 1 if service_values.get("Result") == "success" and service_values.get("ExecMainStatus") in {"0", ""} else 0, labels)
        document.sample("esmii_systemd_service_last_exit_timestamp_seconds", "Last exit time for the paired oneshot.", "gauge", parse_systemd_timestamp(service_values.get("InactiveExitTimestamp")), labels)

    document.sample("esmii_monitoring_collector_last_success_timestamp_seconds", "Last successful metrics collection.", "gauge", observed_at, {"environment": "shared"})
    atomic_write(output_path, document.render(), 0o644)
    write_json_object(state_path, restart_state)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--output",
        type=Path,
        default=Path("/var/lib/esmii/monitoring/shared/textfiles/esmii-containers.prom"),
    )
    result.add_argument(
        "--state",
        type=Path,
        default=Path("/var/lib/esmii/monitoring/shared/state/container-metrics.json"),
    )
    return result


def main(arguments: Sequence[str] | None = None) -> int:
    options = parser().parse_args(arguments)
    collect(output_path=options.output, state_path=options.state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
