#!/usr/bin/env python3

from __future__ import annotations

import os
import pathlib
import secrets
import sys


CANONICAL_ROOT = pathlib.Path("/etc/myapp/secrets/production")
RUNTIME_ROOT = pathlib.Path("/etc/myapp/runtime-secrets/production")
RUNTIME_SECRET_FILES = (
    "postgres-bootstrap-password",
    "postgres-migration-password",
    "postgres-api-password",
    "postgres-worker-password",
    "database-migration-url",
    "database-api-url",
    "database-worker-url",
    "valkey-users.acl",
    "valkey-health-password",
    "valkey-api-url",
    "valkey-worker-url",
    "operations-health-token",
    "better-auth-secret",
    "action-link-derivation-keyring",
    "security-tombstone-journal",
    "stalwart-smtp-url",
    "stalwart-webhook-secret",
    "stalwart-dns-api-token",
)


def ensure_root_directory(path: pathlib.Path, *, create: bool) -> None:
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    information = path.lstat()
    if path.is_symlink() or not path.is_dir() or information.st_uid != 0:
        raise ValueError(f"refusing unsafe production secret directory: {path}")
    path.chmod(0o700)


def copy_runtime_secret(filename: str) -> None:
    source = CANONICAL_ROOT / filename
    information = source.lstat()
    if source.is_symlink() or not source.is_file() or information.st_uid != 0:
        raise ValueError(f"refusing unsafe canonical production secret: {source}")
    source.chmod(0o600)
    contents = source.read_bytes()
    if not contents.strip():
        raise ValueError(f"refusing empty canonical production secret: {source}")

    destination = RUNTIME_ROOT / filename
    if destination.exists() or destination.is_symlink():
        destination_information = destination.lstat()
        if destination.is_symlink() or not destination.is_file() or destination_information.st_uid != 0:
            raise ValueError(f"refusing unsafe runtime production secret: {destination}")

    temporary = RUNTIME_ROOT / f".{filename}.{os.getpid()}.{secrets.token_hex(6)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o400)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o444)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    if os.geteuid() != 0:
        raise ValueError("this preparer must run as root")
    ensure_root_directory(CANONICAL_ROOT, create=False)
    ensure_root_directory(RUNTIME_ROOT, create=True)
    for filename in RUNTIME_SECRET_FILES:
        copy_runtime_secret(filename)
    print("Prepared container-readable production secret mounts without printing credential values.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, OSError, ValueError) as error:
        print(f"production runtime secret preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
