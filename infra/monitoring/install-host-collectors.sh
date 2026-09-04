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
readonly PULL_WRAPPER_RECORD=${STATE_ROOT}/pull-wrapper-integration.json
readonly SECRET_ROOT=/etc/esmii/monitoring
readonly RUNTIME_ROOT=/srv/myapp/staging-runtime
readonly REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
readonly FIXED_PAYLOAD_VERIFIER=/var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/monitoring_payload.py
readonly HOST_PAYLOAD_RECORD_PATTERN='^\{"digest":"(sha256:[0-9a-f]{64})","revision":"([0-9a-f]{40})","schemaVersion":1\}$'

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
readonly -a ACTIVE_PULL_WRAPPERS=(
  "${LIBEXEC_ROOT}/esmii-production-pull"
  "${LIBEXEC_ROOT}/esmii-staging-pull"
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
    --rebind-compatible-shared)
      [[ -z ${action} ]] || { echo "Select exactly one action." >&2; exit 2; }
      action=rebind-compatible-shared
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
      echo "Usage: $0 --expected-host-payload-digest DIGEST --expected-host-payload-revision SHA --node-exporter-sha256 HEX (--install-shared|--rebind-compatible-shared|--enable-staging|--enable-production)" >&2
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
  # GNU install resolves -o/-g arguments as account names. The dashboard and
  # Prometheus identities deliberately exist only inside their containers, so
  # create these host directories first and apply their numeric ownership with
  # chown, which accepts container-only UID/GID values.
  install -d -o root -g root -m 0750 \
    "${MONITORING_ROOT}/staging/logs" "${MONITORING_ROOT}/production/logs"
  chown root:10003 \
    "${MONITORING_ROOT}/staging/logs" "${MONITORING_ROOT}/production/logs"
  install -d -o root -g root -m 0700 \
    "${MONITORING_ROOT}/staging/auth" "${MONITORING_ROOT}/production/auth"
  chown 10003:10003 \
    "${MONITORING_ROOT}/staging/auth" "${MONITORING_ROOT}/production/auth"
  install -d -o root -g root -m 0700 \
    "${MONITORING_ROOT}/staging/prometheus" "${MONITORING_ROOT}/production/prometheus"
  chown 65534:65534 \
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

verify_installed_path() {
  local expected_mode=$2
  local path=$1
  if [[ -L ${path} || ! -f ${path} ]] \
    || [[ $(/usr/bin/stat -c '%u:%g:%a' "${path}") != "0:0:${expected_mode}" ]]; then
    echo "Installed shared collector file is absent or unsafe: ${path}" >&2
    return 1
  fi
}

verify_installed_files_match_candidate() {
  local destination expected_mode source unit
  for source in \
    infra/monitoring/monitoring_common.py \
    infra/monitoring/manage-monitoring-runtime.sh \
    infra/monitoring/monitoring_overlay_state.py \
    infra/monitoring/container_metrics_collector.py \
    infra/monitoring/log_collector.py; do
    destination=${LIBEXEC_ROOT}/$(basename "${source}")
    if [[ ${source} == infra/monitoring/manage-monitoring-runtime.sh ]]; then
      destination=${LIBEXEC_ROOT}/manage-monitoring-runtime
    fi
    if [[ ${source} == infra/monitoring/monitoring_common.py ]]; then
      expected_mode=644
    else
      expected_mode=755
    fi
    verify_installed_path "${destination}" "${expected_mode}"
    /usr/bin/cmp --silent "${REPOSITORY_ROOT}/${source}" "${destination}" || {
      echo "Installed shared collector file differs from this candidate: ${destination}" >&2
      return 1
    }
  done
  source=infra/ansible/roles/firewall/files/esmii-docker-firewall.sh
  verify_installed_path "${DOCKER_FIREWALL}" 755
  /usr/bin/cmp --silent "${REPOSITORY_ROOT}/${source}" "${DOCKER_FIREWALL}" || {
    echo "Installed Docker firewall helper differs from this candidate." >&2
    return 1
  }
  for unit in "${UNIT_NAMES[@]}"; do
    destination=/etc/systemd/system/${unit}
    verify_installed_path "${destination}" 644
    /usr/bin/cmp --silent "${REPOSITORY_ROOT}/infra/systemd/${unit}" "${destination}" || {
      echo "Installed shared collector unit differs from this candidate: ${unit}" >&2
      return 1
    }
  done
}

