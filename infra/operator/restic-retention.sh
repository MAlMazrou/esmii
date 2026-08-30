#!/bin/sh
set -eu

if [ "${ESMII_RETENTION_CUSTODIAN:-}" != "approved-off-vps" ]; then
  echo "Refusing: use the separately held off-VPS retention identity." >&2
  exit 78
fi

if [ -z "${RESTIC_REPOSITORY:-}" ] || [ -z "${RESTIC_PASSWORD_FILE:-}" ]; then
  echo "Refusing: fixed operator Restic configuration is required." >&2
  exit 78
fi

restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

