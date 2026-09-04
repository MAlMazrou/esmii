#!/usr/bin/env python3
"""Verify and materialize the closed Prompt-07 monitoring host payload."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Sequence


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
SOURCE = "https://github.com/malmazrou/esmii"
LIVE_PAYLOAD_ROOT = Path("/var/lib/esmii/monitoring/host-payloads")
PAYLOAD_FILES: dict[str, int] = {
    "infra/ansible/roles/firewall/files/esmii-docker-firewall.sh": 0o644,
    "infra/caddy/sites/production-dashboard.caddy": 0o644,
    "infra/caddy/sites/staging-dashboard.caddy": 0o644,
    "infra/compose.monitoring.production.edge.yaml": 0o644,
    "infra/compose.monitoring.production.yaml": 0o644,
    "infra/compose.monitoring.staging.edge.yaml": 0o644,
    "infra/compose.monitoring.staging.yaml": 0o644,
    "infra/monitoring/container_metrics_collector.py": 0o755,
    "infra/monitoring/install-host-collectors.sh": 0o755,
    "infra/monitoring/install-monitoring-runtime.sh": 0o755,
    "infra/monitoring/install-pull-wrapper-integration.sh": 0o755,
    "infra/monitoring/log_collector.py": 0o755,
    "infra/monitoring/manage-monitoring-runtime.sh": 0o755,
    "infra/monitoring/materialize-monitoring-payload.sh": 0o755,
    "infra/monitoring/monitoring_common.py": 0o644,
    "infra/monitoring/monitoring_overlay_state.py": 0o755,
    "infra/monitoring/monitoring_payload.py": 0o755,
    "infra/monitoring/prometheus/production/prometheus.yml": 0o644,
    "infra/monitoring/prometheus/rules/esmii.rules.yml": 0o644,
    "infra/monitoring/prometheus/staging/prometheus.yml": 0o644,
    "infra/monitoring/provision_dashboard_mail.py": 0o755,
    "infra/monitoring/render_monitoring.py": 0o755,
    "infra/monitoring/rollback-host-collectors.sh": 0o755,
    "infra/monitoring/rollback_monitoring_runtime.py": 0o755,
    "infra/production-pull/esmii-production-pull": 0o755,
    "infra/staging-pull/esmii-staging-pull": 0o755,
    "infra/systemd/esmii-container-metrics-collector.service": 0o644,
    "infra/systemd/esmii-container-metrics-collector.timer": 0o644,
    "infra/systemd/esmii-log-collector.service": 0o644,
    "infra/systemd/esmii-log-collector.timer": 0o644,
    "infra/systemd/esmii-node-exporter-production-proxy.service": 0o644,
    "infra/systemd/esmii-node-exporter-production-proxy.socket": 0o644,
    "infra/systemd/esmii-node-exporter-staging-proxy.service": 0o644,
    "infra/systemd/esmii-node-exporter-staging-proxy.socket": 0o644,
    "infra/systemd/esmii-node-exporter.service": 0o644,
    "infra/systemd/esmii-node-exporter.slice": 0o644,
    "monitoring-host-payload.json": 0o644,
}
INVENTORY_PATH = "payload-inventory.json"
ARCHIVE_COPY = ".payload-archive.tar"
DIGEST_RECORD = ".payload-digest"


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _canonical_object(value: bytes, label: str) -> dict[str, object]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} is invalid JSON") from error
    if not isinstance(parsed, dict) or canonical(parsed) != value:
        raise ValueError(f"{label} is not one canonical object")
    return parsed


def _validate_metadata(raw: bytes, expected_revision: str) -> dict[str, object]:
    metadata = _canonical_object(raw, "monitoring host payload metadata")
    expected = {
        "file_set": "prompt-07-monitoring-host",
        "schema_version": 1,
        "source": SOURCE,
        "source_revision": expected_revision,
    }
    if metadata != expected:
        raise ValueError("monitoring host payload metadata differs from the approved identity")
    return metadata


def verify_archive(
    archive_path: Path, expected_digest: str, expected_revision: str
) -> tuple[bytes, dict[str, bytes], dict[str, object]]:
    """Fully verify the payload in memory before callers mutate a destination."""

    if DIGEST.fullmatch(expected_digest) is None:
        raise ValueError("expected monitoring host payload digest is invalid")
    if REVISION.fullmatch(expected_revision) is None:
        raise ValueError("expected monitoring host payload revision is invalid")
    if archive_path.is_symlink() or not archive_path.is_file():
        raise ValueError("monitoring host payload archive is absent or unsafe")
    raw_archive = archive_path.read_bytes()
    if digest_bytes(raw_archive) != expected_digest:
        raise ValueError("monitoring host payload digest mismatch")

    expected_paths = set(PAYLOAD_FILES) | {INVENTORY_PATH}
    contents: dict[str, bytes] = {}
    members: dict[str, tarfile.TarInfo] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(raw_archive), mode="r:") as archive:
            for member in archive:
                if member.name in members:
                    raise ValueError("monitoring host payload contains a duplicate path")
                if member.name not in expected_paths:
                    raise ValueError("monitoring host payload contains an unapproved path")
                if not member.isfile() or member.uid != 0 or member.gid != 0 or member.mtime != 0:
                    raise ValueError("monitoring host payload contains non-normalized metadata")
                expected_mode = PAYLOAD_FILES.get(member.name, 0o644)
                if stat.S_IMODE(member.mode) != expected_mode:
                    raise ValueError("monitoring host payload contains an unexpected mode")
                handle = archive.extractfile(member)
                if handle is None:
                    raise ValueError("monitoring host payload member cannot be read")
                value = handle.read()
                if len(value) != member.size:
                    raise ValueError("monitoring host payload member size differs")
                members[member.name] = member
                contents[member.name] = value
    except tarfile.TarError as error:
        raise ValueError("monitoring host payload archive is invalid") from error
    if set(members) != expected_paths:
        raise ValueError("monitoring host payload file set is incomplete")

    inventory = _canonical_object(contents[INVENTORY_PATH], "monitoring host payload inventory")
    if set(inventory) != {"files", "normalized", "schema_version"}:
        raise ValueError("monitoring host payload inventory shape differs")
    if inventory.get("schema_version") != 1 or inventory.get("normalized") != {
        "gid": 0,
        "mtime": 0,
        "order": "path-byte-order",
        "uid": 0,
    }:
        raise ValueError("monitoring host payload normalization contract differs")
    rows = inventory.get("files")
    if not isinstance(rows, list) or len(rows) != len(PAYLOAD_FILES):
        raise ValueError("monitoring host payload inventory length differs")
    expected_inventory_paths = set(PAYLOAD_FILES)
    if [row.get("path") for row in rows if isinstance(row, dict)] != sorted(
        expected_inventory_paths
    ):
        raise ValueError("monitoring host payload inventory order differs")
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"mode", "path", "sha256", "size"}:
            raise ValueError("monitoring host payload inventory entry shape differs")
        path = row.get("path")
        if not isinstance(path, str) or path not in expected_inventory_paths or path in seen:
            raise ValueError("monitoring host payload inventory path differs")
        value = contents[path]
        expected_mode = f"{PAYLOAD_FILES[path]:04o}"
        if (
            row.get("mode") != expected_mode
            or row.get("size") != len(value)
            or row.get("sha256") != digest_bytes(value)
        ):
            raise ValueError("monitoring host payload inventory checksum or metadata differs")
        seen.add(path)
    if seen != expected_inventory_paths:
        raise ValueError("monitoring host payload inventory file set differs")
    metadata = _validate_metadata(contents["monitoring-host-payload.json"], expected_revision)
    return raw_archive, contents, metadata


def _safe_materialized_root(
    root: Path, expected_digest: str, *, enforce_digest_name: bool = True
) -> None:
    if enforce_digest_name and root.name != expected_digest.removeprefix("sha256:"):
        raise ValueError("materialized monitoring payload directory does not match its digest")
    if root.is_symlink() or not root.is_dir():
        raise ValueError("materialized monitoring payload root is absent or unsafe")
    value = root.stat()
    if stat.S_IMODE(value.st_mode) != 0o700:
        raise ValueError("materialized monitoring payload root has an unsafe mode")
    if os.geteuid() == 0 and (value.st_uid != 0 or value.st_gid != 0):
        raise ValueError("materialized monitoring payload root is not owned by root")


def verify_materialized(
    root: Path,
    expected_digest: str,
    expected_revision: str,
    *,
    enforce_digest_name: bool = True,
) -> None:
    _safe_materialized_root(
        root, expected_digest, enforce_digest_name=enforce_digest_name
    )
    archive_path = root / ARCHIVE_COPY
    digest_path = root / DIGEST_RECORD
    for control in (archive_path, digest_path):
        if control.is_symlink() or not control.is_file():
            raise ValueError("materialized monitoring payload control record is absent or unsafe")
        value = control.stat()
        if stat.S_IMODE(value.st_mode) != 0o600:
            raise ValueError("materialized monitoring payload control record has an unsafe mode")
        if os.geteuid() == 0 and (value.st_uid != 0 or value.st_gid != 0):
            raise ValueError("materialized monitoring payload control record is not owned by root")
    if digest_path.read_text(encoding="ascii") != expected_digest + "\n":
        raise ValueError("materialized monitoring payload digest record differs")
    _, contents, _ = verify_archive(archive_path, expected_digest, expected_revision)

    expected_files = set(contents) | {ARCHIVE_COPY, DIGEST_RECORD}
    actual_files: set[str] = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("materialized monitoring payload contains a symlink")
        value = path.stat()
        if path.is_dir():
            if stat.S_IMODE(value.st_mode) != 0o700:
                raise ValueError("materialized monitoring payload directory has an unsafe mode")
            if os.geteuid() == 0 and (value.st_uid != 0 or value.st_gid != 0):
                raise ValueError("materialized monitoring payload directory is not owned by root")
        if path.is_file():
            if os.geteuid() == 0 and (value.st_uid != 0 or value.st_gid != 0):
                raise ValueError("materialized monitoring payload file is not owned by root")
            actual_files.add(path.relative_to(root).as_posix())
    if actual_files != expected_files:
        raise ValueError("materialized monitoring payload file set differs")
    for relative, expected in contents.items():
        path = root / relative
        if path.read_bytes() != expected:
            raise ValueError(f"materialized monitoring payload file differs: {relative}")
        expected_mode = PAYLOAD_FILES.get(relative, 0o644)
        if stat.S_IMODE(path.stat().st_mode) != expected_mode:
            raise ValueError(f"materialized monitoring payload mode differs: {relative}")


def materialize(
    archive_path: Path,
    expected_digest: str,
    expected_revision: str,
    payload_root: Path = LIVE_PAYLOAD_ROOT,
) -> Path:
    # This complete verification intentionally precedes mkdir, temporary files,
    # extraction, or any other destination mutation.
    raw_archive, contents, _ = verify_archive(
        archive_path, expected_digest, expected_revision
    )
    destination = payload_root / expected_digest.removeprefix("sha256:")
    if destination.exists():
        verify_materialized(destination, expected_digest, expected_revision)
        return destination

    payload_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if payload_root.is_symlink() or not payload_root.is_dir():
        raise ValueError("monitoring host payload parent is unsafe")
    parent_state = payload_root.stat()
    if stat.S_IMODE(parent_state.st_mode) != 0o700:
        raise ValueError("monitoring host payload parent must be mode 0700")
    if os.geteuid() == 0 and (parent_state.st_uid != 0 or parent_state.st_gid != 0):
        raise ValueError("monitoring host payload parent must be owned by root")
    temporary = Path(tempfile.mkdtemp(prefix=".incoming-", dir=payload_root))
    try:
        temporary.chmod(0o700)
        for relative, value in contents.items():
            path = temporary / relative
            current = temporary
            for component in Path(relative).parent.parts:
                current = current / component
                current.mkdir(exist_ok=True, mode=0o700)
                current.chmod(0o700)
            descriptor = os.open(
                path,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                PAYLOAD_FILES.get(relative, 0o644),
            )
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
            path.chmod(PAYLOAD_FILES.get(relative, 0o644))
        (temporary / ARCHIVE_COPY).write_bytes(raw_archive)
        (temporary / ARCHIVE_COPY).chmod(0o600)
        (temporary / DIGEST_RECORD).write_text(expected_digest + "\n", encoding="ascii")
        (temporary / DIGEST_RECORD).chmod(0o600)
        verify_materialized(
            temporary,
            expected_digest,
            expected_revision,
            enforce_digest_name=False,
        )
        try:
            os.replace(temporary, destination)
        except OSError:
            if not destination.exists():
                raise
            # A concurrent invocation may have committed the same digest path.
            # It wins only if its complete materialization verifies exactly.
            verify_materialized(destination, expected_digest, expected_revision)
            shutil.rmtree(temporary, ignore_errors=True)
            return destination
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    verify_materialized(destination, expected_digest, expected_revision)
    return destination


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subparsers = result.add_subparsers(dest="command", required=True)
    materialize_parser = subparsers.add_parser("materialize")
    materialize_parser.add_argument("--archive", required=True, type=Path)
    materialize_parser.add_argument("--expected-digest", required=True)
    materialize_parser.add_argument("--expected-revision", required=True)
    materialize_parser.add_argument("--test-root", type=Path)
    verify_parser = subparsers.add_parser("verify-materialized")
    verify_parser.add_argument("--root", required=True, type=Path)
    verify_parser.add_argument("--expected-digest", required=True)
    verify_parser.add_argument("--expected-revision", required=True)
    return result


def main(arguments: Sequence[str] | None = None) -> int:
    options = parser().parse_args(arguments)
    if options.command == "materialize":
        if options.test_root is not None:
            if os.environ.get("ESMII_TEST_MODE") != "1":
                raise ValueError("--test-root requires ESMII_TEST_MODE=1")
            payload_root = options.test_root.resolve() / "host-payloads"
        else:
            if os.geteuid() != 0:
                raise PermissionError("live monitoring payload materialization must run as root")
            payload_root = LIVE_PAYLOAD_ROOT
        destination = materialize(
            options.archive,
            options.expected_digest,
            options.expected_revision,
            payload_root,
        )
        print(destination)
    else:
        verify_materialized(
            options.root.resolve(), options.expected_digest, options.expected_revision
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, PermissionError, ValueError) as error:
        print(f"monitoring host payload failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