verify_collector_manifest() {
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
  /usr/bin/cmp --silent "${MANIFEST}" \
    <(/usr/bin/sha256sum "${INSTALLED_FILES[@]}" "${HOST_PAYLOAD_RECORD}") || {
    echo "The shared collector manifest does not contain the exact fixed file set." >&2
    return 1
  }
}

read_installed_host_payload_identity() {
  local record
  if [[ -L ${HOST_PAYLOAD_RECORD} || ! -f ${HOST_PAYLOAD_RECORD} ]] \
    || [[ $(/usr/bin/stat -c '%u:%g:%a' "${HOST_PAYLOAD_RECORD}") != 0:0:600 ]]; then
    echo "Installed monitoring host payload identity is absent or unsafe." >&2
    return 1
  fi
  record=$(cat "${HOST_PAYLOAD_RECORD}")
  if [[ ! ${record} =~ ${HOST_PAYLOAD_RECORD_PATTERN} ]]; then
    echo "Installed monitoring host payload identity is invalid." >&2
    return 1
  fi
  installed_host_payload_digest=${BASH_REMATCH[1]}
  installed_host_payload_revision=${BASH_REMATCH[2]}
}

verify_pull_wrapper_integration() {
  local expected_record production_hash source staging_hash wrapper
  if [[ -L ${PULL_WRAPPER_RECORD} || ! -f ${PULL_WRAPPER_RECORD} ]] \
    || [[ $(/usr/bin/stat -c '%u:%g:%a' "${PULL_WRAPPER_RECORD}") != 0:0:600 ]]; then
    echo "The monitoring pull-wrapper integration record is absent or unsafe." >&2
    return 1
  fi
  for wrapper in "${ACTIVE_PULL_WRAPPERS[@]}"; do
    verify_installed_path "${wrapper}" 755
    if [[ ${wrapper} == */esmii-production-pull ]]; then
      source=${REPOSITORY_ROOT}/infra/production-pull/esmii-production-pull
    else
      source=${REPOSITORY_ROOT}/infra/staging-pull/esmii-staging-pull
    fi
    /usr/bin/cmp --silent "${source}" "${wrapper}" || {
      echo "An active pull wrapper differs from this candidate: ${wrapper}" >&2
      return 1
    }
  done
  production_hash=$(/usr/bin/sha256sum --binary "${ACTIVE_PULL_WRAPPERS[0]}")
  production_hash=${production_hash%% *}
  staging_hash=$(/usr/bin/sha256sum --binary "${ACTIVE_PULL_WRAPPERS[1]}")
  staging_hash=${staging_hash%% *}
  expected_record=$(printf '{"files":{"/usr/local/libexec/esmii/esmii-production-pull":"%s","/usr/local/libexec/esmii/esmii-staging-pull":"%s"},"hostPayload":{"digest":"%s","revision":"%s"},"schemaVersion":1}' \
    "${production_hash}" \
    "${staging_hash}" \
    "${installed_host_payload_digest}" \
    "${installed_host_payload_revision}")
  if [[ $(cat "${PULL_WRAPPER_RECORD}") != "${expected_record}" ]]; then
    echo "The monitoring pull-wrapper integration record differs from installed state." >&2
    return 1
  fi
  verified_production_wrapper_hash=${production_hash}
  verified_staging_wrapper_hash=${staging_hash}
}

verify_expected_host_payload_identity() {
  read_installed_host_payload_identity
  if [[ ${installed_host_payload_digest} != "${expected_host_payload_digest}" ]] \
    || [[ ${installed_host_payload_revision} != "${expected_host_payload_revision}" ]]; then
    echo "Installed monitoring host payload identity differs from the reviewed payload." >&2
    return 1
  fi
}

verify_shared_install() {
  verify_collector_manifest
  verify_expected_host_payload_identity
  verify_installed_files_match_candidate
  verify_pull_wrapper_integration
  "${LIBEXEC_ROOT}/monitoring_overlay_state.py" list >/dev/null
}

