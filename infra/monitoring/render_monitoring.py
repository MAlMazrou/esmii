#!/usr/bin/env python3
"""Render one immutable, environment-scoped monitoring runtime.

The renderer performs no pull, Compose, Caddy, systemd, DNS, or certificate
operation. With --validate-local-images it inspects already-local images only.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Mapping, Sequence


DASHBOARD_IMAGE = re.compile(
    r"^ghcr\.io/malmazrou/esmii-dashboard@sha256:[0-9a-f]{64}$"
)
PROMETHEUS_IMAGE = re.compile(
    r"^(?:(?:docker\.io/)?prom/prometheus|quay\.io/prometheus/prometheus)@sha256:[0-9a-f]{64}$"
)
HOST_PAYLOAD_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
VERSION = re.compile(r"^v(?:0|[1-9][0-9]*)\.[0-9]+\.[0-9]+$")
SOURCE = "https://github.com/MAlMazrou/esmii"
LIVE_RUNTIME_ROOT = Path("/srv/myapp/staging-runtime")
HOST_OPERATION_LOCK = Path("/run/lock/esmii/host-pull.lock")
FIXED_PAYLOAD_VERIFIER = Path(
    "/var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/monitoring_payload.py"
)


@contextmanager
def host_operation_lock(
    lock_path: Path = HOST_OPERATION_LOCK, *, timeout_seconds: float = 30.0
):
    """Serialize live monitoring mutations with the active app pull services."""

    parent = lock_path.parent
    parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if parent.is_symlink() or not parent.is_dir():
        raise ValueError("shared host-operation lock directory is absent or unsafe")
    flags = os.O_CREAT | os.O_RDWR | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(lock_path, flags, 0o600)
    deadline = time.monotonic() + timeout_seconds
    acquired = False
    try:
        os.fchmod(descriptor, 0o600)
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("timed out waiting for the shared host-operation lock")
                time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
        yield
    finally:
        if acquired:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


@contextmanager
def environment_lock(root: Path, environment: str):
    root.mkdir(parents=True, exist_ok=True, mode=0o755)
    lock_path = root / f".monitoring-{environment}.lock"
    flags = os.O_CREAT | os.O_RDWR | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(lock_path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def validate_inputs(
    dashboard_image: str,
    prometheus_image: str,
    source: str,
    revision: str,
    version: str,
) -> None:
    if DASHBOARD_IMAGE.fullmatch(dashboard_image) is None:
        raise ValueError("dashboard image must be the immutable canonical GHCR digest")
    if PROMETHEUS_IMAGE.fullmatch(prometheus_image) is None:
        raise ValueError("Prometheus image must be an immutable official-image digest")
    if source != SOURCE:
        raise ValueError("dashboard source provenance does not identify this repository")
    if REVISION.fullmatch(revision) is None:
        raise ValueError("dashboard revision must be one full lowercase Git SHA")
    if VERSION.fullmatch(version) is None:
        raise ValueError("dashboard version must be a v-prefixed semantic version")


def validate_host_payload_identity(host_payload_digest: str) -> None:
    if HOST_PAYLOAD_DIGEST.fullmatch(host_payload_digest) is None:
        raise ValueError("monitoring host payload digest must be one lowercase SHA-256 digest")


def verify_materialized_host_payload(
    *,
    payload_root: Path,
    expected_digest: str,
    expected_revision: str,
    verifier: Path = FIXED_PAYLOAD_VERIFIER,
    runner=subprocess.run,
) -> None:
    """Authenticate a candidate with the independently bootstrapped verifier."""

    if verifier.is_symlink() or not verifier.is_file():
        raise ValueError("independently bootstrapped payload verifier is absent or unsafe")
    value = verifier.stat()
    if value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != 0o700:
        raise ValueError("independently bootstrapped payload verifier has unsafe metadata")
    result = runner(
        (
            "/usr/bin/python3",
            str(verifier),
            "verify-materialized",
            "--root",
            str(payload_root),
            "--expected-digest",
            expected_digest,
            "--expected-revision",
            expected_revision,
        ),
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
        env={"HOME": "/var/empty", "LANG": "C.UTF-8", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
    )
    if result.returncode != 0:
        raise ValueError("the independently verified monitoring host payload differs")


def inspect_local_image(reference: str) -> dict[str, object]:
    result = subprocess.run(
        ("/usr/bin/docker", "image", "inspect", reference),
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        env={"HOME": "/var/empty", "LANG": "C.UTF-8", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        timeout=20,
    )
    if result.returncode != 0:
        raise ValueError("an immutable monitoring image is not present in the local Docker store")
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Docker returned invalid image metadata") from error
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise ValueError("Docker returned an unexpected image inventory")
    return rows[0]


def validate_local_images(
    *, dashboard_image: str, prometheus_image: str, source: str, revision: str, version: str
) -> None:
    dashboard = inspect_local_image(dashboard_image)
    config = dashboard.get("Config")
    config = config if isinstance(config, dict) else {}
    labels = config.get("Labels")
    labels = labels if isinstance(labels, dict) else {}
    expected_labels = {
        "org.opencontainers.image.source": source,
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.version": version,
    }
    for key, expected in expected_labels.items():
        if labels.get(key) != expected:
            raise ValueError(f"dashboard image label {key} does not match the activation record")
    if config.get("User") not in {"10003", "10003:10003"}:
        raise ValueError("dashboard image must run as the fixed unprivileged UID 10003")

    prometheus = inspect_local_image(prometheus_image)
    identifier = prometheus.get("Id")
    if not isinstance(identifier, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", identifier) is None:
        raise ValueError("Prometheus image does not have a content-addressed local image ID")


def validate_host_state(environment: str) -> None:
    secret = Path(f"/etc/esmii/monitoring/{environment}/dashboard-auth-secret")
    if secret.is_symlink() or not secret.is_file():
        raise ValueError("environment dashboard auth secret is absent or unsafe")
    secret_stat = secret.stat()
    if not stat.S_ISREG(secret_stat.st_mode) or stat.S_IMODE(secret_stat.st_mode) != 0o600:
        raise ValueError("environment dashboard auth secret must be a mode-0600 regular file")
    if secret_stat.st_uid != 0 or secret_stat.st_gid != 0:
        raise ValueError("environment dashboard auth secret must be owned by root:root")
    if secret_stat.st_size < 32 or secret_stat.st_size > 4096:
        raise ValueError("environment dashboard auth secret has an invalid size")

    expected_directories = {
        Path(f"/var/lib/esmii/monitoring/{environment}/auth"): (0o700, 10003, 10003),
        Path(f"/var/lib/esmii/monitoring/{environment}/prometheus"): (0o700, 65534, 65534),
        Path(f"/var/lib/esmii/monitoring/{environment}/logs"): (0o750, 0, 10003),
    }
    for path, expected in expected_directories.items():
        if path.is_symlink() or not path.is_dir():
            raise ValueError(f"required environment monitoring directory is absent or unsafe: {path.name}")
        value = path.stat()
        actual = (stat.S_IMODE(value.st_mode), value.st_uid, value.st_gid)
        if actual != expected:
            raise ValueError(f"environment monitoring directory ownership/mode is invalid: {path.name}")

    log_snapshot = Path(f"/var/lib/esmii/monitoring/{environment}/logs/services.ndjson")
    if log_snapshot.is_symlink() or not log_snapshot.is_file():
        raise ValueError("environment sanitized log snapshot is absent or unsafe")
    snapshot_stat = log_snapshot.stat()
    if (
        snapshot_stat.st_uid != 0
        or snapshot_stat.st_gid != 10003
        or stat.S_IMODE(snapshot_stat.st_mode) != 0o640
    ):
        raise ValueError("environment sanitized log snapshot ownership/mode is invalid")


def validate_live_runtime_root() -> Path:
    path = LIVE_RUNTIME_ROOT
    if path.is_symlink() or not path.is_dir():
        raise ValueError("fixed monitoring runtime root is absent or unsafe")
    value = path.stat()
    if value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != 0o755:
        raise ValueError("fixed monitoring runtime root must be root:root mode 0755")
    return path.resolve(strict=True)


def render_text(source: Path, replacements: Mapping[str, str]) -> str:
    if not source.is_file() or source.is_symlink():
        raise ValueError(f"required monitoring source is absent or unsafe: {source.name}")
    content = source.read_text(encoding="utf-8")
    for token, value in replacements.items():
        content = content.replace(token, value)
    unresolved = sorted(set(re.findall(r"@@[A-Z0-9_]+@@", content)))
    if unresolved:
        raise ValueError(f"unresolved monitoring template tokens: {', '.join(unresolved)}")
    return content


def atomic_write(path: Path, content: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def require_safe_destination(root: Path, path: Path) -> None:
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ValueError("monitoring render destination escapes the runtime root") from error
    current = root
    for component in relative.parts:
        current = current / component
        if current.is_symlink():
            raise ValueError(f"monitoring render destination contains a symlink: {component}")
    resolved_parent = path.parent.resolve(strict=False)
    if os.path.commonpath((str(root), str(resolved_parent))) != str(root):
        raise ValueError("monitoring render destination escapes the runtime root")


def render_runtime(
    *,
    environment: str,
    source_root: Path,
    runtime_root: Path,
    dashboard_image: str,
    prometheus_image: str,
    source: str,
    revision: str,
    version: str,
    host_payload_digest: str,
    host_payload_revision: str | None = None,
) -> dict[str, object]:
    validate_inputs(dashboard_image, prometheus_image, source, revision, version)
    validate_host_payload_identity(host_payload_digest)
    if host_payload_revision is None:
        host_payload_revision = revision
    if REVISION.fullmatch(host_payload_revision) is None:
        raise ValueError("monitoring host payload revision must be one full lowercase Git SHA")
    source_root = source_root.resolve(strict=True)
    if not source_root.is_dir():
        raise ValueError("monitoring source root is not a directory")
    if runtime_root.is_symlink():
        raise ValueError("monitoring runtime root must not be a symlink")
    resolved_runtime = runtime_root.resolve(strict=False)
    if resolved_runtime == Path("/") or resolved_runtime == source_root:
        raise ValueError("monitoring runtime root is too broad")

    dashboard_token = (
        "@@STAGING_DASHBOARD_IMAGE@@"
        if environment == "staging"
        else "@@PRODUCTION_DASHBOARD_IMAGE@@"
    )
    replacements = {
        dashboard_token: dashboard_image,
        "@@PROMETHEUS_IMAGE@@": prometheus_image,
    }
    sources = {
        f"compose.monitoring.{environment}.yaml": source_root
        / f"compose.monitoring.{environment}.yaml",
        f"compose.monitoring.{environment}.edge.yaml": source_root
        / f"compose.monitoring.{environment}.edge.yaml",
        f"caddy/sites-enabled/{environment}-dashboard.caddy": source_root
        / "caddy"
        / "sites"
        / f"{environment}-dashboard.caddy",
        f"monitoring/prometheus/{environment}/prometheus.yml": source_root
        / "monitoring"
        / "prometheus"
        / environment
        / "prometheus.yml",
        f"monitoring/prometheus/{environment}/rules/esmii.rules.yml": source_root
        / "monitoring"
        / "prometheus"
        / "rules"
        / "esmii.rules.yml",
    }
    rendered: dict[str, str] = {}
    for relative, path in sources.items():
        rendered[relative] = render_text(path, replacements)

    compose = rendered[f"compose.monitoring.{environment}.yaml"]
    edge_compose = rendered[f"compose.monitoring.{environment}.edge.yaml"]
    for rendered_compose in (compose, edge_compose):
        if re.search(
            r"(?m)^\s*ports:\s*$|published:|docker\.sock|network_mode:\s*host",
            rendered_compose,
        ):
            raise ValueError("rendered monitoring Compose violates the private-port contract")
    if "caddy:" in compose or f"{environment}-dashboard.caddy" in compose:
        raise ValueError("private monitoring Compose unexpectedly activates the public edge")
    if f"{environment}-dashboard.caddy" not in edge_compose:
        raise ValueError("monitoring edge Compose lacks its environment dashboard site")
    if f"/var/lib/esmii/monitoring/{environment}/" not in compose:
        raise ValueError("rendered monitoring Compose lacks environment-local state")
    other_environment = "production" if environment == "staging" else "staging"
    if f"/var/lib/esmii/monitoring/{other_environment}/" in compose:
        raise ValueError("rendered monitoring Compose crosses environment state")

    file_hashes = {
        relative: hashlib.sha256(content.encode("utf-8")).hexdigest()
        for relative, content in rendered.items()
    }
    manifest: dict[str, object] = {
        "dashboardImage": dashboard_image,
        "environment": environment,
        "files": file_hashes,
        "hostPayload": {
            "digest": host_payload_digest,
            "revision": host_payload_revision,
        },
        "prometheusImage": prometheus_image,
        "provenance": {"revision": revision, "source": source, "version": version},
        "schemaVersion": 1,
    }
    manifest_relative = f"monitoring/runtime-manifest.{environment}.json"
    with environment_lock(resolved_runtime, environment):
        for relative in (*rendered, manifest_relative):
            require_safe_destination(resolved_runtime, resolved_runtime / relative)
        manifest_path = resolved_runtime / manifest_relative
        existing_targets = [
            resolved_runtime / relative
            for relative in rendered
            if (resolved_runtime / relative).is_file()
        ]
        if manifest_path.is_file():
            try:
                existing_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                raise ValueError("existing monitoring runtime manifest is invalid") from error
            if existing_manifest != manifest:
                raise ValueError(
                    "monitoring runtime root already contains a different immutable environment candidate"
                )
        elif existing_targets:
            raise ValueError("monitoring runtime root contains unmanaged environment configuration")

        for relative, content in rendered.items():
            atomic_write(resolved_runtime / relative, content)
        atomic_write(
            manifest_path,
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        )
        for relative, expected_hash in file_hashes.items():
            actual_hash = hashlib.sha256((resolved_runtime / relative).read_bytes()).hexdigest()
            if actual_hash != expected_hash:
                raise ValueError("monitoring runtime readback hash differs from its manifest")
        if json.loads(manifest_path.read_text(encoding="utf-8")) != manifest:
            raise ValueError("monitoring runtime manifest readback differs")
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--environment", required=True, choices=("staging", "production"))
    result.add_argument("--source-root", required=True, type=Path)
    result.add_argument("--dashboard-image", required=True)
    result.add_argument("--prometheus-image", required=True)
    result.add_argument("--source", required=True)
    result.add_argument("--revision", required=True)
    result.add_argument("--version", required=True)
    result.add_argument("--host-payload-digest", required=True)
    result.add_argument("--host-payload-revision", required=True)
    result.add_argument("--validate-local-images", action="store_true")
    result.add_argument("--validate-host-state", action="store_true")
    return result


def main(arguments: Sequence[str] | None = None) -> int:
    options = parser().parse_args(arguments)
    if os.geteuid() != 0:
        raise PermissionError("monitoring runtime rendering must run as root")
    validate_host_payload_identity(options.host_payload_digest)
    if REVISION.fullmatch(options.host_payload_revision) is None:
        raise ValueError("monitoring host payload revision must be one full lowercase Git SHA")
    source_root = options.source_root.resolve(strict=True)
    if source_root.name != "infra":
        raise ValueError("monitoring source root must come from a materialized host payload")
    payload_root = source_root.parent
    # The candidate never imports or executes its own verifier. This read-only
    # fixed-verifier check precedes lock-file creation and every runtime change.
    verify_materialized_host_payload(
        payload_root=payload_root,
        expected_digest=options.host_payload_digest,
        expected_revision=options.host_payload_revision,
    )
    with host_operation_lock():
        runtime_root = validate_live_runtime_root()
        validate_inputs(
            options.dashboard_image,
            options.prometheus_image,
            options.source,
            options.revision,
            options.version,
        )
        if options.validate_local_images:
            validate_local_images(
                dashboard_image=options.dashboard_image,
                prometheus_image=options.prometheus_image,
                source=options.source,
                revision=options.revision,
                version=options.version,
            )
        if options.validate_host_state:
            validate_host_state(options.environment)
        render_runtime(
            environment=options.environment,
            source_root=options.source_root,
            runtime_root=runtime_root,
            dashboard_image=options.dashboard_image,
            prometheus_image=options.prometheus_image,
            source=options.source,
            revision=options.revision,
            version=options.version,
            host_payload_digest=options.host_payload_digest,
            host_payload_revision=options.host_payload_revision,
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"monitoring render failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
