#!/usr/bin/env python3
"""Return only verified monitoring overlays for the active Esmii Compose project."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from typing import Sequence


LIVE_RUNTIME_ROOT = Path("/srv/myapp/staging-runtime")
MONITORING_STATE_ROOT = Path("/var/lib/esmii/monitoring")
HOST_PAYLOAD_RECORD = MONITORING_STATE_ROOT / "shared" / "state" / "host-payload.json"
PULL_WRAPPER_RECORD = (
    MONITORING_STATE_ROOT / "shared" / "state" / "pull-wrapper-integration.json"
)
ACTIVE_PULL_WRAPPERS = (
    Path("/usr/local/libexec/esmii/esmii-production-pull"),
    Path("/usr/local/libexec/esmii/esmii-staging-pull"),
)
ENVIRONMENTS = ("staging", "production")


def _expected_files(environment: str) -> tuple[str, ...]:
    return (
        f"compose.monitoring.{environment}.yaml",
        f"compose.monitoring.{environment}.edge.yaml",
        f"caddy/sites-enabled/{environment}-dashboard.caddy",
        f"monitoring/prometheus/{environment}/prometheus.yml",
        f"monitoring/prometheus/{environment}/rules/esmii.rules.yml",
    )


def _regular_file(path: Path, *, enforce_metadata: bool, mode: int = 0o644) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"monitoring overlay state contains an unsafe file: {path.name}")
    if enforce_metadata:
        value = path.stat()
        if value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != mode:
            raise ValueError(f"monitoring overlay state has unsafe ownership or mode: {path.name}")


def active_compose_files(
    *,
    runtime_root: Path = LIVE_RUNTIME_ROOT,
    state_root: Path = MONITORING_STATE_ROOT,
    enforce_metadata: bool = False,
) -> list[Path]:
    if runtime_root.is_symlink() or not runtime_root.is_dir():
        raise ValueError("monitoring runtime root is absent or unsafe")
    root = runtime_root.resolve(strict=True)
    installed_host_payload: dict[str, object] | None = None
    if enforce_metadata:
        _regular_file(HOST_PAYLOAD_RECORD, enforce_metadata=True, mode=0o600)
        try:
            installed_host_payload = json.loads(
                HOST_PAYLOAD_RECORD.read_text(encoding="utf-8")
            )
        except json.JSONDecodeError as error:
            raise ValueError("installed monitoring host payload record is invalid") from error
        if not isinstance(installed_host_payload, dict) or set(installed_host_payload) != {
            "digest",
            "revision",
            "schemaVersion",
        }:
            raise ValueError("installed monitoring host payload record shape differs")
        if installed_host_payload.get("schemaVersion") != 1:
            raise ValueError("installed monitoring host payload schema differs")
        _regular_file(PULL_WRAPPER_RECORD, enforce_metadata=True, mode=0o600)
        try:
            pull_integration = json.loads(
                PULL_WRAPPER_RECORD.read_text(encoding="utf-8")
            )
        except json.JSONDecodeError as error:
            raise ValueError("monitoring pull-wrapper integration record is invalid") from error
        if not isinstance(pull_integration, dict) or set(pull_integration) != {
            "files",
            "hostPayload",
            "schemaVersion",
        }:
            raise ValueError("monitoring pull-wrapper integration record shape differs")
        if pull_integration.get("schemaVersion") != 1 or pull_integration.get(
            "hostPayload"
        ) != {
            "digest": installed_host_payload.get("digest"),
            "revision": installed_host_payload.get("revision"),
        }:
            raise ValueError("monitoring pull-wrapper integration identity differs")
        wrapper_hashes = pull_integration.get("files")
        expected_wrapper_paths = {str(path) for path in ACTIVE_PULL_WRAPPERS}
        if not isinstance(wrapper_hashes, dict) or set(wrapper_hashes) != expected_wrapper_paths:
            raise ValueError("monitoring pull-wrapper integration file set differs")
        for wrapper in ACTIVE_PULL_WRAPPERS:
            _regular_file(wrapper, enforce_metadata=True, mode=0o755)
            if hashlib.sha256(wrapper.read_bytes()).hexdigest() != wrapper_hashes[str(wrapper)]:
                raise ValueError(f"installed monitoring pull wrapper differs: {wrapper.name}")
    selected: list[Path] = []
    for environment in ENVIRONMENTS:
        manifest_path = root / "monitoring" / f"runtime-manifest.{environment}.json"
        base_path = root / f"compose.monitoring.{environment}.yaml"
        edge_path = root / f"compose.monitoring.{environment}.edge.yaml"
        private_marker = state_root / environment / "private-enabled"
        edge_marker = state_root / environment / "edge-enabled"
        if not manifest_path.exists():
            if (
                base_path.exists()
                or edge_path.exists()
                or private_marker.exists()
                or edge_marker.exists()
            ):
                raise ValueError(
                    f"unmanaged {environment} monitoring overlay or activation marker is present"
                )
            continue

        _regular_file(manifest_path, enforce_metadata=enforce_metadata)
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid {environment} monitoring runtime manifest") from error
        if not isinstance(manifest, dict) or set(manifest) != {
            "dashboardImage",
            "environment",
            "files",
            "hostPayload",
            "prometheusImage",
            "provenance",
            "schemaVersion",
        }:
            raise ValueError(f"unexpected {environment} monitoring runtime manifest shape")
        if manifest.get("environment") != environment or manifest.get("schemaVersion") != 1:
            raise ValueError(f"incorrect {environment} monitoring runtime manifest identity")
        host_payload = manifest.get("hostPayload")
        if not isinstance(host_payload, dict) or set(host_payload) != {"digest", "revision"}:
            raise ValueError(f"incorrect {environment} monitoring host payload identity")
        if installed_host_payload is not None and host_payload != {
            "digest": installed_host_payload.get("digest"),
            "revision": installed_host_payload.get("revision"),
        }:
            raise ValueError(
                f"{environment} runtime was rendered from a different monitoring host payload"
            )
        hashes = manifest.get("files")
        expected = _expected_files(environment)
        if not isinstance(hashes, dict) or set(hashes) != set(expected):
            raise ValueError(f"incomplete {environment} monitoring runtime manifest")
        for relative in expected:
            path = root / relative
            if os.path.commonpath((str(root), str(path.parent.resolve(strict=False)))) != str(root):
                raise ValueError("monitoring overlay path escapes the runtime root")
            _regular_file(path, enforce_metadata=enforce_metadata)
            expected_hash = hashes.get(relative)
            if (
                not isinstance(expected_hash, str)
                or len(expected_hash) != 64
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash
            ):
                raise ValueError(f"{environment} monitoring runtime file hash differs: {relative}")

        if edge_marker.exists() and not private_marker.exists():
            raise ValueError(f"{environment} monitoring edge is enabled without its private runtime")
        if not private_marker.exists():
            continue

        _regular_file(private_marker, enforce_metadata=enforce_metadata, mode=0o600)
        if private_marker.read_text(encoding="utf-8") != "enabled\n":
            raise ValueError(f"invalid {environment} monitoring private marker")
        selected.append(base_path)

        if edge_marker.exists():
            _regular_file(edge_marker, enforce_metadata=enforce_metadata, mode=0o600)
            if edge_marker.read_text(encoding="utf-8") != "enabled\n":
                raise ValueError(f"invalid {environment} monitoring edge marker")
            selected.append(edge_path)
    return selected


def main(arguments: Sequence[str] | None = None) -> int:
    if arguments is None:
        arguments = sys.argv[1:]
    if tuple(arguments) != ("list",):
        raise ValueError("usage: monitoring_overlay_state.py list")
    if os.geteuid() != 0:
        raise PermissionError("monitoring overlay state must be read by root")
    for path in active_compose_files(enforce_metadata=True):
        print(path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, PermissionError, ValueError) as error:
        print(f"monitoring overlay state failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
