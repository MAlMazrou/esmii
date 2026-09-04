#!/usr/bin/env python3
"""Remove only rendered monitoring configuration for one environment."""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Sequence

# This script runs directly from the sealed, root-owned host payload. Importing
# the sibling renderer must never add a __pycache__ directory to that immutable
# tree, because every later host mutation re-verifies the exact payload file set.
sys.dont_write_bytecode = True

from render_monitoring import (
    LIVE_RUNTIME_ROOT,
    environment_lock,
    host_operation_lock,
    validate_live_runtime_root,
    verify_materialized_host_payload,
)


CONFIRMATION = {
    "staging": "remove-staging-monitoring-config",
    "production": "remove-production-monitoring-config",
}
SECRET_HANDOFF_VOLUMES = {
    "staging": "esmii-monitoring-staging-dashboard-secret",
    "production": "esmii-monitoring-production-dashboard-secret",
}
LOCAL_DOCKER_ENVIRONMENT = {
    "DOCKER_HOST": "unix:///var/run/docker.sock",
    "HOME": "/var/empty",
    "LANG": "C.UTF-8",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
}
MONITORING_STATE_ROOT = Path("/var/lib/esmii/monitoring")


def _docker_container_ids(*, filters: Sequence[str], runner=subprocess.run) -> list[str]:
    arguments = ["/usr/bin/docker", "container", "ls", "--all", "--quiet"]
    for value in filters:
        arguments.extend(("--filter", value))
    result = runner(
        tuple(arguments),
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
        env=LOCAL_DOCKER_ENVIRONMENT,
    )
    if result.returncode != 0:
        raise ValueError("Docker could not verify monitoring runtime attachments")
    identifiers = [value for value in result.stdout.splitlines() if value]
    if any(not all(character in "0123456789abcdef" for character in value) for value in identifiers):
        raise ValueError("Docker returned an invalid monitoring container identifier")
    return identifiers


