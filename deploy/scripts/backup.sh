#!/usr/bin/env bash
#
# Off-host backup for the platform.
#
# Runs on the host rather than as a platform job, deliberately: a backup has to
# keep working when the platform is the thing that is broken, and the executor's
# job queue lives in the very database being dumped.
#
# What it captures, per docs/operations.md:
#   - PostgreSQL globals (roles, their grants)
#   - the _platform control database
#   - a custom-format dump of every site_* project database
#   - /data/sources, which cannot be reconstructed from retained artifacts
#   - the RustFS object tree and the Caddy configuration
#
# What it deliberately does NOT capture: the OAuth signing keys and
# SECRET_ENCRYPTION_KEY. Those belong in the operator's secret manager, not in
# an archive that also contains everything they protect. A restore needs them
# supplied separately — see docs/operations.md.
#
# On success it writes an ops_events row, which is what clears the backup_age
# alert. If this script stops running, that alert fires on its own.
set -euo pipefail

ROOT="${RITSDEV_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="${ROOT}/deploy/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing deploy/.env." >&2
  exit 1
fi

# Read only the keys needed, rather than sourcing the file, so a stray line in
# .env cannot execute anything.
read_env() {
  local key="$1" default="${2:-}" value
  value="$(grep -E "^${key}=" "${ENV_FILE}" | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$default}"
}

DATA_HOST_ROOT="$(read_env DATA_HOST_ROOT)"
POSTGRES_USER="$(read_env POSTGRES_USER postgres)"
BACKUP_DEST="$(read_env BACKUP_DEST)"
BACKUP_GPG_RECIPIENT="$(read_env BACKUP_GPG_RECIPIENT)"
BACKUP_KEEP_DAILY="$(read_env BACKUP_KEEP_DAILY 7)"
BACKUP_KEEP_WEEKLY="$(read_env BACKUP_KEEP_WEEKLY 4)"
BACKUP_STAGING="$(read_env BACKUP_STAGING /var/tmp/ritsdev-backup)"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-ritsdev-postgres-1}"
PLATFORM_CONTAINER="${PLATFORM_CONTAINER:-ritsdev-platform-1}"

if [[ -z "${BACKUP_DEST}" ]]; then
  echo "Set BACKUP_DEST in deploy/.env, e.g. BACKUP_DEST=user@nas:/volume1/create-backups" >&2
  exit 1
fi
if [[ -z "${DATA_HOST_ROOT}" ]]; then
  echo "DATA_HOST_ROOT is not set in deploy/.env." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${BACKUP_STAGING}/${STAMP}"
mkdir -p "${WORK}"
chmod 700 "${BACKUP_STAGING}" "${WORK}"

fail() {
  echo "[backup] FAILED: $*" >&2
  record_event failed "$*"
  exit 1
}

# Recorded in the control database so the platform's own alerting can see
# whether backups are actually running. Never fatal: a backup that succeeded
# but could not write its receipt is still a backup.
record_event() {
  local status="$1" detail="${2:-}"
  docker exec -i "${POSTGRES_CONTAINER}" \
    psql -U "${POSTGRES_USER}" -d _platform -v ON_ERROR_STOP=1 -q \
    -c "INSERT INTO ops_events (kind, status, detail) VALUES ('backup', '${status}', jsonb_build_object('stamp', '${STAMP}', 'detail', \$detail\$${detail}\$detail\$))" \
    >/dev/null 2>&1 || echo "[backup] warning: could not record ops_event" >&2
}

trap 'rm -rf "${WORK}"' EXIT

echo "[backup] ${STAMP} starting"

# --- PostgreSQL ------------------------------------------------------------
# Globals first: roles and their attributes are not in any per-database dump,
# and a restore without them leaves every project database ownerless.
docker exec "${POSTGRES_CONTAINER}" pg_dumpall -U "${POSTGRES_USER}" --globals-only \
  | gzip -9 > "${WORK}/globals.sql.gz" || fail "pg_dumpall globals"

docker exec "${POSTGRES_CONTAINER}" pg_dump -U "${POSTGRES_USER}" -Fc _platform \
  > "${WORK}/platform.dump" || fail "pg_dump _platform"

