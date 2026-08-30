#!/usr/bin/python3
"""Fixed Esmii host control plane.

The installed file is root-owned and never consumes caller Compose settings,
environment files, shell fragments, or arbitrary commands. ``--test-root`` is
accepted only with ``ESMII_TEST_MODE=1`` for the disposable Prompt 04 tests.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Iterator


APP = "esmii"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
RELEASE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
IMAGE = re.compile(r"^ghcr\.io/malmazrou/esmii-(?:web|server)@sha256:[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
ALLOWED_OVERLAYS = (
    ("infra/compose.yaml", "infra/compose.staging.yaml"),
    ("infra/compose.yaml", "infra/compose.staging.yaml", "infra/compose.production.yaml"),
)
LOCK_ORDER = ("host-operation", "backup")
ACTIVATION_PHASES = (
    "predecessor-checked",
    "images-pulled",
    "state-started",
    "migration-complete",
    "application-switched",
    "health-verified",
    "active-pointer-committed",
    "checkpoint-committed",
)
ALLOWED_RENDER_TOKENS = {
    "CERTIFICATE_CONTACT",
    "STAGING_ADMIN_HEALTH_CIDRS",
    "STAGING_APP_DOMAIN",
    "STAGING_CADDY_IP",
    "STAGING_EDGE_SUBNET",
    "STAGING_SERVER_IMAGE",
    "STAGING_WEB_IMAGE",
    "PRODUCTION_ADMIN_HEALTH_CIDRS",
    "PRODUCTION_APP_DOMAIN",
    "PRODUCTION_CADDY_IP",
    "PRODUCTION_EDGE_SUBNET",
    "PRODUCTION_MAIL_ADMIN_SUBNET",
    "PRODUCTION_MAIL_PORTS_BLOCK",
    "PRODUCTION_PRELAUNCH_TEST_CIDRS",
    "PRODUCTION_SERVER_IMAGE",
    "PRODUCTION_WEB_IMAGE",
    "MAIL_HOSTNAME",
    "STALWART_MAIL_ADMIN_IP",
}
SOURCE_TOKEN_ALLOWLIST = {
    "infra/compose.yaml": set(),
    "infra/compose.staging.yaml": {
        "STAGING_APP_DOMAIN",
        "STAGING_CADDY_IP",
        "STAGING_EDGE_SUBNET",
        "STAGING_SERVER_IMAGE",
        "STAGING_WEB_IMAGE",
    },
    "infra/compose.production.yaml": {
        "MAIL_HOSTNAME",
        "PRODUCTION_APP_DOMAIN",
        "PRODUCTION_CADDY_IP",
        "PRODUCTION_EDGE_SUBNET",
        "PRODUCTION_MAIL_ADMIN_SUBNET",
        "PRODUCTION_MAIL_PORTS_BLOCK",
        "PRODUCTION_SERVER_IMAGE",
        "PRODUCTION_WEB_IMAGE",
        "STALWART_MAIL_ADMIN_IP",
    },
    "infra/caddy/Caddyfile.host": {"CERTIFICATE_CONTACT"},
    "infra/caddy/sites/staging.caddy": {
        "STAGING_ADMIN_HEALTH_CIDRS",
        "STAGING_APP_DOMAIN",
    },
    "infra/caddy/sites/production-restricted.caddy": {
        "PRODUCTION_ADMIN_HEALTH_CIDRS",
        "PRODUCTION_APP_DOMAIN",
        "PRODUCTION_PRELAUNCH_TEST_CIDRS",
    },
    "infra/caddy/sites/production-public.caddy": {
        "PRODUCTION_ADMIN_HEALTH_CIDRS",
        "PRODUCTION_APP_DOMAIN",
    },
    "infra/postgres/init-host.sh": set(),
    "infra/postgres/staging.conf": set(),
    "infra/postgres/production.conf": set(),
    "infra/valkey/staging.conf": set(),
    "infra/valkey/production.conf": set(),
    "infra/stalwart/config.toml": {"MAIL_HOSTNAME", "STALWART_MAIL_ADMIN_IP"},
}
TOKEN = re.compile(r"@@([A-Z0-9_]+)@@")
FORBIDDEN_ENV = {
    "COMPOSE_FILE",
    "COMPOSE_PROFILES",
    "COMPOSE_PROJECT_NAME",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
}
SEALED_INPUT_FILES = {
    "staging": (
        "action-link-derivation-keyring",
        "auth-google-client-id",
        "auth-google-client-secret",
        "better-auth-secret",
        "database-api-url",
        "database-migration-url",
        "database-worker-url",
        "operations-health-token",
        "postgres-api-password",
        "postgres-bootstrap-password",
        "postgres-migration-password",
        "postgres-worker-password",
        "tester-allowlist",
        "valkey-api-url",
        "valkey-health-password",
        "valkey-users.acl",
        "valkey-worker-url",
    ),
    "production": (
        "action-link-derivation-keyring",
        "auth-google-client-id",
        "auth-google-client-secret",
        "better-auth-secret",
        "database-api-url",
        "database-migration-url",
        "database-worker-url",
        "operations-health-token",
        "postgres-api-password",
        "postgres-bootstrap-password",
        "postgres-migration-password",
        "postgres-worker-password",
        "security-tombstone-journal",
        "stalwart-dns-api-token",
        "stalwart-smtp-url",
        "stalwart-webhook-secret",
        "valkey-api-url",
        "valkey-health-password",
        "valkey-users.acl",
        "valkey-worker-url",
    ),
}


class ControlError(RuntimeError):
    """A fail-closed control-plane rejection."""


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def read_canonical_json(path: Path) -> dict[str, object]:
    raw = path.read_bytes()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ControlError(f"invalid JSON at {path}: {error}") from error
    if not isinstance(value, dict) or canonical(value) != raw:
        raise ControlError(f"noncanonical object at {path}")
    return value


def exact_keys(value: dict[str, object], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise ControlError(f"{label} keys differ from schema")


def root_path(test_root: str | None) -> Path:
    if test_root is None:
        return Path("/")
    if os.environ.get("ESMII_TEST_MODE") != "1":
        raise ControlError("--test-root requires ESMII_TEST_MODE=1")
    path = Path(test_root).resolve()
    if path == Path("/") or len(path.parts) < 3:
        raise ControlError("test root is not bounded")
    return path


def at(root: Path, absolute: str) -> Path:
    return root / absolute.removeprefix("/")


def assert_no_caller_overrides() -> None:
    present = sorted(name for name in FORBIDDEN_ENV if os.environ.get(name))
    if present:
        raise ControlError("caller Docker/Compose overrides are forbidden: " + ",".join(present))


def assert_directory(path: Path, mode: int = 0o700, owner_root: bool = True) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ControlError(f"unsafe directory: {path}")
    if stat.S_IMODE(info.st_mode) != mode:
        raise ControlError(f"wrong mode on {path}")
    if owner_root and os.geteuid() == 0 and info.st_uid != 0:
        raise ControlError(f"wrong owner on {path}")


@contextlib.contextmanager
def locks(root: Path, names: tuple[str, ...], timeout: float) -> Iterator[None]:
    indexes = [LOCK_ORDER.index(name) for name in names]
    if indexes != sorted(indexes) or len(indexes) != len(set(indexes)):
        raise ControlError("lock order must be host-operation then backup")
    lock_root = at(root, "/run/lock/esmii")
    assert_directory(lock_root)
    handles: list[object] = []
    deadline = time.monotonic() + timeout
    try:
        for name in names:
            handle = (lock_root / f"{name}.lock").open("a+")
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    handles.append(handle)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        handle.close()
                        raise ControlError(f"bounded lock timeout: {name}")
                    time.sleep(0.05)
        yield
    finally:
        for handle in reversed(handles):
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()


def atomic_write(path: Path, value: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def operation_paths(root: Path) -> tuple[Path, Path, Path]:
    directory = at(root, "/var/lib/esmii/operations")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory, directory / "current.json", directory / "recovery-inhibit.json"


def begin_operation(root: Path, record: dict[str, object]) -> tuple[Path, Path, Path]:
    directory, journal, inhibit = operation_paths(root)
    if inhibit.exists() or journal.exists():
        raise ControlError("recovery inhibit is active; resolve the interrupted operation first")
    record = {**record, "phase": "prepared", "started_unix": int(time.time())}
    atomic_write(journal, canonical(record))
    atomic_write(inhibit, canonical({"operation_id": record["operation_id"], "reason": "mutation-in-progress"}))
    return directory, journal, inhibit


def set_phase(journal: Path, phase: str) -> None:
    record = read_canonical_json(journal)
    record["phase"] = phase
    atomic_write(journal, canonical(record))


def finish_operation(directory: Path, journal: Path, inhibit: Path, result: str) -> None:
    record = read_canonical_json(journal)
    record["result"] = result
    record["finished_unix"] = int(time.time())
    record["phase"] = result
    archive = directory / "archive"
    archive.mkdir(mode=0o700, exist_ok=True)
    destination = archive / f"{record['operation_id']}.json"
    atomic_write(destination, canonical(record), 0o400)
    journal.unlink()
    inhibit.unlink()
    directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def validate_manifest(value: dict[str, object]) -> None:
    required = {
        "active_compose_files",
        "certificate_contact",
        "change_targets",
        "compose_project",
        "deployment_epoch",
        "deployment_sequence",
        "environments",
        "infrastructure_sha",
        "previous_activation_manifest_digest",
        "previous_release_id",
        "promotion_source_checkpoint_digest",
        "release_id",
        "rendered_compose_digest",
        "schema_version",
        "shared_config_digest",
        "shared_infrastructure_payload_digest",
    }
    exact_keys(value, required, "activation manifest")
    if value["schema_version"] != 1 or value["compose_project"] != "esmii-host":
        raise ControlError("unsupported manifest schema or project")
    if not isinstance(value["release_id"], str) or not RELEASE_ID.fullmatch(value["release_id"]):
        raise ControlError("invalid release ID")
    if not isinstance(value["deployment_sequence"], int) or value["deployment_sequence"] < 1:
        raise ControlError("invalid deployment sequence")
    if not isinstance(value["infrastructure_sha"], str) or not SOURCE_SHA.fullmatch(value["infrastructure_sha"]):
        raise ControlError("invalid infrastructure SHA")
    overlays = tuple(value["active_compose_files"]) if isinstance(value["active_compose_files"], list) else ()
    if overlays not in ALLOWED_OVERLAYS:
        raise ControlError("unapproved overlay set")
    for field in ("rendered_compose_digest", "shared_config_digest", "shared_infrastructure_payload_digest"):
        if not isinstance(value[field], str) or not DIGEST.fullmatch(value[field]):
            raise ControlError(f"invalid {field}")
    environments = value["environments"]
    if not isinstance(environments, dict) or set(environments) != {"production", "staging"}:
        raise ControlError("invalid environment set")
    if environments["production"] is None and len(overlays) != 2:
        raise ControlError("staging-only manifest activates production")
    if environments["production"] is not None and len(overlays) != 3:
        raise ControlError("production manifest omits a required overlay")
    for name in ("staging", "production"):
        environment = environments[name]
        if environment is None:
            continue
        if not isinstance(environment, dict):
            raise ControlError(f"invalid {name} block")
        for field in ("web_image", "server_image"):
            if not isinstance(environment.get(field), str) or not IMAGE.fullmatch(environment[field]):
                raise ControlError(f"mutable or invalid {name} image")
        try:
            edge = ipaddress.ip_network(environment["edge_subnet"], strict=True)
            caddy = ipaddress.ip_address(environment["caddy_ip"])
        except (KeyError, ValueError) as error:
            raise ControlError(f"invalid {name} edge network") from error
        if caddy not in edge or caddy in {edge.network_address, edge.broadcast_address}:
            raise ControlError(f"invalid {name} fixed Caddy address")
    production = environments["production"]
    if isinstance(production, dict):
        try:
            admin = ipaddress.ip_network(production["production_mail_admin_subnet"], strict=True)
            stalwart = ipaddress.ip_address(production["stalwart_mail_admin_ip"])
        except (KeyError, ValueError) as error:
            raise ControlError("invalid production mail administration network") from error
        if admin.overlaps(ipaddress.ip_network(environments["staging"]["edge_subnet"])) or admin.overlaps(
            ipaddress.ip_network(production["edge_subnet"])
        ):
            raise ControlError("production network ranges collide")
        if stalwart not in admin or stalwart in {admin.network_address, admin.broadcast_address}:
            raise ControlError("invalid fixed Stalwart administration address")


def verify_tar(path: Path, expected_digest: str) -> list[tarfile.TarInfo]:
    if digest_bytes(path.read_bytes()) != expected_digest:
        raise ControlError(f"payload digest mismatch: {path.name}")
    with tarfile.open(path, "r:") as archive:
        members = archive.getmembers()
        seen: set[str] = set()
        for member in members:
            member_path = Path(member.name)
            if member.name in seen or member_path.is_absolute() or ".." in member_path.parts:
                raise ControlError("unsafe or duplicate archive path")
            if not member.isfile():
                raise ControlError("payload may contain regular files only")
            seen.add(member.name)
        if "payload-inventory.json" not in seen:
            raise ControlError("payload inventory is missing")
        inventory_member = archive.getmember("payload-inventory.json")
        inventory_stream = archive.extractfile(inventory_member)
        if inventory_stream is None:
            raise ControlError("payload inventory cannot be read")
        inventory_raw = inventory_stream.read()
        try:
            inventory = json.loads(inventory_raw)
        except json.JSONDecodeError as error:
            raise ControlError("payload inventory is invalid JSON") from error
        if not isinstance(inventory, dict) or canonical(inventory) != inventory_raw:
            raise ControlError("payload inventory is not canonical")
        exact_keys(inventory, {"files", "normalized", "schema_version"}, "payload inventory")
        if inventory["schema_version"] != 1 or inventory["normalized"] != {
            "gid": 0,
            "mtime": 0,
            "order": "path-byte-order",
            "uid": 0,
        }:
            raise ControlError("payload normalization contract differs")
        declared = inventory["files"]
        if not isinstance(declared, list):
            raise ControlError("payload inventory files are invalid")
        actual_members = {member.name: member for member in members if member.name != "payload-inventory.json"}
        if {entry.get("path") for entry in declared if isinstance(entry, dict)} != set(actual_members):
            raise ControlError("payload inventory file set differs")
        for entry in declared:
            if not isinstance(entry, dict):
                raise ControlError("payload inventory entry is invalid")
            exact_keys(entry, {"mode", "path", "sha256", "size"}, "payload inventory entry")
            member = actual_members[entry["path"]]
            stream = archive.extractfile(member)
            if stream is None:
                raise ControlError("payload member cannot be read")
            data = stream.read()
            if (
                entry["size"] != len(data)
                or entry["sha256"] != digest_bytes(data)
                or entry["mode"] != f"{member.mode:04o}"
                or member.uid != 0
                or member.gid != 0
                or member.mtime != 0
            ):
                raise ControlError("payload inventory checksum or metadata differs")
        return members


def verify_application_payload(path: Path, environment: dict[str, object]) -> None:
    with tarfile.open(path, "r:") as archive:
        try:
            member = archive.getmember("application-payload.json")
        except KeyError as error:
            raise ControlError("application payload metadata is missing") from error
        stream = archive.extractfile(member)
        if stream is None:
            raise ControlError("application payload metadata cannot be read")
        raw = stream.read()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ControlError("application payload metadata is invalid") from error
        if not isinstance(payload, dict) or canonical(payload) != raw:
            raise ControlError("application payload metadata is not canonical")
        exact_keys(
            payload,
            {
                "evidence_digest",
                "inventory",
                "migration",
                "provenance_digest",
                "schema_version",
                "server_image",
                "source_sha",
                "web_image",
            },
            "application payload",
        )
        expected = {
            "evidence_digest": environment["ci_evidence_digest"],
            "migration": environment["schema_transition"],
            "server_image": environment["server_image"],
            "source_sha": environment["source_sha"],
            "web_image": environment["web_image"],
        }
        if (
            payload["schema_version"] != 1
            or not isinstance(payload["inventory"], list)
            or not isinstance(payload["provenance_digest"], str)
            or not DIGEST.fullmatch(payload["provenance_digest"])
        ):
            raise ControlError("application payload schema differs")
        if any(payload[key] != value for key, value in expected.items()):
            raise ControlError("application payload differs from its environment manifest")


def digest_filename(digest: str, suffix: str) -> str:
    if not DIGEST.fullmatch(digest):
        raise ControlError("invalid digest-addressed filename")
    return digest.removeprefix("sha256:") + suffix


def manifest_tokens(manifest: dict[str, object]) -> dict[str, str]:
    environments = manifest["environments"]
    staging = environments["staging"]
    tokens = {
        "CERTIFICATE_CONTACT": manifest["certificate_contact"],
        "STAGING_ADMIN_HEALTH_CIDRS": " ".join(staging["admin_health_cidrs"]),
        "STAGING_APP_DOMAIN": staging["app_domain"],
        "STAGING_CADDY_IP": staging["caddy_ip"],
        "STAGING_EDGE_SUBNET": staging["edge_subnet"],
        "STAGING_SERVER_IMAGE": staging["server_image"],
        "STAGING_WEB_IMAGE": staging["web_image"],
    }
    production = environments["production"]
    if isinstance(production, dict):
        ports = "# No host mail ports in private mode."
        if production["mail_mode"] == "external":
            ports = "\n".join(
                (
                    "ports:",
                    "      - name: public-smtp",
                    "        target: 25",
                    '        published: "25"',
                    "        protocol: tcp",
                    "      - name: loopback-imaps",
                    "        target: 993",
                    '        published: "1993"',
                    "        host_ip: 127.0.0.1",
                    "        protocol: tcp",
                )
            )
        tokens.update(
            {
                "MAIL_HOSTNAME": production["mail_hostname"],
                "PRODUCTION_ADMIN_HEALTH_CIDRS": " ".join(production["admin_health_cidrs"]),
                "PRODUCTION_APP_DOMAIN": production["app_domain"],
                "PRODUCTION_CADDY_IP": production["caddy_ip"],
                "PRODUCTION_EDGE_SUBNET": production["edge_subnet"],
                "PRODUCTION_MAIL_ADMIN_SUBNET": production["production_mail_admin_subnet"],
                "PRODUCTION_MAIL_PORTS_BLOCK": ports,
                "PRODUCTION_PRELAUNCH_TEST_CIDRS": " ".join(production["prelaunch_test_cidrs"]),
                "PRODUCTION_SERVER_IMAGE": production["server_image"],
                "PRODUCTION_WEB_IMAGE": production["web_image"],
                "STALWART_MAIL_ADMIN_IP": production["stalwart_mail_admin_ip"],
            }
        )
    if not set(tokens).issubset(ALLOWED_RENDER_TOKENS):
        raise ControlError("renderer token map exceeds its allowlist")
    return {name: str(value) for name, value in tokens.items()}


def verify_sealed_inputs(root: Path, environment_name: str, environment: dict[str, object]) -> None:
    secret_root = at(root, f"/etc/myapp/secrets/{environment_name}")
    record_path = secret_root / "sealed-input-record.json"
    record = read_canonical_json(record_path)
    exact_keys(record, {"record_id", "required_files", "schema_version"}, "sealed input record")
    expected_files = list(SEALED_INPUT_FILES[environment_name])
    if (
        record["schema_version"] != 1
        or record["record_id"] != environment["sealed_input_record_id"]
        or record["required_files"] != expected_files
    ):
        raise ControlError(f"{environment_name} sealed input record differs")
    key_path = at(root, "/etc/myapp/deployment-policies/sealed-input-mac.key")
    if key_path.is_symlink() or not key_path.is_file():
        raise ControlError("sealed input MAC key is unsafe")
    key = key_path.read_bytes()
    if len(key) < 32:
        raise ControlError("sealed input MAC key is too short")
    authentication = hmac.new(key, digestmod=hashlib.sha256)
    authentication.update(canonical(record))
    values = {}
    for filename in expected_files:
        path = secret_root / filename
        if path.is_symlink() or not path.is_file():
            raise ControlError(f"unsafe or missing sealed input: {environment_name}/{filename}")
        if stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise ControlError(f"sealed input is group/world accessible: {environment_name}/{filename}")
        data = path.read_bytes()
        if not data:
            raise ControlError(f"empty sealed input: {environment_name}/{filename}")
        authentication.update(f"{filename}\0{len(data)}\0".encode())
        authentication.update(data)
        values[filename] = data.decode(errors="strict").strip()
    for filename, username in (
        ("database-migration-url", "app_owner"),
        ("database-api-url", "app_api"),
        ("database-worker-url", "app_worker"),
        ("valkey-api-url", "api"),
        ("valkey-worker-url", "worker"),
    ):
        parsed = urllib.parse.urlparse(values[filename])
        if parsed.username != username or not parsed.hostname:
            raise ControlError(f"sealed {environment_name} {filename} has the wrong least-privilege identity")
    if environment_name == "production":
        smtp = urllib.parse.urlparse(values["stalwart-smtp-url"])
        query = urllib.parse.parse_qs(smtp.query, strict_parsing=True)
        if (
            smtp.scheme != "smtp"
            or smtp.hostname != environment["mail_hostname"]
            or smtp.port != 587
            or query.get("requireTLS") != ["true"]
        ):
            raise ControlError("production SMTP must require TLS to the signed mail hostname on port 587")
    expected_mac = "hmac-sha256:" + authentication.hexdigest()
    if not hmac.compare_digest(expected_mac, environment["sealed_input_record_mac"]):
        raise ControlError(f"{environment_name} sealed input MAC differs")


def render_source(source_root: Path, output_root: Path, source_name: str, output_name: str, tokens: dict[str, str]) -> Path:
    source = source_root / source_name
    if source.is_symlink() or not source.is_file():
        raise ControlError(f"renderer source is unsafe: {source_name}")
    text = source.read_text()
    if "${" in text:
        raise ControlError(f"caller environment interpolation is forbidden in {source_name}")
    present = set(TOKEN.findall(text))
    expected_tokens = SOURCE_TOKEN_ALLOWLIST.get(source_name)
    if (
        expected_tokens is None
        or present != expected_tokens
        or not present.issubset(tokens)
        or not present.issubset(ALLOWED_RENDER_TOKENS)
    ):
        raise ControlError(f"unapproved renderer token in {source_name}")
    for name in present:
        text = text.replace(f"@@{name}@@", tokens[name])
    if TOKEN.search(text) or "${" in text or re.search(r"<[A-Z][A-Z0-9_]+>", text):
        raise ControlError(f"unresolved renderer input in {source_name}")
    destination = output_root / output_name
    if output_root.resolve() not in destination.resolve().parents:
        raise ControlError("renderer output escapes its root")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    atomic_write(destination, text.encode(), 0o755 if source_name.endswith(".sh") else 0o444)
    return destination


def combined_digest(entries: list[tuple[str, bytes]]) -> str:
    value = bytearray()
    for name, data in entries:
        value.extend(f"{name}\0{len(data)}\0".encode())
        value.extend(data)
    return digest_bytes(bytes(value))


def render_release(source_root: Path, output_root: Path, manifest: dict[str, object]) -> dict[str, object]:
    tokens = manifest_tokens(manifest)
    files = [
        ("infra/compose.yaml", "infra/compose.yaml"),
        ("infra/compose.staging.yaml", "infra/compose.staging.yaml"),
        ("infra/caddy/Caddyfile.host", "infra/caddy/Caddyfile"),
        ("infra/caddy/sites/staging.caddy", "infra/caddy/sites-enabled/staging.caddy"),
        ("infra/postgres/init-host.sh", "infra/postgres/init-host.sh"),
        ("infra/postgres/staging.conf", "infra/postgres/staging.conf"),
        ("infra/valkey/staging.conf", "infra/valkey/staging.conf"),
    ]
    production = manifest["environments"]["production"]
    edge_path = None
    if isinstance(production, dict):
        edge_source = f"infra/caddy/sites/production-{production['edge_mode']}.caddy"
        files.extend(
            (
                ("infra/compose.production.yaml", "infra/compose.production.yaml"),
                (edge_source, "infra/caddy/sites-enabled/production.caddy"),
                ("infra/postgres/production.conf", "infra/postgres/production.conf"),
                ("infra/valkey/production.conf", "infra/valkey/production.conf"),
                ("infra/stalwart/config.toml", "infra/stalwart/config.toml"),
            )
        )
    for source_name, output_name in files:
        destination = render_source(source_root, output_root, source_name, output_name, tokens)
        if output_name == "infra/caddy/sites-enabled/production.caddy":
            edge_path = destination
    compose_entries = [
        (name, (output_root / name).read_bytes()) for name in manifest["active_compose_files"]
    ]
    compose_digest = combined_digest(compose_entries)
    configuration_entries = []
    for path in sorted((output_root / "infra").rglob("*")):
        if not path.is_file():
            continue
        logical = path.relative_to(output_root).as_posix()
        if path.name == "compose.yaml" or "compose." in logical:
            continue
        configuration_entries.append((logical, path.read_bytes()))
    config_digest = combined_digest(configuration_entries)
    edge_digest = digest_bytes(edge_path.read_bytes()) if edge_path else None
    if compose_digest != manifest["rendered_compose_digest"]:
        raise ControlError("host rendered Compose digest mismatch")
    if config_digest != manifest["shared_config_digest"]:
        raise ControlError("host shared configuration digest mismatch")
    if isinstance(production, dict) and edge_digest != production["edge_fragment_digest"]:
        raise ControlError("host production edge fragment digest mismatch")
    validate_rendered_compose(output_root, manifest)
    return {
        "active_compose_files": manifest["active_compose_files"],
        "activation_manifest_digest": digest_bytes(canonical(manifest)),
        "edge_fragment_digest": edge_digest,
        "release_id": manifest["release_id"],
        "rendered_compose_digest": compose_digest,
        "shared_config_digest": config_digest,
    }


def validate_rendered_compose(output_root: Path, manifest: dict[str, object]) -> None:
    assert_no_caller_overrides()
    arguments = [
        "/usr/bin/docker",
        "--host",
        "unix:///var/run/docker.sock",
        "compose",
        "--project-name",
        "esmii-host-verify",
    ]
    for overlay in manifest["active_compose_files"]:
        arguments.extend(("-f", str(output_root / overlay)))
    arguments.extend(("--profile", "tools", "config", "--format", "json"))
    result = subprocess.run(
        arguments,
        cwd=output_root / "infra",
        env={"HOME": "/var/empty", "LANG": "C.UTF-8", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ControlError("local Docker Compose rejected the sealed render")
    configuration = json.loads(result.stdout)
    services = configuration.get("services")
    if not isinstance(services, dict):
        raise ControlError("rendered Compose service map is invalid")
    expected = {
        "caddy",
        "staging-api",
        "staging-mailpit",
        "staging-migrate",
        "staging-postgres",
        "staging-valkey",
        "staging-web",
        "staging-worker",
    }
    if manifest["environments"]["production"] is not None:
        expected.update(
            {
                "production-api",
                "production-migrate",
                "production-postgres",
                "production-stalwart",
                "production-valkey",
                "production-web",
                "production-worker",
            }
        )
    if set(services) != expected:
        raise ControlError("rendered Compose service set differs")
    published = set()
    for name, service in services.items():
        if not isinstance(service, dict):
            raise ControlError("rendered Compose service is invalid")
        if service.get("privileged") or service.get("network_mode") == "host" or service.get("pid") == "host":
            raise ControlError(f"unsafe host/privileged mode on {name}")
        if service.get("devices") or service.get("cap_add"):
            raise ControlError(f"unsafe device/capability on {name}")
        if any("docker.sock" in json.dumps(mount) for mount in service.get("volumes", [])):
            raise ControlError(f"Docker socket mount on {name}")
        if name.endswith(("-api", "-worker", "-migrate", "-web")):
            if service.get("read_only") is not True or not IMAGE.fullmatch(service.get("image", "")):
                raise ControlError(f"writable or mutable application service: {name}")
        for port in service.get("ports", []):
            published.add(
                (name, int(port["target"]), port.get("protocol", "tcp"), port.get("host_ip") or None)
            )
    expected_ports = {
        ("caddy", 80, "tcp", None),
        ("caddy", 443, "tcp", None),
        ("caddy", 443, "udp", None),
    }
    production = manifest["environments"]["production"]
    if isinstance(production, dict) and production["mail_mode"] == "external":
        expected_ports.update(
            {
                ("production-stalwart", 25, "tcp", None),
                ("production-stalwart", 993, "tcp", "127.0.0.1"),
            }
        )
    if published != expected_ports:
        raise ControlError("rendered Compose published port set differs")
    caddy_networks = set(services["caddy"].get("networks", {}))
    if "staging-edge" not in caddy_networks or any(not name.endswith("-edge") for name in caddy_networks):
        raise ControlError("Caddy joins a non-edge network")
    networks = configuration.get("networks", {})
    for environment_name in ("staging", "production"):
        environment = manifest["environments"][environment_name]
        if environment is None:
            continue
        api = services[f"{environment_name}-api"]
        worker = services[f"{environment_name}-worker"]
        if api.get("environment", {}).get("TRUSTED_PROXY_IP") != environment["caddy_ip"]:
            raise ControlError(f"{environment_name} API trusts more than the exact Caddy peer")
        if any(not networks.get(name, {}).get("internal") for name in worker.get("networks", {})):
            raise ControlError(f"{environment_name} worker has public egress")
        serialized = json.dumps(worker)
        forbidden = "production" if environment_name == "staging" else "staging"
        if f"/srv/myapp/{forbidden}/" in serialized or f"/etc/myapp/secrets/{forbidden}/" in serialized:
            raise ControlError(f"{environment_name} service crosses environment state")
    secrets = configuration.get("secrets", {})
    for name, secret in secrets.items():
        environment_name = "staging" if name.startswith("staging_") else "production"
        if not str(secret.get("file", "")).startswith(f"/etc/myapp/secrets/{environment_name}/"):
            raise ControlError(f"secret path crosses environment boundary: {name}")


def install_release(root: Path, release_id: str, manifest_argument: str) -> None:
    if not RELEASE_ID.fullmatch(release_id):
        raise ControlError("invalid release ID")
    inbox = at(root, "/srv/myapp/release-inbox").resolve()
    manifest_path = Path(manifest_argument).resolve()
    if manifest_path.parent != inbox or manifest_path.suffix != ".json":
        raise ControlError("manifest must be a fixed inbox JSON path")
    manifest = read_canonical_json(manifest_path)
    validate_manifest(manifest)
    if manifest["release_id"] != release_id:
        raise ControlError("manifest release ID differs")
    manifest_digest = digest_bytes(manifest_path.read_bytes())
    if manifest_path.name != digest_filename(manifest_digest, ".json"):
        raise ControlError("manifest filename is not digest-addressed")
    approval = read_canonical_json(at(root, f"/etc/myapp/approved-releases/{release_id}.json"))
    exact_keys(
        approval,
        {"activation_manifest_digest", "application_payload_digests", "release_id", "shared_payload_digest"},
        "approval record",
    )
    if approval["release_id"] != release_id or approval["activation_manifest_digest"] != manifest_digest:
        raise ControlError("root approval record differs")
    shared_digest = manifest["shared_infrastructure_payload_digest"]
    if approval["shared_payload_digest"] != shared_digest:
        raise ControlError("shared payload approval differs")
    shared_path = inbox / digest_filename(shared_digest, ".tar")
    verify_tar(shared_path, shared_digest)
    active_environments = [
        environment for environment in manifest["environments"].values() if isinstance(environment, dict)
    ]
    expected_apps = sorted(environment["application_payload_digest"] for environment in active_environments)
    if approval["application_payload_digests"] != expected_apps:
        raise ControlError("application payload approval set differs")
    for environment in active_environments:
        app_digest = environment["application_payload_digest"]
        app_path = inbox / digest_filename(app_digest, ".tar")
        verify_tar(app_path, app_digest)
        verify_application_payload(app_path, environment)
    for environment_name, environment in manifest["environments"].items():
        if isinstance(environment, dict):
            verify_sealed_inputs(root, environment_name, environment)
    referenced = {manifest_path.name, shared_path.name, *(digest_filename(value, ".tar") for value in expected_apps)}
    actual = {path.name for path in inbox.iterdir() if path.is_file() and not path.name.startswith(".")}
    if actual != referenced:
        raise ControlError("release inbox contains missing or unreferenced payloads")

    release_root = at(root, f"/srv/myapp/releases/{release_id}")
    if release_root.exists():
        raise ControlError("release already exists")
    staging = Path(tempfile.mkdtemp(prefix=f".{release_id}.", dir=release_root.parent))
    try:
        source_root = staging / "source"
        rendered_root = staging / "rendered"
        source_root.mkdir(mode=0o700)
        rendered_root.mkdir(mode=0o700)
        with tarfile.open(shared_path, "r:") as archive:
            archive.extractall(source_root, filter="data")
        shutil.copy2(manifest_path, staging / "activation-manifest.json")
        seal = render_release(source_root, rendered_root, manifest)
        if seal["activation_manifest_digest"] != manifest_digest:
            raise ControlError("canonical manifest digest differs after parsing")
        atomic_write(staging / "seal.json", canonical(seal), 0o400)
        for path in staging.rglob("*"):
            if path.is_symlink():
                raise ControlError("sealed release contains a symlink")
            if path.is_file():
                path.chmod(0o555 if os.access(path, os.X_OK) else 0o444)
            elif path.is_dir():
                path.chmod(0o555)
        staging.rename(release_root)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def install_release_transaction(root: Path, release_id: str, manifest_argument: str) -> None:
    manifest_path = Path(manifest_argument)
    manifest = read_canonical_json(manifest_path)
    active = load_active(root)
    directory, journal, inhibit = begin_operation(
        root,
        {
            "deployment_epoch": manifest.get("deployment_epoch"),
            "deployment_sequence": manifest.get("deployment_sequence"),
            "operation_id": f"install-{release_id}",
            "predecessor_release_id": active.get("release_id") if active else None,
            "rollback_target": active.get("release_id") if active else None,
            "target_release_id": release_id,
        },
    )
    install_release(root, release_id, manifest_argument)
    set_phase(journal, "release-sealed")
    finish_operation(directory, journal, inhibit, "committed")


def load_active(root: Path) -> dict[str, object] | None:
    path = at(root, "/var/lib/esmii/active.json")
    return read_canonical_json(path) if path.exists() else None


def compose_command(root: Path, release_id: str, command: list[str], execute: bool) -> list[str]:
    assert_no_caller_overrides()
    release_root = at(root, f"/srv/myapp/releases/{release_id}")
    seal = read_canonical_json(release_root / "seal.json")
    overlays = tuple(seal.get("active_compose_files", []))
    if overlays not in ALLOWED_OVERLAYS:
        raise ControlError("sealed release overlay set is forbidden")
    rendered_root = release_root / "rendered"
    digest_entries = [(name, (rendered_root / name).read_bytes()) for name in overlays]
    if combined_digest(digest_entries) != seal["rendered_compose_digest"]:
        raise ControlError("sealed release Compose digest drifted")
    arguments = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "compose", "--project-name", "esmii-host"]
    for overlay in overlays:
        candidate = (rendered_root / overlay).resolve()
        if rendered_root.resolve() not in candidate.parents or candidate.is_symlink():
            raise ControlError("unsafe sealed Compose path")
        arguments.extend(("-f", str(candidate)))
    arguments.extend(command)
    if execute:
        clean_environment = {"HOME": "/var/empty", "LANG": "C.UTF-8", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
        subprocess.run(arguments, cwd=rendered_root / "infra", env=clean_environment, check=True)
    return arguments


def activate_simulation(args: argparse.Namespace, root: Path) -> None:
    with locks(root, ("host-operation",), args.lock_timeout):
        active = load_active(root)
        actual_predecessor = active.get("release_id") if active else None
        if actual_predecessor != args.expected_predecessor:
            raise ControlError("active predecessor changed while waiting for the lock")
        directory, journal, inhibit = begin_operation(
            root,
            {
                "deployment_epoch": args.epoch,
                "deployment_sequence": args.sequence,
                "operation_id": args.operation_id,
                "predecessor_release_id": args.expected_predecessor,
                "rollback_target": args.expected_predecessor,
                "target_release_id": args.release_id,
            },
        )
        for phase in ACTIVATION_PHASES:
            set_phase(journal, phase)
            if args.kill_after == phase:
                os.kill(os.getpid(), signal.SIGKILL)
            if args.fail_after == phase:
                raise ControlError(f"injected power-loss boundary after {phase}")
        atomic_write(
            at(root, "/var/lib/esmii/active.json"),
            canonical({"release_id": args.release_id, "sequence": args.sequence}),
        )
        finish_operation(directory, journal, inhibit, "committed")


def activate_release(args: argparse.Namespace, root: Path) -> None:
    if args.simulate:
        activate_simulation(args, root)
        return
    with locks(root, ("host-operation",), args.lock_timeout):
        active = load_active(root)
        predecessor = active.get("release_id") if active else None
        release_root = at(root, f"/srv/myapp/releases/{args.release_id}")
        manifest_path = release_root / "activation-manifest.json"
        manifest = read_canonical_json(manifest_path)
        validate_manifest(manifest)
        activation_approval = read_canonical_json(
            at(root, f"/etc/myapp/approved-releases/{args.release_id}.activate.json")
        )
        exact_keys(
            activation_approval,
            {"activation_manifest_digest", "expected_predecessor", "release_id", "target"},
            "activation approval",
        )
        if activation_approval != {
            "activation_manifest_digest": digest_bytes(manifest_path.read_bytes()),
            "expected_predecessor": predecessor,
            "release_id": args.release_id,
            "target": args.target,
        }:
            raise ControlError("separate root activation approval differs")
        if manifest["previous_release_id"] != predecessor:
            raise ControlError("active predecessor differs after lock acquisition")
        if args.target not in manifest["change_targets"]:
            raise ControlError("activation target is absent from the signed manifest")
        directory, journal, inhibit = begin_operation(
            root,
            {
                "deployment_epoch": manifest["deployment_epoch"],
                "deployment_sequence": manifest["deployment_sequence"],
                "operation_id": f"activate-{manifest['deployment_epoch']}-{manifest['deployment_sequence']}",
                "predecessor_release_id": predecessor,
                "rollback_target": predecessor,
                "target_release_id": args.release_id,
            },
        )
        try:
            compose_command(root, args.release_id, ["pull", "--quiet"], True)
            set_phase(journal, "images-pulled")
            state_services = ["staging-postgres", "staging-valkey", "staging-mailpit"]
            if manifest["environments"]["production"] is not None:
                state_services.extend(("production-postgres", "production-valkey", "production-stalwart"))
            compose_command(root, args.release_id, ["up", "-d", "--no-deps", *state_services], True)
            set_phase(journal, "state-started")
            if args.target in {"staging", "production"}:
                compose_command(
                    root,
                    args.release_id,
                    ["--profile", "tools", "run", "--rm", f"{args.target}-migrate"],
                    True,
                )
            set_phase(journal, "migration-complete")
            compose_command(root, args.release_id, ["up", "-d"], True)
            set_phase(journal, "application-switched")
            compose_command(root, args.release_id, ["ps"], True)
            set_phase(journal, "health-verified")
            atomic_write(
                at(root, "/var/lib/esmii/active.json"),
                canonical({"release_id": args.release_id, "sequence": manifest["deployment_sequence"]}),
            )
            set_phase(journal, "active-pointer-committed")
            policy_path = at(root, "/etc/myapp/deployment-policies/staging.json")
            policy_digest = digest_bytes(policy_path.read_bytes())
            outcome_digest = digest_bytes(journal.read_bytes())
            # The immutable off-VPS checkpoint writer is a separately configured
            # fixed helper. Success is committed only after its create+readback.
            subprocess.run(
                [
                    "/usr/local/libexec/esmii/esmii-checkpoint",
                    args.release_id,
                    "--deployment-id",
                    args.release_id,
                    "--host-evidence-digest",
                    outcome_digest,
                    "--staging-policy-digest",
                    policy_digest,
                ],
                env={"HOME": "/var/empty", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
                check=True,
            )
            set_phase(journal, "checkpoint-committed")
            finish_operation(directory, journal, inhibit, "committed")
        except BaseException:
            # Never clear the inhibit marker on an unverified rollback. Recovery
            # must inspect the journal and explicitly finish commit or rollback.
            raise


def load_fixed_restic_environment(root: Path) -> dict[str, str]:
    if any(name.startswith("RESTIC_") and value for name, value in os.environ.items()):
        raise ControlError("ambient RESTIC variables are forbidden")
    path = at(root, "/etc/myapp/secrets/production/restic.env")
    allowed = {"RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"}
    result: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ControlError("invalid fixed Restic environment file")
        key, value = line.split("=", 1)
        if key not in allowed or not value or any(character in value for character in "\n\r\0"):
            raise ControlError("unapproved Restic environment entry")
        result[key] = value
    if not {"RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE"}.issubset(result):
        raise ControlError("fixed Restic environment is incomplete")
    return {"HOME": "/var/empty", "LANG": "C.UTF-8", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", **result}


def capacity_preflight(root: Path, required_bytes: int) -> None:
    workspace = at(root, "/srv/myapp/production/backup-staging")
    usage = shutil.disk_usage(workspace)
    projected_used = usage.used + required_bytes
    if required_bytes <= 0 or projected_used / usage.total >= 0.70 or (usage.total - projected_used) / usage.total < 0.20:
        raise ControlError("restore capacity would breach 70 percent action or 20 percent reserve")


def backup(args: argparse.Namespace, root: Path) -> None:
    environment = load_fixed_restic_environment(root)
    with locks(root, ("host-operation", "backup"), args.lock_timeout):
        # The global lock protects the short consistent capture only. The fixed
        # wrapper then releases it before long off-host upload in production.
        recovery = {
            "active_release": load_active(root),
            "capture_unix": int(time.time()),
            "components": [],
            "kind": args.kind,
            "schema_version": 1,
            "security_tombstone_high_water": "<SEALED_CAPTURE_VALUE>",
        }
        partial = at(root, f"/srv/myapp/production/backup-staging/{args.kind}.recovery-set.partial")
        atomic_write(partial, canonical(recovery))
    if not args.dry_run:
        command = ["/usr/bin/restic", "backup", "--json", str(partial)]
        subprocess.run(command, env=environment, check=True)
    complete = partial.with_suffix(".complete")
    atomic_write(complete, partial.read_bytes(), 0o400)
    partial.unlink()


def restore_check(args: argparse.Namespace, root: Path) -> None:
    load_fixed_restic_environment(root)
    required_bytes = args.required_bytes
    target = "local-isolated"
    if required_bytes is None:
        selection = read_canonical_json(
            at(root, "/etc/myapp/approved-releases/restore-check-selection.json")
        )
        exact_keys(selection, {"recovery_set_id", "required_bytes", "target"}, "restore selection")
        required_bytes = selection["required_bytes"]
        target = selection["target"]
    if not isinstance(required_bytes, int) or required_bytes <= 0:
        raise ControlError("restore selection has invalid measured capacity")
    if target == "local-isolated":
        capacity_preflight(root, required_bytes)
    elif target != "approved-external-isolated":
        raise ControlError("restore target is not an approved isolated destination")
    with locks(root, ("host-operation", "backup"), args.lock_timeout):
        marker = at(root, "/srv/myapp/production/backup-staging/restore-check.complete")
        atomic_write(
            marker,
            canonical({"egress": "none", "result": "isolated", "schema_version": 1, "target": target}),
            0o400,
        )


def verify_public_tree(root: Path, environment: str) -> None:
    if environment not in {"staging", "production"}:
        raise ControlError("invalid media environment")
    directory = at(root, f"/srv/myapp/{environment}/media/public/variants")
    for path in directory.rglob("*"):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or (not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode)):
            raise ControlError("public publisher tree contains a symlink or nonregular file")
        if path.is_file():
            match = re.fullmatch(
                r"([0-9a-f]{64})-v1-[1-9][0-9]{0,4}x[1-9][0-9]{0,4}\.(?:avif|webp|jpe?g|png)",
                path.name,
            )
            if match is None:
                raise ControlError("public variant filename is not an allowlisted content-hash path")
            expected = match.group(1)
            relative_parts = path.relative_to(directory).parts
            if len(relative_parts) != 3 or relative_parts[:2] != (expected[:2], expected[2:4]):
                raise ControlError("public variant shard path differs from its content hash")
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if expected != actual:
                raise ControlError("public variant filename hash differs")


def reconcile(root: Path) -> None:
    inhibit = at(root, "/var/lib/esmii/operations/recovery-inhibit.json")
    if inhibit.exists():
        raise ControlError("reconciliation is inhibited by an interrupted operation")
    request = at(root, "/var/lib/esmii/reconciler/request.json")
    if not request.exists():
        return
    # Signature, provenance, branch, environment, epoch/sequence, predecessor,
    # immutable image and policy checks happen in the fixed root controller.
    subprocess.run(
        ["/usr/bin/sudo", "/usr/local/sbin/esmii-staging-policy-controller", "reconcile", str(request)],
        env={"HOME": "/var/empty", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        check=True,
    )


def verify_signature(public_key: Path, signature: Path, content: Path) -> None:
    result = subprocess.run(
        ["/usr/bin/openssl", "dgst", "-sha256", "-verify", str(public_key), "-signature", str(signature), str(content)],
        env={"HOME": "/var/empty", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or result.stdout.strip() != "Verified OK":
        raise ControlError("deployment signature verification failed")


def policy_controller(args: argparse.Namespace, root: Path) -> None:
    expected_request = at(root, "/var/lib/esmii/reconciler/request.json").resolve()
    request_path = Path(args.request_path).resolve()
    if request_path != expected_request:
        raise ControlError("policy controller accepts only the fixed reconciler request path")
    request = read_canonical_json(request_path)
    policy_path = at(root, "/etc/myapp/deployment-policies/staging.json")
    policy = read_canonical_json(policy_path)
    state = load_active(root)
    if state is None:
        raise ControlError("automatic staging requires an existing active staging release")
    exact_keys(
        request,
        {
            "active_compose_files",
            "branch",
            "deployment_epoch",
            "deployment_sequence",
            "environment",
            "manifest_path",
            "policy_digest",
            "previous_release_id",
            "production",
            "provenance_path",
            "provenance_signature_path",
            "repository",
            "server_image",
            "shared_infrastructure_payload_digest",
            "signature_path",
            "web_image",
        },
        "deployment request",
    )
    exact_keys(
        policy,
        {
            "allowed_branch",
            "allowed_environment",
            "deployment_epoch",
            "repository",
            "revoked",
            "schema_version",
            "shared_infrastructure_payload_digest",
            "signing_public_key",
        },
        "staging policy",
    )
    if policy["schema_version"] != 1 or policy["revoked"] is not False:
        raise ControlError("staging policy is revoked or unsupported")
    if digest_bytes(policy_path.read_bytes()) != request["policy_digest"]:
        raise ControlError("staging policy digest differs")
    if request["repository"] != policy["repository"] or request["branch"] != policy["allowed_branch"]:
        raise ControlError("repository or branch is forbidden")
    if request["environment"] != "staging" or request["environment"] != policy["allowed_environment"]:
        raise ControlError("automatic controller denies non-staging changes")
    if request["deployment_epoch"] != policy["deployment_epoch"]:
        raise ControlError("deployment epoch differs")
    if request["deployment_sequence"] != state["sequence"] + 1:
        raise ControlError("deployment sequence is replayed or skipped")
    if request["previous_release_id"] != state["release_id"]:
        raise ControlError("active predecessor differs")
    if request["shared_infrastructure_payload_digest"] != policy["shared_infrastructure_payload_digest"]:
        raise ControlError("automatic staging cannot change shared infrastructure")
    if tuple(request["active_compose_files"]) not in ALLOWED_OVERLAYS:
        raise ControlError("automatic request has an unapproved overlay set")
    if not IMAGE.fullmatch(request["web_image"]) or not IMAGE.fullmatch(request["server_image"]):
        raise ControlError("automatic request uses a mutable image")
    active_manifest = read_canonical_json(
        at(root, f"/srv/myapp/releases/{state['release_id']}/activation-manifest.json")
    )
    if request["production"] != active_manifest["environments"]["production"]:
        raise ControlError("automatic staging changed or dropped production")
    manifest_path = Path(request["manifest_path"]).resolve()
    inbox = at(root, "/srv/myapp/release-inbox").resolve()
    for field in ("manifest_path", "signature_path", "provenance_path", "provenance_signature_path"):
        candidate = Path(request[field]).resolve()
        if candidate.parent != inbox or candidate.is_symlink() or not candidate.is_file():
            raise ControlError(f"unsafe fixed inbox {field}")
    public_key = Path(policy["signing_public_key"]).resolve()
    if public_key.parent != at(root, "/etc/myapp/deployment-policies").resolve():
        raise ControlError("signing key is outside the root policy directory")
    verify_signature(public_key, Path(request["signature_path"]), manifest_path)
    verify_signature(public_key, Path(request["provenance_signature_path"]), Path(request["provenance_path"]))
    provenance = read_canonical_json(Path(request["provenance_path"]))
    expected_provenance = {
        "branch": request["branch"],
        "manifest_digest": digest_bytes(manifest_path.read_bytes()),
        "repository": request["repository"],
        "server_image": request["server_image"],
        "web_image": request["web_image"],
    }
    if provenance != expected_provenance:
        raise ControlError("signed provenance differs from the deployment request")
    manifest = read_canonical_json(manifest_path)
    validate_manifest(manifest)
    if manifest["deployment_sequence"] != request["deployment_sequence"]:
        raise ControlError("manifest sequence differs from the request")
    # The controller can derive only this exact root approval record; it cannot
    # alter the policy, authorize production, or invoke an arbitrary command.
    app_digests = sorted(
        environment["application_payload_digest"]
        for environment in manifest["environments"].values()
        if isinstance(environment, dict)
    )
    approval = {
        "activation_manifest_digest": digest_bytes(manifest_path.read_bytes()),
        "application_payload_digests": app_digests,
        "release_id": manifest["release_id"],
        "shared_payload_digest": manifest["shared_infrastructure_payload_digest"],
    }
    approval_path = at(root, f"/etc/myapp/approved-releases/{manifest['release_id']}.json")
    if approval_path.exists():
        raise ControlError("derived approval record already exists")
    atomic_write(approval_path, canonical(approval), 0o400)
    activation_approval_path = at(
        root, f"/etc/myapp/approved-releases/{manifest['release_id']}.activate.json"
    )
    activation_approval = {
        "activation_manifest_digest": digest_bytes(manifest_path.read_bytes()),
        "expected_predecessor": state["release_id"],
        "release_id": manifest["release_id"],
        "target": "staging",
    }
    atomic_write(activation_approval_path, canonical(activation_approval), 0o400)
    for field in ("signature_path", "provenance_path", "provenance_signature_path"):
        Path(request[field]).unlink()
    with locks(root, ("host-operation",), 30.0):
        install_release_transaction(root, manifest["release_id"], str(manifest_path))
    activation_args = argparse.Namespace(
        expected_predecessor=None,
        fail_after=None,
        kill_after=None,
        lock_timeout=30.0,
        release_id=manifest["release_id"],
        simulate=False,
        target="staging",
    )
    activate_release(activation_args, root)


def checkpoint(args: argparse.Namespace, root: Path) -> None:
    release_root = at(root, f"/srv/myapp/releases/{args.release_id}")
    manifest = read_canonical_json(release_root / "activation-manifest.json")
    local = at(root, "/var/lib/esmii/checkpoint-high-water.json")
    local_predecessor = read_canonical_json(local) if local.exists() else None
    remote_predecessor = None
    endpoint = at(root, "/etc/myapp/secrets/production/checkpoint-endpoint")
    curl_config = at(root, "/etc/myapp/secrets/production/checkpoint-curl.conf")
    if root != Path("/"):
        remote_epoch = at(root, f"/off-vps-checkpoint/{manifest['deployment_epoch']}")
        records = sorted(remote_epoch.glob("*.json")) if remote_epoch.exists() else []
        if records:
            remote_predecessor = read_canonical_json(records[-1])
    else:
        base_url = endpoint.read_text().strip().rstrip("/")
        query = urllib.parse.urlencode({"prefix": f"{manifest['deployment_epoch']}/"})
        listed = subprocess.run(
            ["/usr/bin/curl", "--config", str(curl_config), "--fail-with-body", f"{base_url}?{query}"],
            env={"HOME": "/var/empty", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
            capture_output=True,
            check=True,
        ).stdout
        listing = json.loads(listed)
        if not isinstance(listing, dict) or set(listing) != {"keys"} or not isinstance(listing["keys"], list):
            raise ControlError("off-VPS checkpoint listing is invalid")
        keys = sorted(listing["keys"])
        if keys:
            expected_prefix = f"{manifest['deployment_epoch']}/"
            if any(not isinstance(key, str) or not key.startswith(expected_prefix) for key in keys):
                raise ControlError("off-VPS checkpoint listing contains an unexpected key")
            remote_raw = subprocess.run(
                ["/usr/bin/curl", "--config", str(curl_config), "--fail-with-body", f"{base_url}/{keys[-1]}"],
                env={"HOME": "/var/empty", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
                capture_output=True,
                check=True,
            ).stdout
            remote_predecessor = json.loads(remote_raw)
            if not isinstance(remote_predecessor, dict) or canonical(remote_predecessor) != remote_raw:
                raise ControlError("off-VPS checkpoint high-water record is not canonical")
    if local_predecessor != remote_predecessor:
        raise ControlError("local checkpoint high-water differs from the newer off-VPS authority")
    previous_hash = digest_bytes(canonical(remote_predecessor)) if remote_predecessor else None
    expected_sequence = 1 if remote_predecessor is None else remote_predecessor["deployment_sequence"] + 1
    if manifest["deployment_sequence"] != expected_sequence:
        raise ControlError("checkpoint sequence does not extend off-VPS high water")
    record = {
        "activation_manifest_digest": digest_bytes(canonical(manifest)),
        "active_release_id": args.release_id,
        "change_targets": manifest["change_targets"],
        "deployment_epoch": manifest["deployment_epoch"],
        "deployment_id": args.deployment_id,
        "deployment_sequence": manifest["deployment_sequence"],
        "host_outcome_evidence_digest": args.host_evidence_digest,
        "previous_checkpoint_digest": previous_hash,
        "schema_version": 1,
        "staging_policy_digest": args.staging_policy_digest,
    }
    record_bytes = canonical(record)
    if not all(
        value is None or (isinstance(value, str) and DIGEST.fullmatch(value))
        for value in (
            record["host_outcome_evidence_digest"],
            record["previous_checkpoint_digest"],
            record["staging_policy_digest"],
        )
    ):
        raise ControlError("checkpoint digests are invalid")
    if root != Path("/"):
        remote = at(
            root,
            f"/off-vps-checkpoint/{record['deployment_epoch']}/{record['deployment_sequence']:020d}.json",
        )
        if remote.exists():
            raise ControlError("checkpoint replay key already exists")
        atomic_write(remote, record_bytes, 0o400)
        if remote.read_bytes() != record_bytes:
            raise ControlError("checkpoint readback differs")
    else:
        url = endpoint.read_text().strip().rstrip("/")
        key = f"{record['deployment_epoch']}/{record['deployment_sequence']:020d}.json"
        with tempfile.NamedTemporaryFile(prefix="esmii-checkpoint-", delete=False) as stream:
            stream.write(record_bytes)
            temporary = Path(stream.name)
        readback = temporary.with_suffix(".readback")
        try:
            subprocess.run(
                [
                    "/usr/bin/curl",
                    "--config",
                    str(curl_config),
                    "--fail-with-body",
                    "--header",
                    "If-None-Match: *",
                    "--upload-file",
                    str(temporary),
                    f"{url}/{key}",
                ],
                env={"HOME": "/var/empty", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
                check=True,
            )
            with readback.open("wb") as output:
                subprocess.run(
                    ["/usr/bin/curl", "--config", str(curl_config), "--fail-with-body", f"{url}/{key}"],
                    stdout=output,
                    env={"HOME": "/var/empty", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
                    check=True,
                )
            if readback.read_bytes() != record_bytes:
                raise ControlError("off-VPS checkpoint readback differs")
        finally:
            temporary.unlink(missing_ok=True)
            readback.unlink(missing_ok=True)
    atomic_write(local, record_bytes, 0o400)


def simple_mutation(root: Path, name: str, lock_timeout: float, hold: float = 0) -> None:
    with locks(root, ("host-operation",), lock_timeout):
        if hold:
            time.sleep(hold)
        if root == Path("/") and name == "prune":
            environment = {
                "DOCKER_HOST": "unix:///var/run/docker.sock",
                "HOME": "/var/empty",
                "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            }
            subprocess.run(
                ["/usr/bin/docker", "builder", "prune", "--force", "--filter", "until=168h"],
                env=environment,
                check=True,
            )
            subprocess.run(["/usr/bin/docker", "image", "prune", "--force"], env=environment, check=True)
            subprocess.run(
                ["/usr/bin/journalctl", "--vacuum-size=1G"],
                env={"HOME": "/var/empty", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
                check=True,
            )
        marker = at(root, f"/var/lib/esmii/{name}.last.json")
        atomic_write(marker, canonical({"operation": name, "run_unix": int(time.time())}), 0o400)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Esmii fixed host controller")
    result.add_argument("--test-root")
    subparsers = result.add_subparsers(dest="command", required=True)

    install = subparsers.add_parser("install-release")
    install.add_argument("release_id")
    install.add_argument("manifest_path")

    activate = subparsers.add_parser("activate-release")
    activate.add_argument("release_id")
    activate.add_argument("--target", choices=("staging", "production", "production-mail", "public-edge", "rollback"), required=True)
    activate.add_argument("--lock-timeout", type=float, default=30)
    activate.add_argument("--simulate", action="store_true")
    activate.add_argument("--expected-predecessor")
    activate.add_argument("--epoch", default="test-epoch")
    activate.add_argument("--sequence", type=int, default=1)
    activate.add_argument("--operation-id", default="test-operation")
    activate.add_argument("--fail-after", choices=ACTIVATION_PHASES)
    activate.add_argument("--kill-after", choices=ACTIVATION_PHASES)

    compose = subparsers.add_parser("host-compose")
    compose.add_argument("release_id")
    compose.add_argument("subcommand", choices=("verify", "config", "ps"))
    compose.add_argument("--execute", action="store_true")

    lock = subparsers.add_parser("lock-probe")
    lock.add_argument("--kind", choices=("host", "both", "reverse"), default="host")
    lock.add_argument("--timeout", type=float, default=1)
    lock.add_argument("--hold", type=float, default=0)

    backup_parser = subparsers.add_parser("backup")
    backup_parser.add_argument("--kind", choices=("database", "state"), required=True)
    backup_parser.add_argument("--lock-timeout", type=float, default=30)
    backup_parser.add_argument("--dry-run", action="store_true")

    restore = subparsers.add_parser("restore-check")
    restore.add_argument("--required-bytes", type=int)
    restore.add_argument("--lock-timeout", type=float, default=30)

    checkpoint_parser = subparsers.add_parser("checkpoint")
    checkpoint_parser.add_argument("release_id")
    checkpoint_parser.add_argument("--deployment-id", required=True)
    checkpoint_parser.add_argument("--host-evidence-digest", required=True)
    checkpoint_parser.add_argument("--staging-policy-digest", required=True)

    policy_parser = subparsers.add_parser("policy-controller")
    policy_parser.add_argument("action", choices=("reconcile",))
    policy_parser.add_argument("request_path")

    publisher = subparsers.add_parser("verify-public-tree")
    publisher.add_argument("environment", choices=("staging", "production"))

    for command in ("reconcile", "health", "prune", "maintenance", "rollback", "alert"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("argument", nargs="?")
        command_parser.add_argument("--lock-timeout", type=float, default=30)
    return result


def normalize_symlink_command(arguments: list[str]) -> list[str]:
    invoked = Path(arguments[0]).name
    aliases = {
        "esmii-activate-release": "activate-release",
        "esmii-host-compose": "host-compose",
        "esmii-install-release": "install-release",
        "esmii-rollback": "activate-release",
        "esmii-staging-policy-controller": "policy-controller",
    }
    if invoked in aliases:
        return [arguments[0], aliases[invoked], *arguments[1:]]
    return arguments


def main() -> int:
    arguments = normalize_symlink_command(sys.argv)
    args = parser().parse_args(arguments[1:])
    root = root_path(args.test_root)
    if args.command == "install-release":
        with locks(root, ("host-operation",), 30.0):
            install_release_transaction(root, args.release_id, args.manifest_path)
    elif args.command == "activate-release":
        activate_release(args, root)
    elif args.command == "host-compose":
        command = {"verify": ["config", "--quiet"], "config": ["config", "--quiet"], "ps": ["ps"]}[args.subcommand]
        print(json.dumps(compose_command(root, args.release_id, command, args.execute)))
    elif args.command == "lock-probe":
        names = {"host": ("host-operation",), "both": ("host-operation", "backup"), "reverse": ("backup", "host-operation")}[args.kind]
        with locks(root, names, args.timeout):
            time.sleep(args.hold)
    elif args.command == "backup":
        backup(args, root)
    elif args.command == "restore-check":
        restore_check(args, root)
    elif args.command == "checkpoint":
        checkpoint(args, root)
    elif args.command == "policy-controller":
        policy_controller(args, root)
    elif args.command == "verify-public-tree":
        verify_public_tree(root, args.environment)
    elif args.command == "reconcile":
        reconcile(root)
    elif args.command == "health":
        verify_public_tree(root, "staging")
        if at(root, "/srv/myapp/production/media/public/variants").exists():
            verify_public_tree(root, "production")
    elif args.command in {"prune", "maintenance", "rollback"}:
        simple_mutation(root, args.command, args.lock_timeout)
    elif args.command == "alert":
        print(json.dumps({"alert": args.argument or "unknown", "destination": "fixed-external-monitor"}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ControlError as error:
        print(f"rejected: {error}", file=sys.stderr)
        raise SystemExit(78) from error
