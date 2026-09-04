#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LANG=C.UTF-8
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME DOCKER_CONTEXT DOCKER_HOST

readonly RUNTIME_ROOT=/srv/myapp/staging-runtime
readonly MONITORING_STATE_ROOT=/var/lib/esmii/monitoring
readonly HOST_OPERATION_LOCK=/run/lock/esmii/host-pull.lock
readonly OVERLAY_HELPER=/usr/local/libexec/esmii/monitoring_overlay_state.py
readonly DOCKER_FIREWALL=/usr/local/sbin/esmii-docker-firewall

usage() {
  echo "Usage: $0 start-private|enable-edge|disable-edge|stop staging|production" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
readonly ACTION=$1
readonly ENVIRONMENT=$2
case "${ACTION}" in
  start-private | enable-edge | disable-edge | stop) ;;
  *) usage ;;
esac
case "${ENVIRONMENT}" in
  staging | production) ;;
  *) usage ;;
esac

if [[ ${EUID} -ne 0 ]]; then
  echo "The monitoring runtime manager must run as root." >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$(dirname "${HOST_OPERATION_LOCK}")"
exec 9>"${HOST_OPERATION_LOCK}"
if ! flock --exclusive --wait 30 9; then
  echo "Timed out waiting for the shared Esmii host-operation lock." >&2
  exit 1
fi

if [[ ! -x ${OVERLAY_HELPER} || -L ${OVERLAY_HELPER} ]] \
  || [[ $(stat -c '%u:%g:%a' "${OVERLAY_HELPER}") != 0:0:755 ]]; then
  echo "The installed monitoring overlay verifier is absent or unsafe." >&2
  exit 1
fi
if [[ -L ${RUNTIME_ROOT} || ! -d ${RUNTIME_ROOT} ]]; then
  echo "The fixed monitoring runtime root is absent or unsafe." >&2
  exit 1
fi

readonly MARKER_ROOT="${MONITORING_STATE_ROOT}/${ENVIRONMENT}"
readonly PRIVATE_MARKER="${MARKER_ROOT}/private-enabled"
readonly EDGE_MARKER="${MARKER_ROOT}/edge-enabled"
if [[ -L ${MARKER_ROOT} || ! -d ${MARKER_ROOT} ]] \
  || [[ $(stat -c '%u:%g:%a' "${MARKER_ROOT}") != 0:0:755 ]]; then
  echo "The environment monitoring state directory is absent or unsafe." >&2
  exit 1
fi

validate_marker() {
  local marker=$1
  [[ -e ${marker} ]] || return 1
  if [[ -L ${marker} || ! -f ${marker} ]] \
    || [[ $(stat -c '%u:%g:%a' "${marker}") != 0:0:600 ]] \
    || [[ $(cat "${marker}") != enabled ]]; then
    echo "Monitoring activation marker is unsafe: $(basename "${marker}")" >&2
    exit 1
  fi
}

create_marker() {
  local marker=$1
  local temporary
  if validate_marker "${marker}"; then
    return
  fi
  temporary=$(mktemp "${MARKER_ROOT}/.$(basename "${marker}").XXXXXX")
  printf 'enabled\n' >"${temporary}"
  chown root:root "${temporary}"
  chmod 0600 "${temporary}"
  mv -f "${temporary}" "${marker}"
}

remove_marker() {
  local marker=$1
  if [[ ! -e ${marker} ]]; then
    return
  fi
  validate_marker "${marker}"
  rm -f -- "${marker}"
}

declare -a APP_COMPOSE_ARGUMENTS=(
  -f "${RUNTIME_ROOT}/compose.yaml"
  -f "${RUNTIME_ROOT}/compose.staging.yaml"
)
for required in "${RUNTIME_ROOT}/compose.yaml" "${RUNTIME_ROOT}/compose.staging.yaml"; do
  if [[ -L ${required} || ! -f ${required} ]]; then
    echo "An active application Compose file is absent or unsafe: ${required}" >&2
    exit 1
  fi
done
if [[ -e ${RUNTIME_ROOT}/compose.production.yaml ]]; then
  if [[ -L ${RUNTIME_ROOT}/compose.production.yaml || ! -f ${RUNTIME_ROOT}/compose.production.yaml ]]; then
    echo "The active production Compose file is unsafe." >&2
    exit 1
  fi
  APP_COMPOSE_ARGUMENTS+=(-f "${RUNTIME_ROOT}/compose.production.yaml")
fi

declare -a MONITORING_COMPOSE_ARGUMENTS=()
load_monitoring_compose_arguments() {
  local exclude_edge=${1:-}
  local expected_base="${RUNTIME_ROOT}/compose.monitoring.${ENVIRONMENT}.yaml"
  local output path
  local found_base=false
  MONITORING_COMPOSE_ARGUMENTS=()
  output=$("${OVERLAY_HELPER}" list) || exit 1
  while IFS= read -r path; do
    [[ -z ${path} ]] && continue
    [[ ${path} =~ ^/srv/myapp/staging-runtime/compose\.monitoring\.(staging|production)(\.edge)?\.yaml$ ]] \
      || { echo "Monitoring verifier returned an unexpected Compose path." >&2; exit 1; }
    if [[ -n ${exclude_edge} && ${path} == "${RUNTIME_ROOT}/compose.monitoring.${exclude_edge}.edge.yaml" ]]; then
      continue
    fi
    MONITORING_COMPOSE_ARGUMENTS+=(-f "${path}")
    [[ ${path} == "${expected_base}" ]] && found_base=true
  done <<<"${output}"
  if [[ ${found_base} != true ]]; then
    echo "The ${ENVIRONMENT} private monitoring runtime is not enabled and verified." >&2
    return 1
  fi
}