mkdir -p "${WORK}/projects"
mapfile -t DATABASES < <(docker exec "${POSTGRES_CONTAINER}" \
  psql -U "${POSTGRES_USER}" -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'site\\_%'" \
  | tr -d '\r')
for database in "${DATABASES[@]}"; do
  [[ -n "${database}" ]] || continue
  docker exec "${POSTGRES_CONTAINER}" pg_dump -U "${POSTGRES_USER}" -Fc "${database}" \
    > "${WORK}/projects/${database}.dump" || fail "pg_dump ${database}"
done
echo "[backup] dumped ${#DATABASES[@]} project database(s)"

# --- Filesystem trees ------------------------------------------------------
# Archived from inside a container running as root, not directly.
#
# The trees have three different owners: platform is the deployment account,
# rustfs is uid 10001, and caddy is root. Reading them as the deployment account
# fails outright on caddy — and, worse, can half-succeed on the others, walking
# directories it may traverse while skipping files it may not. A backup that is
# quietly missing objects is worse than one that refuses to run, so this reads
# everything with the same privilege the services themselves have.
ALPINE="${BACKUP_ALPINE_IMAGE:-alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1}"

archive_tree() {
  local source="$1" name="$2" expect_min="${3:-1}"
  docker run --rm --user 0:0 --network none \
    -v "${source}:/src:ro" "${ALPINE}" \
    tar -C /src -czf - . > "${WORK}/${name}.tar.gz" || fail "archiving ${name}"
  # A tar that read nothing still exits zero and still produces a small valid
  # gzip. Count the entries and insist there are some.
  local entries
  entries="$(tar -tzf "${WORK}/${name}.tar.gz" 2>/dev/null | wc -l)"
  if (( entries < expect_min )); then
    fail "${name} archive holds ${entries} entries, expected at least ${expect_min}"
  fi
  echo "[backup] ${name}: ${entries} entries"
}

# Source archives are irreplaceable: a version's static artifact cannot be
# turned back into the tree the author uploaded.
archive_tree "${DATA_HOST_ROOT}/platform/sources" sources
archive_tree "${DATA_HOST_ROOT}/rustfs" rustfs
archive_tree "${DATA_HOST_ROOT}/caddy" caddy

# Configuration, minus every secret. .env is excluded on purpose: it holds the
# encryption key for everything else in this archive.
tar -C "${ROOT}" -czf "${WORK}/config.tar.gz" \
  --exclude='.env' --exclude='.env.*' \
  deploy/compose.yaml deploy/Caddyfile deploy/smtp docs skills 2>/dev/null \
  || fail "tar config"

# --- Manifest --------------------------------------------------------------
{
  echo "stamp=${STAMP}"
  echo "host=$(hostname -f)"
  echo "databases=${#DATABASES[@]}"
  echo "platform_head=$(cd "${ROOT}" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "schema_version=$(docker exec "${POSTGRES_CONTAINER}" psql -U "${POSTGRES_USER}" -d _platform -tAc 'SELECT max(version) FROM schema_migrations' 2>/dev/null | tr -d '\r')"
  echo "NOTE: OAuth signing keys and SECRET_ENCRYPTION_KEY are deliberately absent."
} > "${WORK}/MANIFEST"

( cd "${WORK}" && find . -type f ! -name SHA256SUMS -print0 | sort -z \
  | xargs -0 sha256sum > SHA256SUMS ) || fail "checksums"

# --- Encryption ------------------------------------------------------------
# Public-key only: this host can write a backup but cannot read any back, so
# compromising it does not hand over the archive of everything it ever held.
if [[ -n "${BACKUP_GPG_RECIPIENT}" ]]; then
  while IFS= read -r -d '' file; do
    gpg --batch --yes --trust-model always --encrypt \
      --recipient "${BACKUP_GPG_RECIPIENT}" --output "${file}.gpg" "${file}" \
      || fail "gpg encrypt ${file}"
    rm -f "${file}"
  done < <(find "${WORK}" -type f -print0)
  echo "[backup] encrypted to ${BACKUP_GPG_RECIPIENT}"
else
  echo "[backup] WARNING: BACKUP_GPG_RECIPIENT is unset; this backup is unencrypted" >&2
fi

# --- Ship it ---------------------------------------------------------------
# Three transports, because a NAS may offer none of the others:
#
#   rsync://user@host/module/path   the rsync daemon, which is what Synology
#                                   exposes as its Network Backup service and
#                                   what to prefer: no shell needed, and no
#                                   mount that can silently disappear
#   user@host:/path                 rsync over SSH
#   /mnt/nas/path                   a local path, i.e. an SMB or NFS mount
#
SIZE="$(du -sh "${WORK}" | cut -f1)"
case "${BACKUP_DEST}" in
  rsync://*) MODE=daemon ;;
  *:*)       MODE=ssh ;;
  *)         MODE=local ;;
