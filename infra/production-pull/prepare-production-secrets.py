#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import pathlib
import secrets
import subprocess
import sys
import urllib.parse


def private_write_if_missing(path: pathlib.Path, value: str) -> None:
    if path.exists():
        information = path.lstat()
        if path.is_symlink() or not path.is_file() or information.st_uid != 0:
            raise ValueError(f"refusing unsafe existing secret path: {path}")
        path.chmod(0o600)
        if not path.read_text(encoding="utf-8").strip():
            raise ValueError(f"refusing empty existing secret: {path}")
        return

    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())


def random_value() -> str:
    return secrets.token_urlsafe(32)


def main() -> int:
    if os.geteuid() != 0:
        raise ValueError("this installer must run as root")

    root = pathlib.Path("/etc/myapp/secrets/production")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or root.lstat().st_uid != 0:
        raise ValueError("refusing unsafe production secret directory")
    root.chmod(0o700)

    generated = {
        "postgres-bootstrap-password": random_value(),
        "postgres-migration-password": random_value(),
        "postgres-api-password": random_value(),
        "postgres-worker-password": random_value(),
        "valkey-api-password": random_value(),
        "valkey-worker-password": random_value(),
        "valkey-health-password": random_value(),
        "operations-health-token": random_value(),
        "better-auth-secret": random_value(),
        "stalwart-webhook-secret": random_value(),
        "stalwart-dns-api-token": random_value(),
    }
    for filename, value in generated.items():
        private_write_if_missing(root / filename, f"{value}\n")

    def read(filename: str) -> str:
        return (root / filename).read_text(encoding="utf-8").strip()

    values = {
        "database-migration-url": f"postgresql://app_owner:{urllib.parse.quote(read('postgres-migration-password'), safe='')}@production-postgres:5432/esmii\n",
        "database-api-url": f"postgresql://app_api:{urllib.parse.quote(read('postgres-api-password'), safe='')}@production-postgres:5432/esmii\n",
        "database-worker-url": f"postgresql://app_worker:{urllib.parse.quote(read('postgres-worker-password'), safe='')}@production-postgres:5432/esmii\n",
        "valkey-api-url": f"redis://esmii_api:{urllib.parse.quote(read('valkey-api-password'), safe='')}@production-valkey:6379/0\n",
        "valkey-worker-url": f"redis://esmii_worker:{urllib.parse.quote(read('valkey-worker-password'), safe='')}@production-valkey:6379/0\n",
        "security-tombstone-journal": "capture://initial-public-demo\n",
        "stalwart-smtp-url": "smtp://mail.esmii.app:587\n",
    }
    for filename, value in values.items():
        private_write_if_missing(root / filename, value)

    acl = "\n".join(
        [
            "user default off",
            f"user health on >{read('valkey-health-password')} ~* +ping",
            f"user esmii_api on >{read('valkey-api-password')} ~esmii:api:* +@read +@write +ping -@dangerous +eval",
            f"user esmii_worker on >{read('valkey-worker-password')} ~esmii:* +@read +@write +ping -@dangerous",
            "",
        ]
    )
    private_write_if_missing(root / "valkey-users.acl", acl)

    keyring = {
        "environment": "production",
        "keys": [
            {"key": random_value(), "purpose": "magic-link", "status": "active", "version": 1},
            {"key": random_value(), "purpose": "invitation", "status": "active", "version": 1},
        ],
        "schemaVersion": 1,
    }
    private_write_if_missing(
        root / "action-link-derivation-keyring",
        f"{json.dumps(keyring, separators=(',', ':'))}\n",
    )

    for path in root.iterdir():
        if path.is_file() and not path.is_symlink():
            path.chmod(0o600)
    subprocess.run(
        ["/usr/local/libexec/esmii/prepare-production-runtime-secrets.py"],
        check=True,
    )
    print("Prepared the root-only production secret set without printing credential values.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"production secret preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
