#!/usr/bin/env bash

set -Eeuo pipefail
umask 027
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

readonly EXPECTED_NODE_EXPORTER=/usr/local/bin/node_exporter
readonly DOCKER_FIREWALL=/usr/local/sbin/esmii-docker-firewall
readonly LIBEXEC_ROOT=/usr/local/libexec/esmii
readonly MONITORING_ROOT=/var/lib/esmii/monitoring
readonly SHARED_ROOT=${MONITORING_ROOT}/shared
readonly METRICS_ROOT=${SHARED_ROOT}/textfiles
readonly STATE_ROOT=${SHARED_ROOT}/state
readonly ACTIVE_ROOT=${SHARED_ROOT}/enabled-environments
readonly MANIFEST=${STATE_ROOT}/collector-install.sha256
readonly HOST_PAYLOAD_RECORD=${STATE_ROOT}/host-payload.json
readonly SECRET_ROOT=/etc/esmii/monitoring
readonly REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
readonly FIXED_PAYLOAD_VERIFIER=/var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/monitoring_payload.py

readonly -a UNIT_NAMES=(
  esmii-node-exporter.slice
  esmii-node-exporter.service
  esmii-node-exporter-staging-proxy.service
  esmii-node-exporter-production-proxy.service
  esmii-node-exporter-staging-proxy.socket
  esmii-node-exporter-production-proxy.socket
  esmii-container-metrics-collector.service
  esmii-container-metrics-collector.timer
  esmii-log-collector.service
  esmii-log-collector.timer
)
readonly -a INSTALLED_FILES=(
  "${EXPECTED_NODE_EXPORTER}"
  "${DOCKER_FIREWALL}"
  "${LIBEXEC_ROOT}/manage-monitoring-runtime"
  "${LIBEXEC_ROOT}/monitoring_common.py"
  "${LIBEXEC_ROOT}/monitoring_overlay_state.py"
  "${LIBEXEC_ROOT}/container_metrics_collector.py"
  "${LIBEXEC_ROOT}/log_collector.py"
  /etc/systemd/system/esmii-node-exporter.slice
  /etc/systemd/system/esmii-node-exporter.service
  /etc/systemd/system/esmii-node-exporter-staging-proxy.service
  /etc/systemd/system/esmii-node-exporter-production-proxy.service
  /etc/systemd/system/esmii-node-exporter-staging-proxy.socket
  /etc/systemd/system/esmii-node-exporter-production-proxy.socket
  /etc/systemd/system/esmii-container-metrics-collector.service
  /etc/systemd/system/esmii-container-metrics-collector.timer
  /etc/systemd/system/esmii-log-collector.service
  /etc/systemd/system/esmii-log-collector.timer
)

