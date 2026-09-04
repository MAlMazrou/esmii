#!/usr/bin/env python3
"""Shared, dependency-free helpers for Esmii host monitoring collectors."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence


COMPOSE_PROJECT = "esmii"


@dataclass(frozen=True)
class MonitoredService:
    compose_service: str
    environment: str
    worker: bool = False


MONITORED_SERVICES: tuple[MonitoredService, ...] = (
    MonitoredService("caddy", "shared"),
    MonitoredService("staging-web", "staging"),
    MonitoredService("staging-api", "staging"),
    MonitoredService("staging-worker", "staging", worker=True),
    MonitoredService("staging-postgres", "staging"),
    MonitoredService("staging-valkey", "staging"),
    MonitoredService("staging-mailpit", "staging"),
    MonitoredService("production-web", "production"),
    MonitoredService("production-api", "production"),
    MonitoredService("production-worker", "production", worker=True),
    MonitoredService("production-postgres", "production"),
    MonitoredService("production-valkey", "production"),
    MonitoredService("production-stalwart", "production"),
)

SERVICE_BY_NAME: Mapping[str, MonitoredService] = {
    service.compose_service: service for service in MONITORED_SERVICES
}
MIGRATION_SERVICES: Mapping[str, str] = {
    "staging-migrate": "staging",
    "production-migrate": "production",
}

CommandRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[str]]


def default_runner(arguments: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(arguments),
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        env={"HOME": "/var/empty", "LANG": "C.UTF-8", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        timeout=20,
    )


def run_checked(runner: CommandRunner, arguments: Sequence[str]) -> str:
    result = runner(arguments)
    if result.returncode != 0:
        command = " ".join(arguments[:3])
        raise RuntimeError(f"allowlisted command failed: {command}")
    return result.stdout


def docker_inventory(runner: CommandRunner = default_runner) -> list[dict[str, object]]:
    """Return only containers in the fixed Esmii Compose project.

    Filtering is performed by Docker and then repeated against the inspected
    labels. Callers must still select from the fixed service allowlist.
    """

    raw_ids = run_checked(
        runner,
        (
            "/usr/bin/docker",
            "container",
            "ls",
            "--all",
            "--quiet",
            "--filter",
            f"label=com.docker.compose.project={COMPOSE_PROJECT}",
        ),
    )
    identifiers = [value for value in raw_ids.splitlines() if re.fullmatch(r"[0-9a-f]{12,64}", value)]
    if not identifiers:
        return []

    inspected = json.loads(
        run_checked(runner, ("/usr/bin/docker", "container", "inspect", *identifiers))
    )
    if not isinstance(inspected, list):
        raise RuntimeError("Docker returned an invalid container inventory")

    allowed_names = set(SERVICE_BY_NAME) | set(MIGRATION_SERVICES)
    result: list[dict[str, object]] = []
    for container in inspected:
        if not isinstance(container, dict):
            continue
        config = container.get("Config")
        labels = config.get("Labels") if isinstance(config, dict) else None
        if not isinstance(labels, dict):
            continue
        if labels.get("com.docker.compose.project") != COMPOSE_PROJECT:
            continue
        service_name = labels.get("com.docker.compose.service")
        if service_name not in allowed_names:
            continue
        result.append(container)
    return result


def select_service_containers(
    inventory: Iterable[dict[str, object]],
) -> tuple[dict[str, dict[str, object]], dict[str, int]]:
    candidates: dict[str, list[dict[str, object]]] = {}
    for container in inventory:
        config = container.get("Config")
        labels = config.get("Labels") if isinstance(config, dict) else None
        service_name = labels.get("com.docker.compose.service") if isinstance(labels, dict) else None
        if isinstance(service_name, str):
            candidates.setdefault(service_name, []).append(container)

    selected: dict[str, dict[str, object]] = {}
    counts: dict[str, int] = {}
    for service_name, values in candidates.items():
        counts[service_name] = len(values)
        values.sort(
            key=lambda item: (
                bool((item.get("State") or {}).get("Running"))
                if isinstance(item.get("State"), dict)
                else False,
                str(item.get("Created", "")),
            ),
            reverse=True,
        )
        selected[service_name] = values[0]
    return selected, counts


def parse_rfc3339(value: object) -> float:
    if not isinstance(value, str) or not value or value.startswith("0001-"):
        return 0.0
    normalized = value.strip().replace("Z", "+00:00")
    normalized = re.sub(r"(\.\d{6})\d+(?=[+-]\d\d:\d\d$)", r"\1", normalized)
    try:
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return 0.0


def parse_systemd_timestamp(value: object) -> float:
    if not isinstance(value, str) or value in {"", "n/a"}:
        return 0.0
    try:
        parsed = datetime.strptime(value, "%a %Y-%m-%d %H:%M:%S %Z")
    except ValueError:
        return 0.0
    return parsed.replace(tzinfo=timezone.utc).timestamp()


_SIZE_UNITS = {
    "B": 1,
    "kB": 1_000,
    "MB": 1_000_000,
    "GB": 1_000_000_000,
    "TB": 1_000_000_000_000,
    "KiB": 1_024,
    "MiB": 1_048_576,
    "GiB": 1_073_741_824,
    "TiB": 1_099_511_627_776,
}


def parse_size(value: object) -> float:
    if not isinstance(value, str):
        return 0.0
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]i?B|B)\s*", value)
    if match is None:
        return 0.0
    return float(match.group(1)) * _SIZE_UNITS[match.group(2)]


def parse_pair(value: object) -> tuple[float, float]:
    if not isinstance(value, str):
        return (0.0, 0.0)
    parts = value.split("/", 1)
    if len(parts) != 2:
        return (0.0, 0.0)
    return (parse_size(parts[0]), parse_size(parts[1]))


def prometheus_escape(value: object) -> str:
    return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def prometheus_labels(labels: Mapping[str, object]) -> str:
    rendered = ",".join(
        f'{name}="{prometheus_escape(value)}"' for name, value in sorted(labels.items())
    )
    return "{" + rendered + "}"


def atomic_write(path: Path, content: str, mode: int = 0o644, group: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        if group is not None:
            os.chown(temporary, -1, group)
        os.replace(temporary, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def read_json_object(path: Path) -> dict[str, object]:
    if path.is_symlink() or not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def write_json_object(path: Path, value: Mapping[str, object]) -> None:
    atomic_write(path, json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", 0o600)