esac

if [[ "${MODE}" == daemon ]]; then
  # Password via the environment, never argv, and read from a file so it is not
  # in deploy/.env beside the data it protects.
  if [[ -n "${BACKUP_RSYNC_PASSWORD_FILE:-$(read_env BACKUP_RSYNC_PASSWORD_FILE)}" ]]; then
    PW_FILE="${BACKUP_RSYNC_PASSWORD_FILE:-$(read_env BACKUP_RSYNC_PASSWORD_FILE)}"
    [[ -r "${PW_FILE}" ]] || fail "cannot read ${PW_FILE}"
    RSYNC_PASSWORD="$(<"${PW_FILE}")"
    export RSYNC_PASSWORD
  fi
  # rsync creates the final directory of a transfer but not its parents, and
  # --mkpath, which would, needs rsync 3.2.3+ at the *receiver* — a NAS is
  # unlikely to have it. So the path inside the module is created first by
  # sending a scaffold of directories and nothing else: the filters include
  # every directory and exclude every file, so this creates structure and
  # transfers no content. No --delete, so it cannot disturb what is there.
  AUTHORITY="${BACKUP_DEST#rsync://}"
  MODULE_AND_PATH="${AUTHORITY#*/}"
  AUTHORITY="${AUTHORITY%%/*}"
  MODULE="${MODULE_AND_PATH%%/*}"
  SUBPATH="${MODULE_AND_PATH#"${MODULE}"}"
  SUBPATH="${SUBPATH#/}"
  if [[ -n "${SUBPATH}" ]]; then
    SCAFFOLD="$(mktemp -d)"
    mkdir -p "${SCAFFOLD}/${SUBPATH}"
    rsync -a -f'+ */' -f'- *' "${SCAFFOLD}/" "rsync://${AUTHORITY}/${MODULE}/" \
      || fail "creating ${SUBPATH} in module ${MODULE}"
    rm -rf "${SCAFFOLD}"
  fi
elif [[ "${MODE}" == local ]]; then
  # A mount that quietly failed would send every backup to this host's own disk
  # while appearing to succeed — the exact failure this whole exercise exists to
  # prevent. Refuse rather than write to the empty mountpoint.
  if [[ "$(read_env BACKUP_REQUIRE_MOUNT 1)" == "1" ]]; then
    mountpoint -q "${BACKUP_DEST}" \
      || fail "${BACKUP_DEST} is not a mount point; refusing to back up onto this host"
  fi
  mkdir -p "${BACKUP_DEST}/${STAMP}"
else
  # Created explicitly rather than with rsync --mkpath, which needs rsync
  # 3.2.3+; appliance firmware ships something older.
  ssh "${BACKUP_DEST%%:*}" "mkdir -p '${BACKUP_DEST#*:}/${STAMP}'" || fail "mkdir at ${BACKUP_DEST}"
fi

rsync -a "${WORK}/" "${BACKUP_DEST%/}/${STAMP}/" || fail "rsync to ${BACKUP_DEST}"

