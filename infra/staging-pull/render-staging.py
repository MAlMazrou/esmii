#!/usr/bin/env python3

from __future__ import annotations

import argparse
import pathlib
import re
import sys


IMMUTABLE_REFERENCE = re.compile(
    r"^(?:ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+@sha256:[0-9a-f]{64}|esmii/(?:web|server):sha-[0-9a-f]{40})$"
)


def render(source: pathlib.Path, destination: pathlib.Path, replacements: dict[str, str]) -> None:
    contents = source.read_text(encoding="utf-8")
    for token, value in replacements.items():
        contents = contents.replace(token, value)
    unresolved = sorted(set(re.findall(r"@@[A-Z0-9_]+@@", contents)))
    if unresolved:
        raise ValueError(f"unresolved template tokens in {source.name}: {', '.join(unresolved)}")
    temporary = destination.with_suffix(f"{destination.suffix}.tmp")
    temporary.write_text(contents, encoding="utf-8")
    temporary.chmod(0o644)
    temporary.replace(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render the fixed Esmii staging runtime files.")
    parser.add_argument("--source-root", required=True, type=pathlib.Path)
    parser.add_argument("--runtime-root", required=True, type=pathlib.Path)
    parser.add_argument("--web-image", required=True)
    parser.add_argument("--server-image", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--edge-subnet", required=True)
    parser.add_argument("--caddy-ip", required=True)
    parser.add_argument("--admin-health-cidrs", required=True)
    arguments = parser.parse_args()

    for image in (arguments.web_image, arguments.server_image):
        if IMMUTABLE_REFERENCE.fullmatch(image) is None:
            raise ValueError("application images must use immutable GHCR digests or full-SHA host tags")

    replacements = {
        "@@STAGING_WEB_IMAGE@@": arguments.web_image,
        "@@STAGING_SERVER_IMAGE@@": arguments.server_image,
        "@@STAGING_APP_DOMAIN@@": arguments.domain,
        "@@STAGING_EDGE_SUBNET@@": arguments.edge_subnet,
        "@@STAGING_CADDY_IP@@": arguments.caddy_ip,
        "@@STAGING_ADMIN_HEALTH_CIDRS@@": arguments.admin_health_cidrs,
    }
    render(
        arguments.source_root / "compose.staging.yaml",
        arguments.runtime_root / "compose.staging.yaml",
        replacements,
    )
    render(
        arguments.source_root / "caddy" / "sites" / "staging.caddy",
        arguments.runtime_root / "caddy" / "sites-enabled" / "staging.caddy",
        replacements,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"staging render failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
