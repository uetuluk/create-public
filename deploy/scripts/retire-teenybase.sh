#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_ROOT="${LEGACY_ARCHIVE_ROOT:-${ROOT}/data/legacy-archive}/${STAMP}"

if [[ "${CONFIRM_RETIRE_TEENYBASE:-}" != "retire-teenybase" ]]; then
  echo "This snapshots and removes legacy teenybase-* containers." >&2
  echo "Re-run with CONFIRM_RETIRE_TEENYBASE=retire-teenybase after reviewing the inventory." >&2
  docker ps -a --filter "name=teenybase-" --format '{{.Names}}\t{{.Status}}'
  exit 2
fi

mkdir -p "${ARCHIVE_ROOT}"
docker ps -a --filter "name=teenybase-" --format '{{.Names}}\t{{.Image}}\t{{.Status}}' >"${ARCHIVE_ROOT}/containers.tsv"

if docker ps -a --format '{{.Names}}' | grep -qx 'tb-postgres'; then
  docker exec tb-postgres pg_dumpall -U "${POSTGRES_USER:-postgres}" >"${ARCHIVE_ROOT}/postgres.sql"
fi

if docker ps -a --format '{{.Names}}' | grep -qx 'tb-minio'; then
  docker exec tb-minio sh -c 'find /data -maxdepth 2 -type d -print' >"${ARCHIVE_ROOT}/minio-inventory.txt" || true
fi

while IFS= read -r container; do
  [[ -n "${container}" ]] && docker rm -f "${container}"
done < <(docker ps -aq --filter "name=teenybase-")

echo "Legacy archive written to ${ARCHIVE_ROOT}."
echo "Retain it for 30 days, then remove it through the operator's normal backup lifecycle."