def verify_runtime_detached(*, environment: str, runner=subprocess.run) -> None:
    project_filter = "label=com.docker.compose.project=esmii"
    for service in (
        f"{environment}-dashboard-secret-init",
        f"{environment}-dashboard",
        f"{environment}-prometheus",
    ):
        if _docker_container_ids(
            filters=(project_filter, f"label=com.docker.compose.service={service}"),
            runner=runner,
        ):
            raise ValueError(
                f"monitoring service container still exists and must be removed first: {service}"
            )

    caddy_identifiers = _docker_container_ids(
        filters=(project_filter, "label=com.docker.compose.service=caddy"), runner=runner
    )
    if not caddy_identifiers:
        return
    inspected = runner(
        ("/usr/bin/docker", "container", "inspect", *caddy_identifiers),
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
        env=LOCAL_DOCKER_ENVIRONMENT,
    )
    if inspected.returncode != 0:
        raise ValueError("Docker could not inspect the shared Caddy attachment state")
    try:
        records = json.loads(inspected.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Docker returned invalid shared Caddy metadata") from error
    if not isinstance(records, list) or len(records) != len(caddy_identifiers):
        raise ValueError("Docker returned an unexpected shared Caddy inventory")
    expected_network = f"esmii_{environment}-monitoring-edge"
    expected_destination = f"/etc/caddy/sites-enabled/{environment}-dashboard.caddy"
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("Docker returned an invalid shared Caddy record")
        network_settings = record.get("NetworkSettings")
        networks = (
            network_settings.get("Networks") if isinstance(network_settings, dict) else None
        )
        if isinstance(networks, dict) and expected_network in networks:
            raise ValueError("shared Caddy remains attached to the monitoring edge network")
        mounts = record.get("Mounts")
        if isinstance(mounts, list) and any(
            isinstance(mount, dict) and mount.get("Destination") == expected_destination
            for mount in mounts
        ):
            raise ValueError("shared Caddy still mounts the monitoring site configuration")


def purge_secret_handoff(
    *, environment: str, runner=subprocess.run
) -> bool:
    volume = SECRET_HANDOFF_VOLUMES[environment]
    inspect = runner(
        ("/usr/bin/docker", "volume", "inspect", volume),
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
        env=LOCAL_DOCKER_ENVIRONMENT,
    )
    if inspect.returncode != 0:
        if "No such volume" in inspect.stderr:
            return False
        raise ValueError("Docker could not inspect the fixed dashboard secret handoff volume")
    try:
        records = json.loads(inspect.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Docker returned invalid dashboard secret handoff metadata") from error
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
        raise ValueError("Docker returned an unexpected dashboard secret handoff inventory")
    record = records[0]
    labels = record.get("Labels")
    expected_labels = {
        "app.esmii.component": "dashboard-secret-handoff",
        "app.esmii.environment": environment,
    }
    if record.get("Name") != volume or not isinstance(labels, dict) or any(
        labels.get(key) != value for key, value in expected_labels.items()
    ):
        raise ValueError("dashboard secret handoff volume identity labels do not match")
    containers = runner(
        (
            "/usr/bin/docker",
            "container",
            "ls",
            "--all",
            "--quiet",
            "--filter",
            f"volume={volume}",
        ),
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
        env=LOCAL_DOCKER_ENVIRONMENT,
    )
    if containers.returncode != 0:
        raise ValueError("Docker could not verify dashboard secret handoff dependencies")
    if containers.stdout.strip():
        raise ValueError("dashboard secret handoff volume is still attached to a container")
    removed = runner(
        ("/usr/bin/docker", "volume", "rm", volume),
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
        env=LOCAL_DOCKER_ENVIRONMENT,
    )
    if removed.returncode != 0 or removed.stdout.strip() != volume:
        raise ValueError("Docker did not remove the fixed dashboard secret handoff volume")
    return True


def rollback(
    *,
    environment: str,
    runtime_root: Path,
    confirmation: str,
    runner=subprocess.run,
    state_root: Path = MONITORING_STATE_ROOT,
    enforce_marker_metadata: bool = False,
) -> list[Path]:
    if confirmation != CONFIRMATION[environment]:
        raise ValueError("environment-specific rollback confirmation is required")
    if runtime_root.is_symlink():
        raise ValueError("monitoring runtime root must not be a symlink")
    root = runtime_root.resolve(strict=True)
    if root == Path("/"):
        raise ValueError("monitoring runtime root is too broad")

    removed: list[Path] = []
    with environment_lock(root, environment):
        # Activation markers remain authoritative until Docker proves both the
        # private services and Caddy edge are detached.
        verify_runtime_detached(environment=environment, runner=runner)
        marker_root = state_root / environment
        if marker_root.is_symlink() or (marker_root.exists() and not marker_root.is_dir()):
            raise ValueError("monitoring activation marker directory is unsafe")
        markers = (
            marker_root / "edge-enabled",
            marker_root / "private-enabled",
        )
        for marker in markers:
            if not marker.exists():
                continue
            if marker.is_symlink() or not marker.is_file():
                raise ValueError(f"unsafe monitoring activation marker: {marker.name}")
            value = marker.stat()
            if stat.S_IMODE(value.st_mode) != 0o600:
                raise ValueError(f"monitoring activation marker has unsafe mode: {marker.name}")
            if enforce_marker_metadata and (value.st_uid != 0 or value.st_gid != 0):
                raise ValueError(
                    f"monitoring activation marker has unsafe ownership: {marker.name}"
                )
            if marker.read_text(encoding="utf-8") != "enabled\n":
                raise ValueError(f"invalid monitoring activation marker: {marker.name}")
        if any(marker.exists() for marker in markers):
            raise ValueError(
                "monitoring activation marker remains after detach; run the fixed runtime manager stop action"
            )
        targets = (
            root / f"compose.monitoring.{environment}.yaml",
            root / f"compose.monitoring.{environment}.edge.yaml",
            root / "caddy" / "sites-enabled" / f"{environment}-dashboard.caddy",
            root / "monitoring" / "prometheus" / environment / "prometheus.yml",
            root / "monitoring" / "prometheus" / environment / "rules" / "esmii.rules.yml",
            root / "monitoring" / f"runtime-manifest.{environment}.json",
        )
        for target in targets:
            if os.path.commonpath((str(root), str(target.parent.resolve(strict=False)))) != str(root):
                raise ValueError("monitoring rollback target escapes the runtime root")
            relative = target.relative_to(root)
            current = root
            for component in relative.parts:
                current = current / component
                if current.is_symlink():
                    raise ValueError(f"refusing rollback through symlink: {component}")
        for target in targets:
            if target.is_file():
                target.unlink()
                removed.append(target)

    return removed


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--environment", required=True, choices=("staging", "production"))
    result.add_argument("--confirm", required=True)
    result.add_argument("--purge-secret-handoff", action="store_true")
    result.add_argument("--expected-host-payload-digest", required=True)
    result.add_argument("--expected-host-payload-revision", required=True)
    return result


def main(arguments: Sequence[str] | None = None) -> int:
    options = parser().parse_args(arguments)
    if os.geteuid() != 0:
        raise PermissionError("monitoring runtime rollback must run as root")
    payload_root = Path(__file__).resolve().parents[2]
    # Refuse a changed materialized source via the independently bootstrapped
    # verifier before creating/acquiring locks or mutating runtime state.
    verify_materialized_host_payload(
        payload_root=payload_root,
        expected_digest=options.expected_host_payload_digest,
        expected_revision=options.expected_host_payload_revision,
    )
    with host_operation_lock():
        runtime_root = validate_live_runtime_root()
        removed = rollback(
            environment=options.environment,
            runtime_root=runtime_root,
            confirmation=options.confirm,
            enforce_marker_metadata=True,
        )
        purged = (
            purge_secret_handoff(environment=options.environment)
            if options.purge_secret_handoff
            else False
        )
    handoff = " and purged its detached secret handoff volume" if purged else ""
    print(f"Removed {len(removed)} rendered {options.environment} monitoring configuration files{handoff}; durable state and canonical /etc secret were preserved.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"monitoring rollback failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
