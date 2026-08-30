#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

if [[ ${EUID} -ne 0 ]]; then
  echo "Run the production pull installer as root." >&2
  exit 1
fi

readonly REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
readonly SHARE_ROOT=/usr/local/share/esmii/production-pull
readonly RUNTIME_ROOT=/srv/myapp/staging-runtime

install -d -m 0755 /usr/local/libexec/esmii "${SHARE_ROOT}" "${SHARE_ROOT}/caddy/sites" "${SHARE_ROOT}/postgres" "${SHARE_ROOT}/valkey" "${SHARE_ROOT}/stalwart" "${SHARE_ROOT}/production-pull"
install -d -m 0755 "${RUNTIME_ROOT}" "${RUNTIME_ROOT}/caddy/sites-enabled" "${RUNTIME_ROOT}/postgres" "${RUNTIME_ROOT}/valkey" "${RUNTIME_ROOT}/stalwart"
install -d -m 0700 /var/lib/esmii/production-pull /etc/myapp/secrets/production /etc/myapp/runtime-secrets/production
install -d -m 0755 /srv/myapp/production/media/public/variants
install -d -m 0700 /srv/myapp/production/media/private/incoming /srv/myapp/production/media/private/originals /srv/myapp/production/media/private/variants /srv/myapp/production/media/private/trash
chown 10001:10001 /srv/myapp/production/media/private/incoming /srv/myapp/production/media/private/originals /srv/myapp/production/media/private/variants /srv/myapp/production/media/private/trash
install -d -m 0700 /srv/myapp/production/stalwart/config /srv/myapp/production/stalwart/data
chown 2000:2000 /srv/myapp/production/stalwart/config /srv/myapp/production/stalwart/data

install -m 0755 "${REPOSITORY_ROOT}/infra/production-pull/esmii-production-pull" /usr/local/libexec/esmii/esmii-production-pull
install -m 0755 "${REPOSITORY_ROOT}/infra/production-pull/render-production.py" /usr/local/libexec/esmii/render-production.py
install -m 0755 "${REPOSITORY_ROOT}/infra/production-pull/prepare-production-secrets.py" /usr/local/libexec/esmii/prepare-production-secrets.py
install -m 0755 "${REPOSITORY_ROOT}/infra/production-pull/prepare-production-runtime-secrets.py" /usr/local/libexec/esmii/prepare-production-runtime-secrets.py
install -m 0644 "${REPOSITORY_ROOT}/infra/compose.production.yaml" "${SHARE_ROOT}/compose.production.yaml"
install -m 0644 "${REPOSITORY_ROOT}/infra/production-pull/compose.production.capture.yaml" "${SHARE_ROOT}/production-pull/compose.production.capture.yaml"
install -m 0644 "${REPOSITORY_ROOT}/infra/caddy/sites/production-public.caddy" "${SHARE_ROOT}/caddy/sites/production-public.caddy"
install -m 0644 "${REPOSITORY_ROOT}/infra/postgres/production.conf" "${SHARE_ROOT}/postgres/production.conf"
install -m 0755 "${REPOSITORY_ROOT}/infra/postgres/init-host.sh" "${SHARE_ROOT}/postgres/init-host.sh"
install -m 0644 "${REPOSITORY_ROOT}/infra/valkey/production.conf" "${SHARE_ROOT}/valkey/production.conf"
install -m 0644 "${REPOSITORY_ROOT}/infra/stalwart/config.toml" "${SHARE_ROOT}/stalwart/config.toml"

if [[ ! -e /etc/myapp/production-pull.conf ]]; then
  install -m 0600 "${REPOSITORY_ROOT}/infra/production-pull/production-pull.conf" /etc/myapp/production-pull.conf
fi

install -m 0644 "${REPOSITORY_ROOT}/infra/production-pull/esmii-production-pull.service" /etc/systemd/system/esmii-production-pull.service
install -m 0644 "${REPOSITORY_ROOT}/infra/production-pull/esmii-production-pull.timer" /etc/systemd/system/esmii-production-pull.timer
systemctl daemon-reload
echo "Installed the production pull service; it remains disabled until explicitly enabled."