verify_rebind_quiescence() {
  local enabled environment gateway identifiers path service source_address state unit
  if environment_is_registered; then
    echo "Refusing compatible payload rebind while an environment exporter is registered." >&2
    return 1
  fi
  for environment in staging production; do
    for path in \
      "${RUNTIME_ROOT}/compose.monitoring.${environment}.yaml" \
      "${RUNTIME_ROOT}/compose.monitoring.${environment}.edge.yaml" \
      "${RUNTIME_ROOT}/caddy/sites-enabled/${environment}-dashboard.caddy" \
      "${RUNTIME_ROOT}/monitoring/prometheus/${environment}/prometheus.yml" \
      "${RUNTIME_ROOT}/monitoring/prometheus/${environment}/rules/esmii.rules.yml" \
      "${RUNTIME_ROOT}/monitoring/runtime-manifest.${environment}.json" \
      "${MONITORING_ROOT}/${environment}/private-enabled" \
      "${MONITORING_ROOT}/${environment}/edge-enabled"; do
      if [[ -e ${path} || -L ${path} ]]; then
        echo "Refusing compatible payload rebind while environment runtime state remains: ${path}" >&2
        return 1
      fi
    done
    for service in \
      "${environment}-dashboard-secret-init" \
      "${environment}-dashboard" \
      "${environment}-prometheus"; do
      identifiers=$(/usr/bin/docker container ls --all --quiet \
        --filter label=com.docker.compose.project=esmii \
        --filter "label=com.docker.compose.service=${service}") || {
        echo "Docker could not verify compatible payload rebind quiescence." >&2
        return 1
      }
      if [[ -n ${identifiers} ]]; then
        echo "Refusing compatible payload rebind while a monitoring container exists: ${service}" >&2
        return 1
      fi
    done
    if [[ ${environment} == staging ]]; then
      gateway=172.30.40.9
      source_address=172.30.40.11
    else
      gateway=172.30.41.9
      source_address=172.30.41.11
    fi
    for unit in \
      "esmii-node-exporter-${environment}-proxy.socket" \
      "esmii-node-exporter-${environment}-proxy.service"; do
      state=$(systemctl show --property=ActiveState --value "${unit}") || {
        echo "Could not verify compatible payload rebind unit state: ${unit}" >&2
        return 1
      }
      if [[ ${state} != inactive && ${state} != failed ]]; then
        echo "Refusing compatible payload rebind while an environment proxy is active: ${unit}" >&2
        return 1
      fi
    done
    enabled=$(systemctl is-enabled "esmii-node-exporter-${environment}-proxy.socket" 2>/dev/null || true)
    if [[ ${enabled} != disabled ]]; then
      echo "Refusing compatible payload rebind while an environment proxy socket is enabled." >&2
      return 1
    fi
    if private_listener_present "${gateway}"; then
      echo "Refusing compatible payload rebind while ${gateway}:9100 is listening." >&2
      return 1
    fi
    if ufw_rule_present "${environment}"; then
      echo "Refusing compatible payload rebind while the ${source_address}-to-${gateway} exporter rule exists." >&2
      return 1
    fi
  done
}