action=
enable_environment=
expected_node_exporter_sha256=
expected_host_payload_digest=
expected_host_payload_revision=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-shared)
      [[ -z ${action} ]] || { echo "Select exactly one action." >&2; exit 2; }
      action=install-shared
      shift
      ;;
    --enable-staging|--enable-production)
      [[ -z ${action} ]] || { echo "Select exactly one action." >&2; exit 2; }
      action=enable-environment
      enable_environment=${1#--enable-}
      shift
      ;;
    --node-exporter-sha256)
      [[ $# -ge 2 ]] || { echo "--node-exporter-sha256 requires one checksum." >&2; exit 2; }
      expected_node_exporter_sha256=$2
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
      echo "Usage: $0 --expected-host-payload-digest DIGEST --expected-host-payload-revision SHA --node-exporter-sha256 HEX (--install-shared|--enable-staging|--enable-production)" >&2
      exit 2
      ;;
  esac
done
if [[ -z ${action} || ! ${expected_node_exporter_sha256} =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! ${expected_host_payload_digest} =~ ^sha256:[0-9a-f]{64}$ ]] \
  || [[ ! ${expected_host_payload_revision} =~ ^[0-9a-f]{40}$ ]]; then
  echo "One action, the reviewed host-payload identity, and a lowercase node_exporter SHA-256 checksum are required." >&2
  exit 2
fi
if [[ ${EUID} -ne 0 ]]; then
  echo "The host collector installer must run as root." >&2
  exit 1
fi

# The candidate cannot authenticate itself. Use only the verifier installed by
# the independently hash-approved bootstrap, before creating locks,
# directories, or changing any installed host file.
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
if [[ ! -x ${EXPECTED_NODE_EXPORTER} || -L ${EXPECTED_NODE_EXPORTER} ]]; then
  echo "Install the separately verified node_exporter binary at ${EXPECTED_NODE_EXPORTER} first." >&2
  exit 1
fi
if [[ $(/usr/bin/stat -c '%u:%g:%a' "${EXPECTED_NODE_EXPORTER}") != 0:0:755 ]]; then
  echo "node_exporter must be a root:root mode-0755 regular binary." >&2
  exit 1
fi
actual_node_exporter_sha256=$(/usr/bin/sha256sum --binary "${EXPECTED_NODE_EXPORTER}")
actual_node_exporter_sha256=${actual_node_exporter_sha256%% *}
if [[ ${actual_node_exporter_sha256} != "${expected_node_exporter_sha256}" ]]; then
  echo "node_exporter does not match the reviewed SHA-256 checksum." >&2
  exit 1
fi

ensure_directories() {
  install -d -o root -g root -m 0755 \
    "${LIBEXEC_ROOT}" "${MONITORING_ROOT}" "${SHARED_ROOT}" "${METRICS_ROOT}"
  install -d -o root -g root -m 0700 "${STATE_ROOT}" "${ACTIVE_ROOT}"
  install -d -o root -g root -m 0755 \
    "${MONITORING_ROOT}/staging" "${MONITORING_ROOT}/production"
  install -d -o root -g 10003 -m 0750 \
    "${MONITORING_ROOT}/staging/logs" "${MONITORING_ROOT}/production/logs"
  install -d -o 10003 -g 10003 -m 0700 \
    "${MONITORING_ROOT}/staging/auth" "${MONITORING_ROOT}/production/auth"
  install -d -o 65534 -g 65534 -m 0700 \
    "${MONITORING_ROOT}/staging/prometheus" "${MONITORING_ROOT}/production/prometheus"
  install -d -o root -g root -m 0700 \
    "${SECRET_ROOT}" "${SECRET_ROOT}/staging" "${SECRET_ROOT}/production"
  touch "${MONITORING_ROOT}/staging/logs/services.ndjson" "${MONITORING_ROOT}/production/logs/services.ndjson"
  chown root:10003 "${MONITORING_ROOT}/staging/logs/services.ndjson" "${MONITORING_ROOT}/production/logs/services.ndjson"
  chmod 0640 "${MONITORING_ROOT}/staging/logs/services.ndjson" "${MONITORING_ROOT}/production/logs/services.ndjson"
}

environment_is_registered() {
  [[ -f ${ACTIVE_ROOT}/staging || -f ${ACTIVE_ROOT}/production ]]
}

shared_runtime_is_active() {
  local enabled state unit
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
    if [[ ! -e /etc/systemd/system/${unit} ]]; then
      continue
    fi
    state=$(systemctl show --property=ActiveState --value "${unit}") || {
      echo "Could not verify shared unit state: ${unit}" >&2
      return 0
    }
    if [[ ${state} != inactive && ${state} != failed ]]; then
      return 0
    fi
  done
  for unit in \
    esmii-node-exporter.service \
    esmii-node-exporter-staging-proxy.socket \
    esmii-node-exporter-production-proxy.socket \
    esmii-container-metrics-collector.timer \
    esmii-log-collector.timer; do
    if [[ ! -e /etc/systemd/system/${unit} ]]; then
      continue
    fi
    enabled=$(systemctl is-enabled "${unit}" 2>/dev/null || true)
    case "${enabled}" in
      disabled|static|indirect|generated|transient|masked) ;;
      *) return 0 ;;
    esac
  done
  return 1
}

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