# --- Retention -------------------------------------------------------------
# The keep/delete decision is computed *here*, not on the destination, and the
# destination is only ever asked to remove an explicit list of directory names.
#
# That split is deliberate. Appliance NAS firmware runs busybox for most
# coreutils, where `date -d` and several flags used to bucket sets by ISO week
# do not exist. A retention pass that half-works on the far side is the worst
# possible outcome, because its job is deleting things.
#
# Set BACKUP_PRUNE_DRY_RUN=1 to print what would be removed and delete nothing.
list_sets() {
  case "${MODE}" in
    daemon) rsync "${BACKUP_DEST%/}/" 2>/dev/null | awk '$1 ~ /^d/ {print $NF}' || true ;;
    ssh)    ssh "${BACKUP_DEST%%:*}" "ls -1 '${BACKUP_DEST#*:}' 2>/dev/null" || true ;;
    local)  ls -1 "${BACKUP_DEST}" 2>/dev/null || true ;;
  esac
}

mapfile -t ALL < <(list_sets | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort)
KEEP_FILE="$(mktemp)"
trap 'rm -rf "${WORK}" "${KEEP_FILE}"' EXIT

# Dailies: the most recent N sets, whenever they ran.
printf '%s\n' "${ALL[@]}" | tail -n "${BACKUP_KEEP_DAILY}" >> "${KEEP_FILE}"
# Weeklies: the last set in each ISO week, for the most recent N weeks. GNU date
# here on the host, which is exactly why this is not computed at the far end.
for set_name in "${ALL[@]}"; do
  day="${set_name:0:8}"
  week="$(date -u -d "${day}" +%G-%V 2>/dev/null || true)"
  [[ -n "${week}" ]] && printf '%s %s\n' "${week}" "${set_name}"
done | sort | awk '{latest[$1] = $2} END {for (w in latest) print latest[w]}' \
     | sort | tail -n "${BACKUP_KEEP_WEEKLY}" >> "${KEEP_FILE}"

sort -u "${KEEP_FILE}" -o "${KEEP_FILE}"

mapfile -t DOOMED < <(
  for set_name in "${ALL[@]}"; do
    grep -Fxq "${set_name}" "${KEEP_FILE}" || echo "${set_name}"
  done
)

if (( ${#DOOMED[@]} )); then
  # A guard, not a formality. Every branch below is capable of removing every
  # backup that exists, and an empty keep-list is the shape a bug takes — a
  # failed listing, a bad date, a truncated file. Refuse rather than proceed.
  if [[ ! -s "${KEEP_FILE}" ]]; then
    echo "[backup] refusing to prune: the keep-list is empty, which should be impossible" >&2
  elif [[ "${BACKUP_PRUNE_DRY_RUN:-0}" == "1" ]]; then
    printf '[backup] would prune %s\n' "${DOOMED[@]}"
  else
    case "${MODE}" in
      daemon)
        # The rsync daemon offers no shell, so deletion is expressed as a
        # mirror of the top level only: `-d` compares just the directory
        # entries and does not descend, so a set that appears in both sides is
        # matched and left entirely alone, while one that appears only at the
        # destination is extraneous and removed. --force is what allows
        # removing a directory that still has contents.
        MIRROR="$(mktemp -d)"
        for set_name in "${ALL[@]}"; do
          grep -Fxq "${set_name}" "${KEEP_FILE}" && mkdir -p "${MIRROR}/${set_name}"
        done
        rsync -d --delete --force --omit-dir-times "${MIRROR}/" "${BACKUP_DEST%/}/" \
          || echo "[backup] warning: retention pass failed" >&2
        rm -rf "${MIRROR}"
        ;;
      ssh)
        for set_name in "${DOOMED[@]}"; do
          ssh "${BACKUP_DEST%%:*}" "rm -rf -- '${BACKUP_DEST#*:}/${set_name}'" \
            || echo "[backup] warning: could not prune ${set_name}" >&2
        done
        ;;
      local)
        for set_name in "${DOOMED[@]}"; do
          rm -rf -- "${BACKUP_DEST:?}/${set_name}"
        done
        ;;
    esac
    echo "[backup] pruned ${#DOOMED[@]} old set(s)"
  fi
fi

record_event success "size=${SIZE} databases=${#DATABASES[@]}"
echo "[backup] ${STAMP} complete (${SIZE}) -> ${BACKUP_DEST}/${STAMP}"