rebind_compatible_host_payload() {
  local host_backup host_temporary integration_backup integration_temporary
  local manifest_backup manifest_temporary new_host_hash
  read_installed_host_payload_identity
  if [[ ${installed_host_payload_digest} == "${expected_host_payload_digest}" ]] \
    && [[ ${installed_host_payload_revision} == "${expected_host_payload_revision}" ]]; then
    echo "The shared collectors are already bound to the reviewed host payload." >&2
    return 1
  fi
  verify_collector_manifest
  verify_installed_files_match_candidate
  verify_pull_wrapper_integration
  "${LIBEXEC_ROOT}/monitoring_overlay_state.py" list >/dev/null
  verify_rebind_quiescence

  host_backup=$(/usr/bin/mktemp "${STATE_ROOT}/.host-payload.backup.XXXXXX")
  integration_backup=$(/usr/bin/mktemp "${STATE_ROOT}/.pull-wrapper-integration.backup.XXXXXX")
  manifest_backup=$(/usr/bin/mktemp "${STATE_ROOT}/.collector-install.backup.XXXXXX")
  host_temporary=$(/usr/bin/mktemp "${STATE_ROOT}/.host-payload.XXXXXX")
  integration_temporary=$(/usr/bin/mktemp "${STATE_ROOT}/.pull-wrapper-integration.XXXXXX")
  manifest_temporary=$(/usr/bin/mktemp "${STATE_ROOT}/.collector-install.XXXXXX")
  /usr/bin/cp --preserve=mode,ownership,timestamps "${HOST_PAYLOAD_RECORD}" "${host_backup}"
  /usr/bin/cp --preserve=mode,ownership,timestamps "${PULL_WRAPPER_RECORD}" "${integration_backup}"
  /usr/bin/cp --preserve=mode,ownership,timestamps "${MANIFEST}" "${manifest_backup}"
  printf '{"digest":"%s","revision":"%s","schemaVersion":1}\n' \
    "${expected_host_payload_digest}" "${expected_host_payload_revision}" \
    >"${host_temporary}"
  printf '{"files":{"/usr/local/libexec/esmii/esmii-production-pull":"%s","/usr/local/libexec/esmii/esmii-staging-pull":"%s"},"hostPayload":{"digest":"%s","revision":"%s"},"schemaVersion":1}\n' \
    "${verified_production_wrapper_hash}" \
    "${verified_staging_wrapper_hash}" \
    "${expected_host_payload_digest}" \
    "${expected_host_payload_revision}" \
    >"${integration_temporary}"
  /usr/bin/sha256sum "${INSTALLED_FILES[@]}" >"${manifest_temporary}"
  new_host_hash=$(/usr/bin/sha256sum --binary "${host_temporary}")
  new_host_hash=${new_host_hash%% *}
  printf '%s  %s\n' "${new_host_hash}" "${HOST_PAYLOAD_RECORD}" >>"${manifest_temporary}"
  chown root:root "${host_temporary}" "${integration_temporary}" "${manifest_temporary}"
  chmod 0600 "${host_temporary}" "${integration_temporary}" "${manifest_temporary}"

  if ! mv -f "${integration_temporary}" "${PULL_WRAPPER_RECORD}"; then
    rm -f -- "${host_backup}" "${integration_backup}" "${manifest_backup}" \
      "${host_temporary}" "${integration_temporary}" "${manifest_temporary}"
    echo "Compatible host-payload rebind could not update the pull-wrapper record." >&2
    return 1
  fi
  if ! mv -f "${host_temporary}" "${HOST_PAYLOAD_RECORD}"; then
    mv -f "${integration_backup}" "${PULL_WRAPPER_RECORD}"
    rm -f -- "${host_backup}" "${manifest_backup}" \
      "${host_temporary}" "${manifest_temporary}"
    echo "Compatible host-payload rebind restored the prior pull-wrapper record." >&2
    return 1
  fi
  if ! mv -f "${manifest_temporary}" "${MANIFEST}"; then
    mv -f "${integration_backup}" "${PULL_WRAPPER_RECORD}"
    mv -f "${host_backup}" "${HOST_PAYLOAD_RECORD}"
    rm -f -- "${manifest_backup}" "${manifest_temporary}"
    echo "Compatible host-payload rebind restored the prior identity records." >&2
    return 1
  fi
  if ! verify_shared_install; then
    mv -f "${integration_backup}" "${PULL_WRAPPER_RECORD}"
    mv -f "${host_backup}" "${HOST_PAYLOAD_RECORD}"
    mv -f "${manifest_backup}" "${MANIFEST}"
    echo "Compatible host-payload rebind failed verification and restored all prior identity records." >&2
    return 1
  fi
  rm -f -- "${host_backup}" "${integration_backup}" "${manifest_backup}"
  echo "Rebound byte-identical shared collectors and pull wrappers to the reviewed host payload without replacing files or changing service state."
}

if [[ ${action} == rebind-compatible-shared ]]; then
  rebind_compatible_host_payload
  exit 0
fi

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
