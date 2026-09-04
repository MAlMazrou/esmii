#!/usr/bin/env bash

set -Eeuo pipefail
umask 027
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

readonly ACTIVE_ROOT=/var/lib/esmii/monitoring/shared/enabled-environments
readonly REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
readonly FIXED_PAYLOAD_VERIFIER=/var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/monitoring_payload.py

environment=
remove_shared=false
confirmation=
expected_host_payload_digest=
expected_host_payload_revision=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment)
      [[ $# -ge 2 && -z ${environment} ]] || { echo "--environment requires one value." >&2; exit 2; }
      environment=$2
      shift 2
      ;;
    --remove-shared)
      remove_shared=true
      shift
      ;;
    --confirm)
      [[ $# -ge 2 && -z ${confirmation} ]] || { echo "--confirm requires one value." >&2; exit 2; }
      confirmation=$2
      shift 2
      ;;
    --expected-host-payload-digest)
      [[ $# -ge 2 ]] || { echo "--expected-host-payload-digest requires one digest." >&2; exit 2; }
      expected_host_payload_digest=$2
      shift 2
      ;;
    --expected-host-payload-revision)
      [[ $# -ge 2 ]] || { echo "--expected-host-payload-revision requires one revision." >&2; exit 2; }
      expected_host_payload_revision=$2
      shift 2
      ;;
    *)
      echo "Usage: $0 --expected-host-payload-digest DIGEST --expected-host-payload-revision SHA (--environment staging|production --confirm disable-ENV-monitoring | --remove-shared --confirm remove-shared-monitoring)" >&2
      exit 2
      ;;
  esac
done
if [[ ! ${expected_host_payload_digest} =~ ^sha256:[0-9a-f]{64}$ ]] \
  || [[ ! ${expected_host_payload_revision} =~ ^[0-9a-f]{40}$ ]]; then
  echo "A reviewed monitoring host payload digest and full revision are required." >&2
  exit 2
fi

if [[ ${EUID} -ne 0 ]]; then
  echo "The host collector rollback must run as root." >&2
  exit 1
fi
if [[ -L ${FIXED_PAYLOAD_VERIFIER} || ! -f ${FIXED_PAYLOAD_VERIFIER} ]] \
  || [[ $(/usr/bin/stat -c '%u:%g:%a' "${FIXED_PAYLOAD_VERIFIER}") != 0:0:700 ]]; then
  echo "The independently bootstrapped monitoring payload verifier is absent or unsafe." >&2
  exit 1
fi
/usr/bin/python3 "${FIXED_PAYLOAD_VERIFIER}" \
  verify-materialized \
  --root "${REPOSITORY_ROOT}" \
  --expected-digest "${expected_host_payload_digest}" \
  --expected-revision "${expected_host_payload_revision}"
install -d -o root -g root -m 0755 /run/lock/esmii
exec 8>/run/lock/esmii/host-pull.lock
if ! /usr/bin/flock --exclusive --wait 30 8; then
  echo "Timed out waiting for the shared Esmii host-operation lock." >&2
  exit 1
fi
exec 9>/run/lock/esmii-monitoring-host.lock
if ! /usr/bin/flock --exclusive --wait 30 9; then
  echo "Timed out waiting for the fixed monitoring host-operation lock." >&2
  exit 1
fi

private_listener_present() {
  local gateway=$1
  local listeners
  listeners=$(/usr/bin/ss -H -ltn) || {
    echo "Could not inspect private monitoring listeners." >&2
    exit 1
  }
  /usr/bin/grep -Fq "${gateway}:9100" <<<"${listeners}"
}

ufw_rule_present() {
  local environment=$1
  local rules
  rules=$(/usr/sbin/ufw show added) || {
    echo "Could not inspect persistent UFW rules." >&2
    exit 1
  }
  /usr/bin/grep -Fq "esmii-${environment}-prometheus-node-exporter" <<<"${rules}"
}

disable_if_installed() {
  local unit=$1
  if [[ -e /etc/systemd/system/${unit} ]]; then
    systemctl disable --now "${unit}"
  fi
}

stop_if_installed() {
  local unit=$1
  if [[ -e /etc/systemd/system/${unit} ]]; then
    systemctl stop "${unit}"
  fi
}

unit_remains_active() {
  local state unit=$1
  if [[ ! -e /etc/systemd/system/${unit} ]]; then
    return 1
  fi
  state=$(systemctl show --property=ActiveState --value "${unit}") || {
    echo "Could not verify unit state: ${unit}" >&2
    exit 1
  }
  [[ ${state} != inactive && ${state} != failed ]]
}

if [[ ${remove_shared} == true ]]; then
  if [[ -n ${environment} || ${confirmation} != remove-shared-monitoring ]]; then
    echo "Shared removal requires its exact standalone confirmation." >&2
    exit 2
  fi
  if [[ -f ${ACTIVE_ROOT}/staging || -f ${ACTIVE_ROOT}/production ]] \
    || [[ -e /srv/myapp/staging-runtime/monitoring/runtime-manifest.staging.json ]] \
    || [[ -e /srv/myapp/staging-runtime/monitoring/runtime-manifest.production.json ]] \
    || [[ -e /var/lib/esmii/monitoring/shared/state/pull-wrapper-integration.json ]] \
    || systemctl is-active --quiet esmii-node-exporter-staging-proxy.socket \
    || systemctl is-active --quiet esmii-node-exporter-production-proxy.socket \
    || private_listener_present 172.30.40.9 \
    || private_listener_present 172.30.41.9; then
    echo "Refusing shared collector removal while an environment or pull-wrapper integration is present." >&2
    exit 1
  fi

  for unit in \
    esmii-log-collector.timer \
    esmii-container-metrics-collector.timer \
    esmii-node-exporter-staging-proxy.socket \
    esmii-node-exporter-production-proxy.socket \
    esmii-node-exporter.service; do
    disable_if_installed "${unit}"
  done
  for unit in \
    esmii-node-exporter-staging-proxy.service \
    esmii-node-exporter-production-proxy.service \
    esmii-log-collector.service \
    esmii-container-metrics-collector.service; do
    stop_if_installed "${unit}"
  done
  for unit in \
    esmii-node-exporter.service \
    esmii-node-exporter-staging-proxy.service \
    esmii-node-exporter-production-proxy.service \
    esmii-node-exporter-staging-proxy.socket \
    esmii-node-exporter-production-proxy.socket \
    esmii-container-metrics-collector.service \
    esmii-container-metrics-collector.timer \
    esmii-log-collector.service \
    esmii-log-collector.timer; do
    if unit_remains_active "${unit}"; then
      echo "Refusing file removal because ${unit} is still active." >&2
      exit 1
    fi
  done
  if private_listener_present 172.30.40.9 || private_listener_present 172.30.41.9; then
    echo "Refusing file removal while a private exporter listener remains." >&2
    exit 1
  fi
  for target_environment in staging production; do
    if ufw_rule_present "${target_environment}"; then
      if [[ ${target_environment} == staging ]]; then
        /usr/sbin/ufw --force delete allow proto tcp from 172.30.40.11 to 172.30.40.9 port 9100
      else
        /usr/sbin/ufw --force delete allow proto tcp from 172.30.41.11 to 172.30.41.9 port 9100
      fi
    fi
    if ufw_rule_present "${target_environment}"; then
      echo "Refusing file removal because the ${target_environment} exporter firewall rule remains." >&2
      exit 1
    fi
  done

  rm -f \
    /etc/systemd/system/esmii-node-exporter.service \
    /etc/systemd/system/esmii-node-exporter.slice \
    /etc/systemd/system/esmii-node-exporter-staging-proxy.service \
    /etc/systemd/system/esmii-node-exporter-production-proxy.service \
    /etc/systemd/system/esmii-node-exporter-staging-proxy.socket \
    /etc/systemd/system/esmii-node-exporter-production-proxy.socket \
    /etc/systemd/system/esmii-container-metrics-collector.service \
    /etc/systemd/system/esmii-container-metrics-collector.timer \
    /etc/systemd/system/esmii-log-collector.service \
    /etc/systemd/system/esmii-log-collector.timer \
    /usr/local/libexec/esmii/manage-monitoring-runtime \
    /usr/local/libexec/esmii/container_metrics_collector.py \
    /usr/local/libexec/esmii/log_collector.py \
    /usr/local/libexec/esmii/monitoring_common.py \
    /usr/local/libexec/esmii/monitoring_overlay_state.py \
    /var/lib/esmii/monitoring/shared/state/collector-install.sha256 \
    /var/lib/esmii/monitoring/shared/state/host-payload.json
  systemctl daemon-reload
  echo "Removed shared host collector units and scripts only; all metrics, logs, auth, Prometheus state, secrets, and the node_exporter binary were preserved."
  exit 0
fi

if [[ ${environment} == staging ]]; then
  expected_confirmation=disable-staging-monitoring
  socket_unit=esmii-node-exporter-staging-proxy.socket
  proxy_service=esmii-node-exporter-staging-proxy.service
  source_address=172.30.40.11
  gateway=172.30.40.9
elif [[ ${environment} == production ]]; then
  expected_confirmation=disable-production-monitoring
  socket_unit=esmii-node-exporter-production-proxy.socket
  proxy_service=esmii-node-exporter-production-proxy.service
  source_address=172.30.41.11
  gateway=172.30.41.9
else
  echo "An exact staging or production environment is required." >&2
  exit 2
fi
if [[ ${confirmation} != "${expected_confirmation}" ]]; then
  echo "Environment-specific rollback confirmation is required." >&2
  exit 2
fi

disable_if_installed "${socket_unit}"
stop_if_installed "${proxy_service}"
if unit_remains_active "${socket_unit}" \
  || unit_remains_active "${proxy_service}" \
  || private_listener_present "${gateway}"; then
  echo "The ${environment} private exporter socket or listener remains active." >&2
  exit 1
fi
if ufw_rule_present "${environment}"; then
  /usr/sbin/ufw --force delete allow proto tcp from "${source_address}" to "${gateway}" port 9100
fi
if ufw_rule_present "${environment}"; then
  echo "The ${environment} exporter firewall rule remains configured." >&2
  exit 1
fi
rm -f "${ACTIVE_ROOT}/${environment}"
echo "Disabled only the ${environment} private exporter path. Shared collectors and the other environment were preserved."