compose() {
  /usr/bin/docker compose \
    --project-name esmii \
    --project-directory "${RUNTIME_ROOT}" \
    "${APP_COMPOSE_ARGUMENTS[@]}" \
    "${MONITORING_COMPOSE_ARGUMENTS[@]}" \
    "$@"
}

validate_composition() {
  compose config --quiet
}

private_services() {
  printf '%s\n' \
    "${ENVIRONMENT}-dashboard-secret-init" \
    "${ENVIRONMENT}-dashboard" \
    "${ENVIRONMENT}-prometheus"
}

verify_private_detached() {
  local service identifiers
  while IFS= read -r service; do
    identifiers=$(/usr/bin/docker container ls --all --quiet \
      --filter label=com.docker.compose.project=esmii \
      --filter "label=com.docker.compose.service=${service}")
    if [[ -n ${identifiers} ]]; then
      echo "Monitoring service remains attached: ${service}" >&2
      return 1
    fi
  done < <(private_services)
}

verify_edge_detached() {
  local identifier network mount
  while IFS= read -r identifier; do
    [[ -z ${identifier} ]] && continue
    network=$(/usr/bin/docker container inspect --format \
      "{{if index .NetworkSettings.Networks \"esmii_${ENVIRONMENT}-monitoring-edge\"}}attached{{end}}" \
      "${identifier}")
    mount=$(/usr/bin/docker container inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "${identifier}")
    if [[ ${network} == attached ]] \
      || grep -Fqx "/etc/caddy/sites-enabled/${ENVIRONMENT}-dashboard.caddy" <<<"${mount}"; then
      echo "Shared Caddy remains attached to the ${ENVIRONMENT} monitoring edge." >&2
      return 1
    fi
  done < <(/usr/bin/docker container ls --all --quiet \
    --filter label=com.docker.compose.project=esmii \
    --filter label=com.docker.compose.service=caddy)
}

reconcile_caddy() {
  validate_composition
  compose up --detach --wait --wait-timeout 120 --no-deps caddy
}

refresh_docker_firewall() {
  if [[ -L ${DOCKER_FIREWALL} || ! -x ${DOCKER_FIREWALL} ]] \
    || [[ $(stat -c '%u:%g:%a' "${DOCKER_FIREWALL}") != 0:0:755 ]]; then
    echo "The installed Docker firewall integration is absent or unsafe." >&2
    return 1
  fi
  /usr/bin/systemctl restart esmii-docker-firewall.service
}

start_private() {
  local newly_enabled=false
  if ! validate_marker "${PRIVATE_MARKER}"; then
    create_marker "${PRIVATE_MARKER}"
    newly_enabled=true
  fi
  if ! load_monitoring_compose_arguments || ! validate_composition \
    || ! compose up --detach --wait --wait-timeout 120 \
      "${ENVIRONMENT}-prometheus" "${ENVIRONMENT}-dashboard" \
    || ! refresh_docker_firewall; then
    if [[ ${newly_enabled} == true ]]; then
      load_monitoring_compose_arguments || true
      compose rm --force --stop \
        "${ENVIRONMENT}-dashboard-secret-init" \
        "${ENVIRONMENT}-dashboard" \
        "${ENVIRONMENT}-prometheus" || true
      if verify_private_detached; then
        remove_marker "${PRIVATE_MARKER}"
      else
        echo "Private activation cleanup failed; the authoritative marker was retained." >&2
      fi
    fi
    return 1
  fi
}

disable_edge() {
  local was_enabled=false
  validate_marker "${PRIVATE_MARKER}" || {
    echo "Private monitoring must be enabled before its edge can be managed." >&2
    return 1
  }
  if validate_marker "${EDGE_MARKER}"; then
    was_enabled=true
  fi
  load_monitoring_compose_arguments "${ENVIRONMENT}"
  if ! reconcile_caddy || ! verify_edge_detached; then
    if [[ ${was_enabled} == true ]]; then
      load_monitoring_compose_arguments || true
      reconcile_caddy || true
    fi
    echo "Could not detach the ${ENVIRONMENT} monitoring edge; its marker was retained." >&2
    return 1
  fi
  remove_marker "${EDGE_MARKER}"
}

enable_edge() {
  local newly_enabled=false
  start_private
  if ! validate_marker "${EDGE_MARKER}"; then
    create_marker "${EDGE_MARKER}"
    newly_enabled=true
  fi
  if ! load_monitoring_compose_arguments || ! reconcile_caddy; then
    if [[ ${newly_enabled} == true ]]; then
      load_monitoring_compose_arguments "${ENVIRONMENT}" || true
      if reconcile_caddy && verify_edge_detached; then
        remove_marker "${EDGE_MARKER}"
      else
        echo "Edge activation cleanup failed; the authoritative marker was retained." >&2
      fi
    fi
    return 1
  fi
}

stop_private() {
  validate_marker "${PRIVATE_MARKER}" || {
    verify_private_detached
    verify_edge_detached
    return
  }
  disable_edge
  load_monitoring_compose_arguments
  compose rm --force --stop \
    "${ENVIRONMENT}-dashboard-secret-init" \
    "${ENVIRONMENT}-dashboard" \
    "${ENVIRONMENT}-prometheus"
  verify_private_detached
  remove_marker "${PRIVATE_MARKER}"
}

case "${ACTION}" in
  start-private) start_private ;;
  enable-edge) enable_edge ;;
  disable-edge) disable_edge ;;
  stop) stop_private ;;
esac

echo "Completed ${ACTION} for ${ENVIRONMENT} monitoring under the shared host-operation lock."
