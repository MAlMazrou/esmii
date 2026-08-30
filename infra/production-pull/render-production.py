#!/usr/bin/env python3

from __future__ import annotations

import argparse
import pathlib
import re
import shutil
import sys


IMMUTABLE_REFERENCE = re.compile(
    r"^(?:ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+@sha256:[0-9a-f]{64}|esmii/(?:web|server):sha-[0-9a-f]{40})$"
)


def render(source: pathlib.Path, destination: pathlib.Path, replacements: dict[str, str]) -> None:
    contents = source.read_text(encoding="utf-8")
    for token, value in replacements.items():
        contents = contents.replace(token, value)
    contents = contents.replace(
        "/etc/myapp/secrets/production/",
        "/etc/myapp/runtime-secrets/production/",
    )
    if source.name == "compose.production.yaml":
        contents = re.sub(
            r"^\s+SMTP_URL_FILE:.*\n",
            "",
            contents,
            flags=re.MULTILINE,
        )
        contents = re.sub(
            r"^\s+AUTH_GOOGLE_CLIENT_(?:ID|SECRET)_FILE:.*\n",
            "",
            contents,
            flags=re.MULTILINE,
        )
        contents = re.sub(
            r"^\s+- production_auth_google_client_(?:id|secret)\n",
            "",
            contents,
            flags=re.MULTILINE,
        )
        contents = re.sub(
            r"^  production_auth_google_client_(?:id|secret):\n    file:.*\n",
            "",
            contents,
            flags=re.MULTILINE,
        )
    unresolved = sorted(set(re.findall(r"@@[A-Z0-9_]+@@", contents)))
    if unresolved:
        raise ValueError(f"unresolved template tokens in {source.name}: {', '.join(unresolved)}")
    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = destination.with_suffix(f"{destination.suffix}.tmp")
    temporary.write_text(contents, encoding="utf-8")
    temporary.chmod(0o644)
    temporary.replace(destination)


def copy(source: pathlib.Path, destination: pathlib.Path, mode: int = 0o644) -> None:
    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = destination.with_suffix(f"{destination.suffix}.tmp")
    shutil.copyfile(source, temporary)
    temporary.chmod(mode)
    temporary.replace(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render the fixed Esmii production runtime files.")
    parser.add_argument("--source-root", required=True, type=pathlib.Path)
    parser.add_argument("--runtime-root", required=True, type=pathlib.Path)
    parser.add_argument("--web-image", required=True)
    parser.add_argument("--server-image", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--edge-subnet", required=True)
    parser.add_argument("--caddy-ip", required=True)
    parser.add_argument("--admin-health-cidrs", required=True)
    parser.add_argument("--mail-domain", required=True)
    parser.add_argument("--mail-hostname", required=True)
    parser.add_argument("--bounce-domain", required=True)
    parser.add_argument("--mail-admin-subnet", required=True)
    parser.add_argument("--stalwart-mail-admin-ip", required=True)
    arguments = parser.parse_args()

    for image in (arguments.web_image, arguments.server_image):
        if IMMUTABLE_REFERENCE.fullmatch(image) is None:
            raise ValueError("application images must use immutable GHCR digests or full-SHA host tags")

    replacements = {
        "@@PRODUCTION_WEB_IMAGE@@": arguments.web_image,
        "@@PRODUCTION_SERVER_IMAGE@@": arguments.server_image,
        "@@PRODUCTION_APP_DOMAIN@@": arguments.domain,
        "@@PRODUCTION_EDGE_SUBNET@@": arguments.edge_subnet,
        "@@PRODUCTION_CADDY_IP@@": arguments.caddy_ip,
        "@@PRODUCTION_ADMIN_HEALTH_CIDRS@@": arguments.admin_health_cidrs,
        "@@PRODUCTION_PRELAUNCH_TEST_CIDRS@@": arguments.admin_health_cidrs,
        "@@PRODUCTION_MAIL_ADMIN_SUBNET@@": arguments.mail_admin_subnet,
        "@@STALWART_MAIL_ADMIN_IP@@": arguments.stalwart_mail_admin_ip,
        "@@MAIL_DOMAIN@@": arguments.mail_domain,
        "@@MAIL_HOSTNAME@@": arguments.mail_hostname,
        "@@BOUNCE_DOMAIN@@": arguments.bounce_domain,
        "@@PRODUCTION_MAIL_PORTS_BLOCK@@": "# External SMTP remains disabled during the initial public application launch.",
    }
    render(
        arguments.source_root / "compose.production.yaml",
        arguments.runtime_root / "compose.production.yaml",
        replacements,
    )
    render(
        arguments.source_root / "caddy" / "sites" / "production-public.caddy",
        arguments.runtime_root / "caddy" / "sites-enabled" / "production.caddy",
        replacements,
    )
    render(
        arguments.source_root / "stalwart" / "config.toml",
        arguments.runtime_root / "stalwart" / "config.toml",
        replacements,
    )
    copy(
        arguments.source_root / "production-pull" / "compose.production.capture.yaml",
        arguments.runtime_root / "compose.production.capture.yaml",
    )
    copy(
        arguments.source_root / "postgres" / "production.conf",
        arguments.runtime_root / "postgres" / "production.conf",
    )
    copy(
        arguments.source_root / "postgres" / "init-host.sh",
        arguments.runtime_root / "postgres" / "init-host.sh",
        0o755,
    )
    copy(
        arguments.source_root / "valkey" / "production.conf",
        arguments.runtime_root / "valkey" / "production.conf",
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"production render failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