verify_shared_install() {
  if [[ ! -f ${MANIFEST} || -L ${MANIFEST} ]]; then
    echo "The immutable shared collector manifest is absent or unsafe." >&2
    return 1
  fi
  if [[ $(/usr/bin/stat -c '%u:%g:%a' "${MANIFEST}") != 0:0:600 ]]; then
    echo "The shared collector manifest must be root:root mode 0600." >&2
    return 1
  fi
  /usr/bin/sha256sum --check --status "${MANIFEST}" || {
    echo "Installed shared collector files do not match their manifest." >&2
    return 1
  }
  if [[ -L ${HOST_PAYLOAD_RECORD} || ! -f ${HOST_PAYLOAD_RECORD} ]] \
    || [[ $(/usr/bin/stat -c '%u:%g:%a' "${HOST_PAYLOAD_RECORD}") != 0:0:600 ]] \
    || [[ $(cat "${HOST_PAYLOAD_RECORD}") != "{\"digest\":\"${expected_host_payload_digest}\",\"revision\":\"${expected_host_payload_revision}\",\"schemaVersion\":1}" ]]; then
    echo "Installed monitoring host payload identity differs from the reviewed payload." >&2
    return 1
  fi
  /usr/bin/cmp --silent "${REPOSITORY_ROOT}/infra/monitoring/monitoring_common.py" "${LIBEXEC_ROOT}/monitoring_common.py"
  /usr/bin/cmp --silent "${REPOSITORY_ROOT}/infra/monitoring/monitoring_overlay_state.py" "${LIBEXEC_ROOT}/monitoring_overlay_state.py"
  /usr/bin/cmp --silent "${REPOSITORY_ROOT}/infra/monitoring/manage-monitoring-runtime.sh" "${LIBEXEC_ROOT}/manage-monitoring-runtime"
  /usr/bin/cmp --silent "${REPOSITORY_ROOT}/infra/monitoring/container_metrics_collector.py" "${LIBEXEC_ROOT}/container_metrics_collector.py"
  /usr/bin/cmp --silent "${REPOSITORY_ROOT}/infra/monitoring/log_collector.py" "${LIBEXEC_ROOT}/log_collector.py"
  /usr/bin/cmp --silent \
    "${REPOSITORY_ROOT}/infra/ansible/roles/firewall/files/esmii-docker-firewall.sh" \
    "${DOCKER_FIREWALL}"
  for unit in "${UNIT_NAMES[@]}"; do
    /usr/bin/cmp --silent "${REPOSITORY_ROOT}/infra/systemd/${unit}" "/etc/systemd/system/${unit}"
  done
  "${LIBEXEC_ROOT}/monitoring_overlay_state.py" list >/dev/null
}

ensure_directories

if [[ ${action} == install-shared ]]; then
  if environment_is_registered || shared_runtime_is_active; then
    echo "Refusing to replace shared collector code while an environment is registered or active." >&2
    exit 1
  fi
  install -o root -g root -m 0644 \
    "${REPOSITORY_ROOT}/infra/monitoring/monitoring_common.py" \
    "${LIBEXEC_ROOT}/monitoring_common.py"
  install -o root -g root -m 0755 \
    "${REPOSITORY_ROOT}/infra/monitoring/manage-monitoring-runtime.sh" \
    "${LIBEXEC_ROOT}/manage-monitoring-runtime"
  install -o root -g root -m 0755 \
    "${REPOSITORY_ROOT}/infra/monitoring/monitoring_overlay_state.py" \
    "${LIBEXEC_ROOT}/monitoring_overlay_state.py"
  install -o root -g root -m 0755 \
    "${REPOSITORY_ROOT}/infra/monitoring/container_metrics_collector.py" \
    "${LIBEXEC_ROOT}/container_metrics_collector.py"
  install -o root -g root -m 0755 \
    "${REPOSITORY_ROOT}/infra/monitoring/log_collector.py" \
    "${LIBEXEC_ROOT}/log_collector.py"
  install -o root -g root -m 0755 \
    "${REPOSITORY_ROOT}/infra/ansible/roles/firewall/files/esmii-docker-firewall.sh" \
    "${DOCKER_FIREWALL}"
  for unit in "${UNIT_NAMES[@]}"; do
    install -o root -g root -m 0644 \
      "${REPOSITORY_ROOT}/infra/systemd/${unit}" \
      "/etc/systemd/system/${unit}"
  done
  payload_record_temporary=$(/usr/bin/mktemp "${STATE_ROOT}/.host-payload.XXXXXX")
  printf '{"digest":"%s","revision":"%s","schemaVersion":1}\n' \
    "${expected_host_payload_digest}" "${expected_host_payload_revision}" \
    >"${payload_record_temporary}"
  chown root:root "${payload_record_temporary}"
  chmod 0600 "${payload_record_temporary}"
  mv -f "${payload_record_temporary}" "${HOST_PAYLOAD_RECORD}"
  manifest_temporary=$(/usr/bin/mktemp "${STATE_ROOT}/.collector-install.XXXXXX")
  /usr/bin/sha256sum "${INSTALLED_FILES[@]}" "${HOST_PAYLOAD_RECORD}" >"${manifest_temporary}"
  chown root:root "${manifest_temporary}"
  chmod 0600 "${manifest_temporary}"
  mv -f "${manifest_temporary}" "${MANIFEST}"
  systemctl daemon-reload
  echo "Installed immutable shared host collectors without enabling an environment."
  exit 0
