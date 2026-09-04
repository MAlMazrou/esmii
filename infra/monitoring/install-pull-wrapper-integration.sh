#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LANG=C.UTF-8
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

readonly REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
readonly LIBEXEC_ROOT=/usr/local/libexec/esmii
readonly HOST_OPERATION_LOCK=/run/lock/esmii/host-pull.lock
readonly STATE_ROOT=/var/lib/esmii/monitoring/shared/state
readonly HOST_PAYLOAD_RECORD=${STATE_ROOT}/host-payload.json
readonly INTEGRATION_MANIFEST=${STATE_ROOT}/pull-wrapper-integration.json
readonly FIXED_PAYLOAD_VERIFIER=/var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/monitoring_payload.py

if [[ $# -ne 4 || $1 != --expected-host-payload-digest || $3 != --expected-host-payload-revision ]]; then
  echo "Usage: $0 --expected-host-payload-digest DIGEST --expected-host-payload-revision SHA" >&2
  exit 2
fi
readonly EXPECTED_HOST_PAYLOAD_DIGEST=$2
readonly EXPECTED_HOST_PAYLOAD_REVISION=$4
if [[ ! ${EXPECTED_HOST_PAYLOAD_DIGEST} =~ ^sha256:[0-9a-f]{64}$ ]] \
  || [[ ! ${EXPECTED_HOST_PAYLOAD_REVISION} =~ ^[0-9a-f]{40}$ ]]; then
  echo "A reviewed monitoring host payload digest and full revision are required." >&2
  exit 2
fi
if [[ ${EUID} -ne 0 ]]; then
  echo "The monitoring pull-wrapper integration installer must run as root." >&2
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
  --expected-digest "${EXPECTED_HOST_PAYLOAD_DIGEST}" \
  --expected-revision "${EXPECTED_HOST_PAYLOAD_REVISION}"

if [[ -L ${HOST_PAYLOAD_RECORD} || ! -f ${HOST_PAYLOAD_RECORD} ]] \
  || [[ $(stat -c '%u:%g:%a' "${HOST_PAYLOAD_RECORD}") != 0:0:600 ]] \
  || [[ $(cat "${HOST_PAYLOAD_RECORD}") != "{\"digest\":\"${EXPECTED_HOST_PAYLOAD_DIGEST}\",\"revision\":\"${EXPECTED_HOST_PAYLOAD_REVISION}\",\"schemaVersion\":1}" ]]; then
  echo "Install the exact reviewed monitoring host payload before updating pull wrappers." >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$(dirname "${HOST_OPERATION_LOCK}")"
exec 9>"${HOST_OPERATION_LOCK}"
if ! flock --exclusive --wait 30 9; then
  echo "Timed out waiting for the shared Esmii host-operation lock." >&2
  exit 1
fi

for installed in \
  "${LIBEXEC_ROOT}/monitoring_overlay_state.py" \
  "${LIBEXEC_ROOT}/manage-monitoring-runtime"; do
  if [[ -L ${installed} || ! -x ${installed} ]] \
    || [[ $(stat -c '%u:%g:%a' "${installed}") != 0:0:755 ]]; then
    echo "Install the reviewed monitoring host integration first: ${installed}" >&2
    exit 1
  fi
done
cmp --silent \
  "${REPOSITORY_ROOT}/infra/monitoring/monitoring_overlay_state.py" \
  "${LIBEXEC_ROOT}/monitoring_overlay_state.py" \
  || { echo "The installed monitoring overlay verifier differs from this candidate." >&2; exit 1; }
cmp --silent \
  "${REPOSITORY_ROOT}/infra/monitoring/manage-monitoring-runtime.sh" \
  "${LIBEXEC_ROOT}/manage-monitoring-runtime" \
  || { echo "The installed monitoring runtime manager differs from this candidate." >&2; exit 1; }

declare -a SOURCES=(
  "${REPOSITORY_ROOT}/infra/staging-pull/esmii-staging-pull"
  "${REPOSITORY_ROOT}/infra/production-pull/esmii-production-pull"
)
declare -a DESTINATIONS=(
  "${LIBEXEC_ROOT}/esmii-staging-pull"
  "${LIBEXEC_ROOT}/esmii-production-pull"
)
declare -a TEMPORARIES=()
cleanup() {
  local temporary
  for temporary in "${TEMPORARIES[@]}"; do
    [[ -n ${temporary} ]] && rm -f -- "${temporary}"
  done
}
trap cleanup EXIT

for index in 0 1; do
  source_path=${SOURCES[${index}]}
  destination=${DESTINATIONS[${index}]}
  if [[ -L ${source_path} || ! -f ${source_path} ]] || ! bash -n "${source_path}"; then
    echo "A reviewed pull-wrapper source is absent, unsafe, or invalid." >&2
    exit 1
  fi
  if [[ -L ${destination} || ! -f ${destination} ]] \
    || [[ $(stat -c '%u:%g:%a' "${destination}") != 0:0:755 ]]; then
    echo "The expected active pull wrapper is absent or unsafe: ${destination}" >&2
    exit 1
  fi
  temporary=$(mktemp "${LIBEXEC_ROOT}/.$(basename "${destination}").XXXXXX")
  TEMPORARIES[${index}]=${temporary}
  install -o root -g root -m 0755 "${source_path}" "${temporary}"
done

for index in 0 1; do
  mv -f "${TEMPORARIES[${index}]}" "${DESTINATIONS[${index}]}"
  TEMPORARIES[${index}]=
done

for index in 0 1; do
  cmp --silent "${SOURCES[${index}]}" "${DESTINATIONS[${index}]}"
  [[ $(stat -c '%u:%g:%a' "${DESTINATIONS[${index}]}") == 0:0:755 ]]
  bash -n "${DESTINATIONS[${index}]}"
done

staging_hash=$(/usr/bin/sha256sum --binary "${DESTINATIONS[0]}")
staging_hash=${staging_hash%% *}
production_hash=$(/usr/bin/sha256sum --binary "${DESTINATIONS[1]}")
production_hash=${production_hash%% *}
manifest_temporary=$(mktemp "${STATE_ROOT}/.pull-wrapper-integration.XXXXXX")
printf '{"files":{"/usr/local/libexec/esmii/esmii-production-pull":"%s","/usr/local/libexec/esmii/esmii-staging-pull":"%s"},"hostPayload":{"digest":"%s","revision":"%s"},"schemaVersion":1}\n' \
  "${production_hash}" \
  "${staging_hash}" \
  "${EXPECTED_HOST_PAYLOAD_DIGEST}" \
  "${EXPECTED_HOST_PAYLOAD_REVISION}" \
  >"${manifest_temporary}"
chown root:root "${manifest_temporary}"
chmod 0600 "${manifest_temporary}"
mv -f "${manifest_temporary}" "${INTEGRATION_MANIFEST}"

[[ $(stat -c '%u:%g:%a' "${INTEGRATION_MANIFEST}") == 0:0:600 ]]
grep -Fq "\"digest\":\"${EXPECTED_HOST_PAYLOAD_DIGEST}\"" "${INTEGRATION_MANIFEST}"
"${LIBEXEC_ROOT}/monitoring_overlay_state.py" list >/dev/null

echo "Installed and verified monitoring-aware staging and production pull wrappers without starting or stopping a service."
