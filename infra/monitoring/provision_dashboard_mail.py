#!/usr/bin/env python3
"""Provision one environment-isolated SMTP identity for dashboard email OTP."""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import stat
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Sequence


ADMIN_ORIGIN = "http://172.30.30.2:8080"
ADVERTISED_ORIGIN = "https://mail.esmii.app"
ADMIN_USERNAME = Path("/etc/myapp/secrets/production/stalwart-admin-username")
ADMIN_PASSWORD = Path("/etc/myapp/secrets/production/stalwart-admin-password")
MAIL_HOSTNAME = "mail.esmii.app"


def read_root_secret(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"required root secret is absent or unsafe: {path.name}")
    value = path.stat()
    if value.st_uid != 0 or value.st_gid != 0 or stat.S_IMODE(value.st_mode) != 0o600:
        raise ValueError(f"required root secret has unsafe metadata: {path.name}")
    content = path.read_text(encoding="utf-8").strip()
    if not content or any(ord(character) < 32 or ord(character) == 127 for character in content):
        raise ValueError(f"required root secret has invalid content: {path.name}")
    return content


class StalwartAdmin:
    def __init__(self, username: str, password: str):
        raw = f"{username}:{password}".encode("utf-8")
        self.authorization = "Basic " + base64.b64encode(raw).decode("ascii")
        session = self.request("GET", "/jmap/session")
        api_url = session.get("apiUrl")
        if not isinstance(api_url, str):
            raise ValueError("Stalwart session omitted its API URL")
        parsed = urllib.parse.urlsplit(api_url)
        if (
            f"{parsed.scheme}://{parsed.netloc}" != ADVERTISED_ORIGIN
            or not parsed.path.startswith("/jmap")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Stalwart returned an unsafe API URL")
        self.api_path = parsed.path

    def request(self, method: str, path: str, body: object | None = None) -> dict[str, object]:
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(
            ADMIN_ORIGIN + path,
            data=payload,
            headers={
                "Authorization": self.authorization,
                **({"Content-Type": "application/json"} if payload is not None else {}),
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Stalwart administration failed with HTTP {error.code}") from error
        if not isinstance(result, dict):
            raise ValueError("Stalwart returned an invalid response")
        return result

    def jmap(self, method: str, arguments: object) -> dict[str, object]:
        result = self.request(
            "POST",
            self.api_path,
            {
                "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
                "methodCalls": [[method, arguments, "dashboard-mail"]],
            },
        )
        responses = result.get("methodResponses")
        if not isinstance(responses, list) or len(responses) != 1:
            raise ValueError("Stalwart returned an unexpected JMAP response")
        response = responses[0]
        if not isinstance(response, list) or len(response) < 2 or response[0] != method:
            raise ValueError("Stalwart rejected the dashboard mail operation")
        value = response[1]
        if not isinstance(value, dict):
            raise ValueError("Stalwart returned an invalid dashboard mail result")
        return value


def query_account(admin: StalwartAdmin, name: str) -> list[str]:
    result = admin.jmap("x:Account/query", {"filter": {"name": name}})
    identifiers = result.get("ids")
    if not isinstance(identifiers, list) or not all(
        isinstance(identifier, str) and identifier for identifier in identifiers
    ):
        raise ValueError("Stalwart returned an invalid account query")
    return identifiers


def validate_account(admin: StalwartAdmin, identifier: str, expected_name: str) -> None:
    result = admin.jmap(
        "x:Account/get",
        {
            "ids": [identifier],
            "properties": ["@type", "id", "name", "domainId"],
        },
    )
    rows = result.get("list")
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise ValueError("Stalwart returned an invalid dashboard mail identity")
    account = rows[0]
    if (
        account.get("id") != identifier
        or account.get("@type") != "User"
        or account.get("name") != expected_name
        or account.get("domainId") != "b"
    ):
        raise ValueError("existing dashboard mail identity violates the environment contract")


def parse_existing_smtp_url(value: str, expected_email: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "smtp"
        or parsed.hostname != MAIL_HOSTNAME
        or parsed.port != 587
        or urllib.parse.unquote(parsed.username or "") != expected_email
        or not parsed.password
        or parsed.path not in ("", "/")
        or parsed.fragment
        or urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        != [("requireTLS", "true")]
    ):
        raise ValueError("existing dashboard SMTP secret has an unexpected shape")
    password = urllib.parse.unquote(parsed.password)
    if len(password) < 32 or any(ord(character) < 33 or ord(character) > 126 for character in password):
        raise ValueError("existing dashboard SMTP password is invalid")
    return password


def atomic_secret(path: Path, value: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def provision(environment: str) -> None:
    if os.geteuid() != 0:
        raise PermissionError("dashboard mail provisioning must run as root")
    account_name = "monitoring-staging" if environment == "staging" else "monitoring"
    email = f"{account_name}@esmii.app"
    secret_root = Path(f"/etc/esmii/monitoring/{environment}")
    if secret_root.is_symlink() or not secret_root.is_dir():
        raise ValueError("environment monitoring secret root is absent or unsafe")
    root_stat = secret_root.stat()
    if root_stat.st_uid != 0 or root_stat.st_gid != 0 or stat.S_IMODE(root_stat.st_mode) != 0o700:
        raise ValueError("environment monitoring secret root has unsafe metadata")
    smtp_path = secret_root / "dashboard-smtp-url"
    admin = StalwartAdmin(read_root_secret(ADMIN_USERNAME), read_root_secret(ADMIN_PASSWORD))
    identifiers = query_account(admin, account_name)
    if len(identifiers) > 1:
        raise ValueError("Stalwart contains ambiguous dashboard mail identities")
    if identifiers:
        validate_account(admin, identifiers[0], account_name)
        if not smtp_path.exists():
            raise ValueError(
                "dashboard mail identity already exists without its managed SMTP secret"
            )
    if smtp_path.exists():
        password = parse_existing_smtp_url(read_root_secret(smtp_path), email)
    else:
        password = secrets.token_urlsafe(32)
        smtp_url = (
            "smtp://"
            + urllib.parse.quote(email, safe="")
            + ":"
            + urllib.parse.quote(password, safe="")
            + f"@{MAIL_HOSTNAME}:587?requireTLS=true"
        )
        atomic_secret(smtp_path, smtp_url)
    credential = {"0": {"@type": "Password", "secret": password}}
    if identifiers:
        result = admin.jmap(
            "x:Account/set", {"update": {identifiers[0]: {"credentials": credential}}}
        )
        updated = result.get("updated")
        if not isinstance(updated, dict) or identifiers[0] not in updated:
            raise ValueError("Stalwart did not update the dashboard mail identity")
    else:
        result = admin.jmap(
            "x:Account/set",
            {
                "create": {
                    "dashboard-mail": {
                        "@type": "User",
                        "name": account_name,
                        "domainId": "b",
                        "credentials": credential,
                        "memberGroupIds": {},
                        "roles": {"@type": "User"},
                        "permissions": {"@type": "Inherit"},
                        "quotas": {"maxDiskQuota": 67_108_864},
                        "aliases": {},
                        "encryptionAtRest": {"@type": "Disabled"},
                    }
                }
            },
        )
        created = result.get("created")
        if not isinstance(created, dict) or "dashboard-mail" not in created:
            raise ValueError("Stalwart did not create the dashboard mail identity")

    verified = query_account(admin, account_name)
    if len(verified) != 1:
        raise ValueError("dashboard mail identity verification failed")
    validate_account(admin, verified[0], account_name)
    print(f"Provisioned the isolated {environment} dashboard email-OTP sender.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("environment", choices=("staging", "production"))
    return result


def main(arguments: Sequence[str] | None = None) -> int:
    options = parser().parse_args(arguments)
    provision(options.environment)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=os.sys.stderr)
        raise SystemExit(1) from None