fi

verify_shared_install
if ! /usr/sbin/ufw status | /usr/bin/grep -Fqx 'Status: active'; then
  echo "UFW must be active before private node_exporter sockets are enabled." >&2
  exit 1
fi
if [[ ${enable_environment} == staging ]]; then
  gateway=172.30.40.9
  source_address=172.30.40.11
  socket_unit=esmii-node-exporter-staging-proxy.socket
  proxy_service=esmii-node-exporter-staging-proxy.service
  peer_environment=production
  peer_gateway=172.30.41.9
  peer_socket_unit=esmii-node-exporter-production-proxy.socket
  peer_proxy_service=esmii-node-exporter-production-proxy.service
else
  gateway=172.30.41.9
  source_address=172.30.41.11
  socket_unit=esmii-node-exporter-production-proxy.socket
  proxy_service=esmii-node-exporter-production-proxy.service
  peer_environment=staging
  peer_gateway=172.30.40.9
  peer_socket_unit=esmii-node-exporter-staging-proxy.socket
  peer_proxy_service=esmii-node-exporter-staging-proxy.service
fi
if ! /usr/sbin/ip -4 address show | /usr/bin/grep -Fq "${gateway}/"; then
  echo "Private monitoring gateway ${gateway} is absent; activate the reviewed ${enable_environment} private Compose overlay first." >&2
  exit 1
fi
install -o root -g root -m 0600 /dev/null "${ACTIVE_ROOT}/${enable_environment}"
/usr/sbin/ufw allow proto tcp from "${source_address}" to "${gateway}" port 9100 \
  comment "esmii-${enable_environment}-prometheus-node-exporter"
systemctl enable --now \
  esmii-node-exporter.service \
  "${socket_unit}" \
  esmii-container-metrics-collector.timer \
  esmii-log-collector.timer
systemctl start esmii-container-metrics-collector.service esmii-log-collector.service
for required_unit in \
  esmii-node-exporter.service \
  "${socket_unit}" \
  esmii-container-metrics-collector.timer \
  esmii-log-collector.timer; do
  if ! systemctl is-active --quiet "${required_unit}"; then
    echo "Required monitoring unit did not become active: ${required_unit}" >&2
    exit 1
  fi
done
if ! private_listener_present "${gateway}"; then
  echo "The private ${enable_environment} node_exporter listener did not become active." >&2
  exit 1
fi
if ! ufw_rule_present "${enable_environment}"; then
  echo "The exact ${enable_environment} node_exporter firewall rule is absent." >&2
  exit 1
fi
if [[ ! -f ${ACTIVE_ROOT}/${peer_environment} ]] \
  && { systemctl is-active --quiet "${peer_socket_unit}" \
    || systemctl is-active --quiet "${peer_proxy_service}" \
    || private_listener_present "${peer_gateway}"; }; then
  systemctl disable --now "${socket_unit}" || true
  systemctl stop "${proxy_service}" || true
  echo "The unapproved ${peer_environment} exporter path became active; rolled back this enablement." >&2
  exit 1
fi
echo "Enabled only the ${enable_environment} private exporter path; shared files were verified and not replaced."
