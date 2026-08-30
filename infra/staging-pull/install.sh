#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

if [[ ${EUID} -ne 0 ]]; then
  echo "Run the staging pull installer as root." >&2
  exit 1
fi

readonly REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
readonly SHARE_ROOT=/usr/local/share/esmii/staging-pull
readonly RUNTIME_ROOT=/srv/myapp/staging-runtime

install -d -m 0755 /usr/local/libexec/esmii "${SHARE_ROOT}" "${SHARE_ROOT}/caddy/sites" "${SHARE_ROOT}/postgres" "${SHARE_ROOT}/valkey"
install -d -m 0755 "${RUNTIME_ROOT}" "${RUNTIME_ROOT}/caddy/sites-enabled" "${RUNTIME_ROOT}/postgres" "${RUNTIME_ROOT}/valkey"
install -d -m 0700 /var/lib/esmii/staging-pull /etc/myapp /etc/myapp/secrets/staging /etc/myapp/runtime-secrets/staging

install -m 0755 "${REPOSITORY_ROOT}/infra/staging-pull/esmii-staging-pull" /usr/local/libexec/esmii/esmii-staging-pull
install -m 0755 "${REPOSITORY_ROOT}/infra/staging-pull/render-staging.py" /usr/local/libexec/esmii/render-staging.py
install -m 0755 "${REPOSITORY_ROOT}/infra/staging-pull/prepare-staging-secrets.py" /usr/local/libexec/esmii/prepare-staging-secrets.py
install -m 0755 "${REPOSITORY_ROOT}/infra/staging-pull/prepare-runtime-secrets.py" /usr/local/libexec/esmii/prepare-runtime-secrets.py
install -m 0644 "${REPOSITORY_ROOT}/infra/compose.yaml" "${SHARE_ROOT}/compose.yaml"
install -m 0644 "${REPOSITORY_ROOT}/infra/compose.staging.yaml" "${SHARE_ROOT}/compose.staging.yaml"
install -m 0644 "${REPOSITORY_ROOT}/infra/caddy/Caddyfile" "${SHARE_ROOT}/caddy/Caddyfile"
install -m 0644 "${REPOSITORY_ROOT}/infra/caddy/sites/staging.caddy" "${SHARE_ROOT}/caddy/sites/staging.caddy"
install -m 0644 "${REPOSITORY_ROOT}/infra/postgres/staging.conf" "${SHARE_ROOT}/postgres/staging.conf"
install -m 0755 "${REPOSITORY_ROOT}/infra/postgres/init-host.sh" "${SHARE_ROOT}/postgres/init-host.sh"
install -m 0644 "${REPOSITORY_ROOT}/infra/valkey/staging.conf" "${SHARE_ROOT}/valkey/staging.conf"

install -m 0644 "${SHARE_ROOT}/compose.yaml" "${RUNTIME_ROOT}/compose.yaml"
install -m 0644 "${SHARE_ROOT}/caddy/Caddyfile" "${RUNTIME_ROOT}/caddy/Caddyfile"
install -m 0644 "${SHARE_ROOT}/postgres/staging.conf" "${RUNTIME_ROOT}/postgres/staging.conf"
install -m 0755 "${SHARE_ROOT}/postgres/init-host.sh" "${RUNTIME_ROOT}/postgres/init-host.sh"
install -m 0644 "${SHARE_ROOT}/valkey/staging.conf" "${RUNTIME_ROOT}/valkey/staging.conf"

if [[ ! -e /etc/myapp/staging-pull.conf ]]; then
  install -m 0600 "${REPOSITORY_ROOT}/infra/staging-pull/staging-pull.conf" /etc/myapp/staging-pull.conf
fi

install -m 0644 "${REPOSITORY_ROOT}/infra/staging-pull/esmii-staging-pull.service" /etc/systemd/system/esmii-staging-pull.service
install -m 0644 "${REPOSITORY_ROOT}/infra/staging-pull/esmii-staging-pull.timer" /etc/systemd/system/esmii-staging-pull.timer
systemctl daemon-reload
echo "Installed the staging pull service; it remains disabled until explicitly enabled."
