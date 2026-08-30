#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import pathlib
import secrets
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

    parser = argparse.ArgumentParser(description="Create the root-only Esmii staging secret set.")
    parser.add_argument("--oauth-json", required=True, type=pathlib.Path)
    parser.add_argument("--tester-email", action="append", required=True)
    arguments = parser.parse_args()

    credential = json.loads(arguments.oauth_json.read_text(encoding="utf-8"))
    oauth = credential.get("web") or credential.get("installed")
    if not isinstance(oauth, dict):
        raise ValueError("OAuth credential does not contain a web client")
    client_id = oauth.get("client_id")
    client_secret = oauth.get("client_secret")
    if not isinstance(client_id, str) or not client_id or not isinstance(client_secret, str) or not client_secret:
        raise ValueError("OAuth credential is missing its client values")

    root = pathlib.Path("/etc/myapp/secrets/staging")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or root.lstat().st_uid != 0:
        raise ValueError("refusing unsafe staging secret directory")
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
    }
    for filename, value in generated.items():
        private_write_if_missing(root / filename, f"{value}\n")

    def read(filename: str) -> str:
        return (root / filename).read_text(encoding="utf-8").strip()

    database_urls = {
        "database-migration-url": f"postgresql://app_owner:{urllib.parse.quote(read('postgres-migration-password'), safe='')}@staging-postgres:5432/esmii\n",
        "database-api-url": f"postgresql://app_api:{urllib.parse.quote(read('postgres-api-password'), safe='')}@staging-postgres:5432/esmii\n",
        "database-worker-url": f"postgresql://app_worker:{urllib.parse.quote(read('postgres-worker-password'), safe='')}@staging-postgres:5432/esmii\n",
        "valkey-api-url": f"redis://esmii_api:{urllib.parse.quote(read('valkey-api-password'), safe='')}@staging-valkey:6379/0\n",
        "valkey-worker-url": f"redis://esmii_worker:{urllib.parse.quote(read('valkey-worker-password'), safe='')}@staging-valkey:6379/0\n",
    }
    for filename, value in database_urls.items():
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
        "environment": "staging",
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
    testers = sorted({email.strip().casefold() for email in arguments.tester_email if email.strip()})
    if not testers or any("@" not in email or " " in email for email in testers):
        raise ValueError("at least one valid staging tester email is required")
    private_write_if_missing(root / "tester-allowlist", f"{','.join(testers)}\n")
    private_write_if_missing(root / "auth-google-client-id", f"{client_id}\n")
    private_write_if_missing(root / "auth-google-client-secret", f"{client_secret}\n")

    for path in root.iterdir():
        if path.is_file() and not path.is_symlink():
            path.chmod(0o600)
    print("Prepared the root-only staging secret set without printing credential values.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"staging secret preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
