#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LANG=C.UTF-8
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

if [[ $# -ne 8 \
  || $1 != --archive \
  || $3 != --expected-digest \
  || $5 != --expected-revision \
  || $7 != --expected-verifier-digest ]]; then
  echo "Usage: $0 --archive FILE --expected-digest sha256:HEX --expected-revision FULL_SHA --expected-verifier-digest sha256:HEX" >&2
  exit 2
fi
readonly ARCHIVE=$2
readonly EXPECTED_DIGEST=$4
readonly EXPECTED_REVISION=$6
readonly EXPECTED_VERIFIER_DIGEST=$8
if [[ ! ${EXPECTED_DIGEST} =~ ^sha256:[0-9a-f]{64}$ ]] \
  || [[ ! ${EXPECTED_REVISION} =~ ^[0-9a-f]{40}$ ]] \
  || [[ ! ${EXPECTED_VERIFIER_DIGEST} =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "The approved monitoring payload digest, revision, or fixed-verifier digest is invalid." >&2
  exit 2
fi
if [[ ${EUID} -ne 0 ]]; then
  echo "Monitoring payload materialization must run as root." >&2
  exit 1
fi
if [[ -L ${ARCHIVE} || ! -f ${ARCHIVE} ]]; then
  echo "The monitoring payload archive is absent or unsafe." >&2
  exit 1
fi

# The operator verifies this tiny bootstrap and the fixed verifier against two
# separately approved checksums before installation. The bootstrap repeats both
# checks immediately before invoking that fixed verifier. Candidate payload code
# is never extracted or executed to authenticate itself.
actual=$(/usr/bin/sha256sum --binary "${ARCHIVE}")
actual=${actual%% *}
if [[ sha256:${actual} != "${EXPECTED_DIGEST}" ]]; then
  echo "The monitoring payload archive differs from the approved digest." >&2
  exit 1
fi

readonly SCRIPT_ROOT=$(cd "$(dirname "$0")" && pwd -P)
readonly EXPECTED_SCRIPT_ROOT=/var/lib/esmii/monitoring/payload-bootstrap/infra/monitoring
if [[ ${SCRIPT_ROOT} != "${EXPECTED_SCRIPT_ROOT}" ]]; then
  echo "The monitoring payload bootstrap is not installed at its fixed root-only path." >&2
  exit 1
fi
readonly VERIFIER=${SCRIPT_ROOT}/monitoring_payload.py
if [[ -L ${VERIFIER} || ! -f ${VERIFIER} ]] \
  || [[ $(/usr/bin/stat -c '%u:%g:%a' "${VERIFIER}") != 0:0:700 ]]; then
  echo "The independently installed monitoring payload verifier is absent or unsafe." >&2
  exit 1
fi
actual_verifier=$(/usr/bin/sha256sum --binary "${VERIFIER}")
actual_verifier=${actual_verifier%% *}
if [[ sha256:${actual_verifier} != "${EXPECTED_VERIFIER_DIGEST}" ]]; then
  echo "The fixed monitoring payload verifier differs from the approved digest." >&2
  exit 1
fi
exec /usr/bin/python3 "${VERIFIER}" materialize \
  --archive "${ARCHIVE}" \
  --expected-digest "${EXPECTED_DIGEST}" \
  --expected-revision "${EXPECTED_REVISION}"
