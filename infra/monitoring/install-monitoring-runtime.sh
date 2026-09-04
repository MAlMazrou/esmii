#!/usr/bin/env bash

set -Eeuo pipefail
umask 027
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

readonly REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
readonly FIXED_PAYLOAD_VERIFIER=/var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring/monitoring_payload.py

if [[ ${1:-} == --help || $# -eq 0 ]]; then
  echo "Usage: $0 --expected-host-payload-digest DIGEST --expected-host-payload-revision SHA --environment staging|production --dashboard-image DIGEST --prometheus-image DIGEST --source URL --revision SHA --version VERSION" >&2
  exit 2
fi

expected_host_payload_digest=
expected_host_payload_revision=
declare -a render_arguments=()
while [[ $# -gt 0 ]]; do
  case "$1" in
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
      render_arguments+=("$1")
      shift
      ;;
  esac
done
if [[ ! ${expected_host_payload_digest} =~ ^sha256:[0-9a-f]{64}$ ]] \
  || [[ ! ${expected_host_payload_revision} =~ ^[0-9a-f]{40}$ ]]; then
  echo "A reviewed monitoring host payload digest and full revision are required." >&2
  exit 2
fi

# This read-only check uses the independently bootstrapped verifier, never the
# candidate's copy, and must pass before render_monitoring can create its lock
# or write one byte below the live runtime root.
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

# This command deliberately validates only images that are already local. It
# never pulls, starts, reloads, enables, publishes, or contacts an external
# service. Activation remains a separate host-change gate.
exec /usr/bin/python3 "${REPOSITORY_ROOT}/infra/monitoring/render_monitoring.py" \
  "${render_arguments[@]}" \
  --host-payload-digest "${expected_host_payload_digest}" \
  --host-payload-revision "${expected_host_payload_revision}" \
  --source-root "${REPOSITORY_ROOT}/infra" \
  --validate-local-images \
  --validate-host-state
