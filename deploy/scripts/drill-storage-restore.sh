#!/usr/bin/env bash
#
# Restore drill for the object storage half of a backup set.
#
# The database half is proven: docs/operations.md carries a procedure that was
# run end to end on 2026-08-04. It never touched rustfs.tar.gz, so nothing has
# confirmed that the object archive decrypts, extracts, and yields a bucket
# RustFS will actually serve. This closes that, on the same terms.
#
# What it does that a count of objects does not:
#
#   * Compares every object by size and by the SHA-256 of its body, on both
#     sides, read over S3. An empty object of the right name passes a count and
#     fails here.
#   * Serves the restored tree from a real RustFS process and does the reading
#     through it. That is the only honest way: RustFS stores an object as
#     <key>/xl.meta and inlines small bodies into that metadata, so a file that
#     exists in the extracted tree says nothing about whether RustFS can decode
#     it and hand it back. A GET does.
#   * Fails when its evidence is missing. A live listing that could not be
#     obtained, a SHA256SUMS with no rustfs.tar.gz line, a scratch instance that
#     never became ready, or zero objects compared are all FAIL, never a quiet
#     pass. This repository has already shipped three gates that went green on
#     absent evidence.
#
# Where it refuses to go:
#
#   * It never decrypts. The GPG private key is not on this host and must not be
#     put here — that property is what makes an off-host backup worth having.
#     This script stages the encrypted files, tells you exactly what to run on
#     the machine that holds the key, and picks up from the plaintext you hand
#     back. It also checks that no secret key for the backup recipient has
#     appeared here.
#   * It never writes into the live object tree. The archive is extracted into
#     scratch space and served by a throwaway RustFS container in an isolated
#     network namespace, reachable by nothing else on the host.
#   * It writes nothing at all without --execute.
#
# Usage:
#   deploy/scripts/drill-storage-restore.sh                       # read-only status and plan
#   deploy/scripts/drill-storage-restore.sh --set <stamp> --stage --execute
#   deploy/scripts/drill-storage-restore.sh --verify --execute
#   deploy/scripts/drill-storage-restore.sh --verify --execute --bucket site-<uuid>
#
# Run it on the infrastructure host as a user in the docker group. Like
# gate-capacity.sh, everything needing a credential runs inside a container that
# already holds it, so no RustFS key is ever in this host's process list.
set -euo pipefail

ROOT="${RITSDEV_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="${ROOT}/deploy/.env"

SCRATCH="${DRILL_SCRATCH:-/var/tmp/ritsdev-storage-drill}"
DRILL_CONTAINER="${DRILL_CONTAINER:-ritsdev-storage-drill}"
EXECUTOR_CONTAINER="${EXECUTOR_CONTAINER:-ritsdev-executor-1}"
RUSTFS_CONTAINER="${RUSTFS_CONTAINER:-ritsdev-rustfs}"
MC_IMAGE="${DRILL_MC_IMAGE:-ritsdev-platform:local}"
ALPINE="${BACKUP_ALPINE_IMAGE:-alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1}"
# Enough headroom for the extracted tree plus RustFS's own working files. The
# archive is small today; the floor is what stops a future one filling the disk.
MIN_DISK_MB="${DRILL_MIN_DISK_MB:-2048}"
MIN_AVAIL_MB="${DRILL_MIN_AVAIL_MB:-600}"

SET_STAMP=""
DO_STAGE=0
DO_VERIFY=0
EXECUTE=0
KEEP=0
ONLY_BUCKET=""

usage() {
    sed -n '3,47p' "$0" | sed 's/^#\{1\} \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --set) SET_STAMP="$2"; shift 2 ;;
        --set=*) SET_STAMP="${1#*=}"; shift ;;
        --bucket) ONLY_BUCKET="$2"; shift 2 ;;
        --bucket=*) ONLY_BUCKET="${1#*=}"; shift ;;
        --scratch) SCRATCH="$2"; shift 2 ;;
        --scratch=*) SCRATCH="${1#*=}"; shift ;;
        --stage) DO_STAGE=1; shift ;;
        --verify) DO_VERIFY=1; shift ;;
        --execute) EXECUTE=1; shift ;;
        --keep) KEEP=1; shift ;;
        -h|--help) usage 0 ;;
        *) echo "unknown option: $1" >&2; usage 2 ;;
    esac
done

ENC="${SCRATCH}/enc"
PLAIN="${SCRATCH}/plain"
TREE="${SCRATCH}/tree"
WORK="${SCRATCH}/work"

PASSED=0
FAILED=0

pass() { printf 'PASS  %-34s %s\n' "$1" "${2-}"; PASSED=$((PASSED + 1)); }
fail() { printf 'FAIL  %-34s %s\n' "$1" "${2-}"; FAILED=$((FAILED + 1)); }
note() { printf '      %s\n' "$1"; }
say()  { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# Read one key out of deploy/.env rather than sourcing it, as backup.sh does, so
# a stray line in that file cannot execute anything. Values are used and never
# printed.
read_env() {
    local key="$1" default="${2:-}" value
    [ -f "${ENV_FILE}" ] || { printf '%s' "${default}"; return; }
    value="$(grep -E "^${key}=" "${ENV_FILE}" | tail -1 | cut -d= -f2- || true)"
    printf '%s' "${value:-$default}"
}

randhex() { head -c "${1:-16}" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# ---------------------------------------------------------------------------
# The inventory driver
#
# One script, run on both sides. It lists a bucket over S3 and streams every
# object body through SHA-256, emitting one TSV row per object. It runs inside a
# container that already holds the RustFS credentials — inside ritsdev-executor-1
# for the live side, and inside a throwaway container sharing the scratch
# instance's network namespace for the restored side — so the keys are never in
# this host's argv or environment.
#
# A key containing a tab or a newline would silently corrupt the comparison, so
# the driver refuses one rather than emitting a row that reads as something else.
# ---------------------------------------------------------------------------
inventory_driver() {
    cat <<'DRIVER'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'

const CONFIG_DIR = '/tmp/mc-storage-drill'
const ONLY = process.env.DRILL_BUCKET || ''
const endpoint = process.env.RUSTFS_ENDPOINT || 'http://rustfs:9000'
const url = new URL(endpoint)
url.username = encodeURIComponent(process.env.RUSTFS_ACCESS_KEY)
url.password = encodeURIComponent(process.env.RUSTFS_SECRET_KEY)
const env = {
    PATH: process.env.PATH,
    HOME: '/tmp',
    MC_HOST_drill: url.toString(),
    MC_CONFIG_DIR: CONFIG_DIR,
}

function mc(args, onStdout) {
    return new Promise((resolve, reject) => {
        const child = spawn('mc', ['--config-dir', CONFIG_DIR, ...args], {env})
        let err = ''
        child.stdout.on('data', onStdout)
        child.stderr.on('data', d => { err += d.toString() })
        child.on('error', reject)
        child.on('close', code => code === 0
            ? resolve()
            : reject(new Error(`mc ${args.join(' ')} exited ${code}: ${err.slice(0, 400)}`)))
    })
}

async function lines(args) {
    let buffer = ''
    const out = []
    await mc(args, d => {
        buffer += d.toString()
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim()
            buffer = buffer.slice(index + 1)
            if (line) out.push(JSON.parse(line))
        }
    })
    if (buffer.trim()) out.push(JSON.parse(buffer.trim()))
    return out
}

const buckets = (await lines(['ls', '--json', 'drill/']))
    .filter(row => row.status === 'success')
    .map(row => String(row.key).replace(/\/$/, ''))
    .filter(name => !ONLY || name === ONLY)
    .sort()

for (const bucket of buckets) process.stdout.write(`BUCKET\t${bucket}\n`)

for (const bucket of buckets) {
    const objects = (await lines(['ls', '--recursive', '--json', `drill/${bucket}/`]))
        .filter(row => row.status === 'success' && row.type === 'file')
    for (const object of objects) {
        const key = String(object.key)
        if (/[\t\n]/.test(key)) throw new Error(`key contains a tab or newline: ${JSON.stringify(key)}`)
        const hash = createHash('sha256')
        let bytes = 0
        // Streamed rather than buffered: an object large enough to exhaust
        // memory must still be hashed, and a truncated read must not look like
        // a match.
        await mc(['cat', `drill/${bucket}/${key}`], d => { hash.update(d); bytes += d.length })
        if (bytes !== Number(object.size)) {
            throw new Error(`${bucket}/${key}: listing says ${object.size} bytes, GET returned ${bytes}`)
        }
        process.stdout.write([
            'OBJECT', bucket, key, bytes, hash.digest('hex'), object.lastModified,
        ].join('\t') + '\n')
    }
}
DRIVER
}

live_inventory() {
    inventory_driver | docker exec -i -e DRILL_BUCKET="${ONLY_BUCKET}" \
        "${EXECUTOR_CONTAINER}" node --input-type=module
}

restored_inventory() {
    inventory_driver | docker run --rm -i \
        --network "container:${DRILL_CONTAINER}" \
        --env-file "${WORK}/scratch.env" \
        -e DRILL_BUCKET="${ONLY_BUCKET}" \
        -e RUSTFS_ENDPOINT=http://127.0.0.1:9000 \
        --entrypoint node "${MC_IMAGE}" --input-type=module
}

# ---------------------------------------------------------------------------
# Pre-flight. Read-only, and it runs in every mode.
# ---------------------------------------------------------------------------

DATA_HOST_ROOT="$(read_env DATA_HOST_ROOT)"
BACKUP_DEST="$(read_env BACKUP_DEST)"
BACKUP_GPG_RECIPIENT="$(read_env BACKUP_GPG_RECIPIENT)"
BACKUP_RSYNC_PASSWORD_FILE="$(read_env BACKUP_RSYNC_PASSWORD_FILE)"

echo "Object storage restore drill"
echo "  scratch:   ${SCRATCH}"
echo "  live:      ${RUSTFS_CONTAINER} via ${EXECUTOR_CONTAINER}"
echo "  set:       ${SET_STAMP:-<none given>}"
echo "  mode:      $([ "${EXECUTE}" = 1 ] && echo 'EXECUTE — this run writes' || echo 'dry run — nothing is written')"
echo

echo "-- pre-flight"

for container in "${EXECUTOR_CONTAINER}" "${RUSTFS_CONTAINER}"; do
    if [ "$(docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null || echo false)" = true ]; then
        pass "container running" "${container}"
    else
        fail "container running" "${container} is not running; the live side cannot be read"
    fi
done

if docker exec "${EXECUTOR_CONTAINER}" mc --version >/dev/null 2>&1; then
    pass "mc available" "in ${EXECUTOR_CONTAINER}"
else
    fail "mc available" "no mc in ${EXECUTOR_CONTAINER}"
fi

if docker image inspect "${MC_IMAGE}" >/dev/null 2>&1; then
    pass "drill image present" "${MC_IMAGE}"
else
    fail "drill image present" "${MC_IMAGE} is not on this host"
fi

# The scratch tree must not be anywhere RustFS serves to tenants. Checked rather
# than assumed, because --scratch takes an arbitrary path.
if [ -n "${DATA_HOST_ROOT}" ] && case "${SCRATCH}/" in "${DATA_HOST_ROOT%/}/"*) true ;; *) false ;; esac; then
    fail "scratch is outside live data" "refusing: ${SCRATCH} is inside the live data root"
else
    pass "scratch is outside live data" "${SCRATCH}"
fi

if docker inspect "${DRILL_CONTAINER}" >/dev/null 2>&1; then
    fail "drill container name is free" "${DRILL_CONTAINER} already exists; remove it before drilling"
else
    pass "drill container name is free" "${DRILL_CONTAINER}"
fi

# The whole point of the off-host design. If a private key for the backup
# recipient has appeared on this machine, the backup is no longer protected from
# whoever takes this host, and that matters more than the drill's outcome.
if [ -z "${BACKUP_GPG_RECIPIENT}" ]; then
    fail "no private key on this host" "BACKUP_GPG_RECIPIENT is unset in deploy/.env; cannot check"
elif ! command -v gpg >/dev/null 2>&1; then
    fail "no private key on this host" "gpg is not installed here; cannot check"
elif gpg --batch --list-secret-keys "${BACKUP_GPG_RECIPIENT}" >/dev/null 2>&1; then
    fail "no private key on this host" "a secret key for the backup recipient is present here — remove it"
else
    pass "no private key on this host" "decryption still has to happen elsewhere"
fi

DISK_MB="$(df -Pm "$(dirname "${SCRATCH}")" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "${DISK_MB}" ] && [ "${DISK_MB}" -ge "${MIN_DISK_MB}" ]; then
    pass "disk for scratch" "${DISK_MB} MB free"
else
    fail "disk for scratch" "${DISK_MB:-unknown} MB free, want ${MIN_DISK_MB}"
fi

AVAIL_MB="$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "${AVAIL_MB}" -ge "${MIN_AVAIL_MB}" ]; then
    pass "memory for a second RustFS" "${AVAIL_MB} MB available"
else
    fail "memory for a second RustFS" "${AVAIL_MB} MB available, want ${MIN_AVAIL_MB}"
fi

# The live inventory is evidence, not decoration: without it there is nothing to
# compare against, and a drill that "passed" against an empty listing would be
# the exact failure this script exists to avoid. It is held in memory rather
# than written out, so that a run without --execute really does only read.
LIVE_TSV_DATA=""
LIVE_OK=0
LIVE_RAW=""
if [ "${FAILED}" -eq 0 ]; then
    # Rows are taken by shape, not by stream: mc prints notices of its own, and
    # one of those landing in the inventory would read as an object.
    if LIVE_RAW="$(live_inventory 2>&1)"; then
        LIVE_TSV_DATA="$(printf '%s\n' "${LIVE_RAW}" | grep -E "^(BUCKET|OBJECT)$(printf '\t')" || true)"
        LIVE_OK=1
        pass "live inventory read" \
            "$(printf '%s\n' "${LIVE_TSV_DATA}" | grep -c '^BUCKET' || true) bucket(s), $(printf '%s\n' "${LIVE_TSV_DATA}" | grep -c '^OBJECT' || true) object(s)"
    else
        fail "live inventory read" "$(printf '%s\n' "${LIVE_RAW}" | tail -1 | cut -c1-160)"
    fi
else
    fail "live inventory read" "skipped because pre-flight already failed — treated as missing evidence"
fi

if [ "${LIVE_OK}" = 1 ]; then
    while IFS=$'\t' read -r _ bucket; do
        note "live bucket ${bucket}"
    done < <(printf '%s\n' "${LIVE_TSV_DATA}" | grep '^BUCKET' || true)
fi
echo

# ---------------------------------------------------------------------------
# Staging: encrypted files only, from the backup destination.
# ---------------------------------------------------------------------------

stage_files() {
    local mode dest_root
    case "${BACKUP_DEST}" in
        rsync://*) mode=daemon ;;
        *:*)       mode=ssh ;;
        *)         mode=local ;;
    esac
    dest_root="${BACKUP_DEST%/}/${SET_STAMP}"

    local -a rsync_opts=(-a)
    if [ "${mode}" = daemon ]; then
        [ -r "${BACKUP_RSYNC_PASSWORD_FILE}" ] || {
            fail "stage" "cannot read BACKUP_RSYNC_PASSWORD_FILE"
            return 1
        }
        rsync_opts+=(--password-file="${BACKUP_RSYNC_PASSWORD_FILE}")
    fi

    mkdir -p "${ENC}" "${PLAIN}" "${WORK}"
    chmod 700 "${SCRATCH}" "${ENC}" "${PLAIN}" "${WORK}"
    local file ok=1
    for file in SHA256SUMS.gpg MANIFEST.gpg rustfs.tar.gz.gpg; do
        if rsync "${rsync_opts[@]}" "${dest_root}/${file}" "${ENC}/" 2>"${WORK}/rsync.err"; then
            note "staged ${file} ($(stat -c %s "${ENC}/${file}") bytes)"
        else
            fail "stage ${file}" "$(tail -1 "${WORK}/rsync.err" | cut -c1-160)"
            ok=0
        fi
    done
    rm -f "${WORK}/rsync.err"
    [ "${ok}" = 1 ] && pass "stage" "3 encrypted files in ${ENC}"
    return 0
}

if [ "${DO_STAGE}" = 1 ]; then
    echo "-- stage"
    if [ -z "${SET_STAMP}" ]; then
        fail "stage" "--stage needs --set <stamp>"
    elif [ -z "${BACKUP_DEST}" ]; then
        fail "stage" "BACKUP_DEST is not set in deploy/.env"
    elif [ "${EXECUTE}" != 1 ]; then
        note "would copy SHA256SUMS.gpg, MANIFEST.gpg and rustfs.tar.gz.gpg"
        note "from the ${SET_STAMP} set into ${ENC}"
        note "re-run with --execute to do it"
    else
        stage_files || true
    fi
    echo
fi

# ---------------------------------------------------------------------------
# The handoff. This is the boundary: encrypted goes out, plaintext comes back,
# and the key stays where it is.
# ---------------------------------------------------------------------------

print_handoff() {
    cat <<EOF
Decrypt on the machine that holds the private key, not here:

  scp 'create:${ENC}/*.gpg' .
  for f in *.gpg; do gpg --decrypt --output "\${f%.gpg}" "\$f"; done
  scp SHA256SUMS MANIFEST rustfs.tar.gz create:${PLAIN}/

Then, back on this host:

  $0 --verify --execute
EOF
}

# ---------------------------------------------------------------------------
# Verify: checksum, extract, serve, compare.
# ---------------------------------------------------------------------------

teardown() {
    # The extracted tree belongs to uid 10001, so removing it needs the same
    # privilege that created it. The plaintext is a copy of tenant data and is
    # shredded rather than unlinked.
    docker rm -f "${DRILL_CONTAINER}" >/dev/null 2>&1 || true
    if [ "${KEEP}" = 1 ]; then
        note "--keep: left ${SCRATCH} in place. It holds plaintext tenant data; remove it."
        return
    fi
    if [ -d "${TREE}" ]; then
        docker run --rm --user 0:0 --network none -v "${SCRATCH}:/scratch" "${ALPINE}" \
            rm -rf /scratch/tree >/dev/null 2>&1 || true
    fi
    find "${PLAIN}" "${ENC}" -type f -exec shred -u {} \; 2>/dev/null || true
    rm -rf "${SCRATCH}" 2>/dev/null || true
}

verify() {
    local stamp="" iso_stamp=""

    # --- checksum ----------------------------------------------------------
    if [ ! -f "${PLAIN}/rustfs.tar.gz" ] || [ ! -f "${PLAIN}/SHA256SUMS" ]; then
        fail "plaintext handed over" "need ${PLAIN}/rustfs.tar.gz and ${PLAIN}/SHA256SUMS"
        echo
        print_handoff
        return
    fi
    pass "plaintext handed over" "rustfs.tar.gz $(stat -c %s "${PLAIN}/rustfs.tar.gz") bytes"

    local sums
    sums="$(grep -E '[[:space:]]\.?/?rustfs\.tar\.gz$' "${PLAIN}/SHA256SUMS" || true)"
    if [ "$(printf '%s\n' "${sums}" | grep -c . || true)" != 1 ]; then
        fail "checksum" "SHA256SUMS has no single rustfs.tar.gz line — no evidence either way"
        return
    fi
    printf '%s\n' "${sums}" > "${WORK}/rustfs.sums"
    if (cd "${PLAIN}" && sha256sum -c "${WORK}/rustfs.sums" >/dev/null 2>&1); then
        pass "checksum" "rustfs.tar.gz matches SHA256SUMS"
    else
        fail "checksum" "rustfs.tar.gz does not match SHA256SUMS"
        return
    fi

    # --- the stamp ---------------------------------------------------------
    # Needed to tell a backup gap from an object that simply did not exist yet.
    # Without it every live object newer than the set looks like data the backup
    # lost, so refuse rather than guess.
    if [ -f "${PLAIN}/MANIFEST" ]; then
        stamp="$(grep -E '^stamp=' "${PLAIN}/MANIFEST" | tail -1 | cut -d= -f2- || true)"
    fi
    [ -n "${stamp}" ] || stamp="${SET_STAMP}"
    if printf '%s' "${stamp}" | grep -qE '^[0-9]{8}T[0-9]{6}Z$'; then
        iso_stamp="${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z"
        pass "backup stamp known" "${stamp}"
    else
        fail "backup stamp known" "no stamp= in MANIFEST and no usable --set; cannot date the comparison"
        return
    fi

    # --- extract -----------------------------------------------------------
    # Through a root container, the way backup.sh archived it. The tree is owned
    # by uid 10001 and the deployment account cannot recreate that ownership,
    # which RustFS needs in order to open its own files.
    mkdir -p "${TREE}"
    if docker run --rm --user 0:0 --network none \
        -v "${PLAIN}:/src:ro" -v "${TREE}:/dst" "${ALPINE}" \
        tar -C /dst -xzf /src/rustfs.tar.gz >"${WORK}/tar.err" 2>&1; then
        pass "extract" "$(docker run --rm --user 0:0 --network none -v "${TREE}:/dst:ro" "${ALPINE}" \
            sh -c 'find /dst -mindepth 1 -maxdepth 1 | wc -l') top-level entries"
    else
        fail "extract" "$(tail -1 "${WORK}/tar.err" | cut -c1-160)"
        return
    fi

    # --- serve it ----------------------------------------------------------
    # A second RustFS on the restored tree, with throwaway root credentials of
    # its own and --network none, so it is reachable only from inside its own
    # namespace and can reach nothing.
    #
    # The credentials are generated here rather than taken from the live
    # instance for two reasons: passing the real ones would put them in this
    # host's process list, and a real disaster recovery does not have them in
    # the archive anyway — deploy/.env is deliberately excluded, so the operator
    # supplies root credentials from the secret manager exactly like this.
    umask 077
    {
        echo "RUSTFS_ADDRESS=:9000"
        echo "RUSTFS_CONSOLE_ENABLE=false"
        echo "RUSTFS_ACCESS_KEY=drill$(randhex 8)"
        echo "RUSTFS_SECRET_KEY=$(randhex 24)"
    } > "${WORK}/scratch.env"

    # The image the live instance is actually running, by id, so this drills the
    # RustFS in production rather than whatever a tag points at today.
    local rustfs_image
    rustfs_image="$(docker inspect -f '{{.Image}}' "${RUSTFS_CONTAINER}" 2>/dev/null || true)"
    if [ -z "${rustfs_image}" ]; then
        fail "scratch RustFS started" "cannot read the live RustFS image id"
        return
    fi

    if ! docker run -d --name "${DRILL_CONTAINER}" \
        --network none --user 10001:10001 \
        --env-file "${WORK}/scratch.env" \
        -v "${TREE}:/data" \
        --memory 512m --pids-limit 256 \
        --security-opt no-new-privileges:true \
        --label ritsdev-drill=storage \
        "${rustfs_image}" /data >/dev/null 2>"${WORK}/run.err"; then
        fail "scratch RustFS started" "$(tail -1 "${WORK}/run.err" | cut -c1-160)"
        return
    fi

    local ready=0
    for _ in $(seq 1 60); do
        if docker exec "${DRILL_CONTAINER}" \
            curl --fail --silent http://127.0.0.1:9000/minio/health/ready >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 2
    done
    if [ "${ready}" = 1 ]; then
        pass "scratch RustFS serving" "ready on the restored tree, isolated network namespace"
    else
        fail "scratch RustFS serving" "never became ready; last log lines below"
        docker logs --tail 15 "${DRILL_CONTAINER}" 2>&1 | sed 's/^/      /' || true
        note "if this is an IAM or credential error rather than a data error, that is"
        note "itself a finding: it means a real restore needs something the archive"
        note "does not carry. Record it on the issue."
        return
    fi

    # --- compare -----------------------------------------------------------
    local restored_tsv="${WORK}/restored.tsv"
    if restored_inventory > "${WORK}/restored.raw" 2>&1; then
        grep -E "^(BUCKET|OBJECT)$(printf '\t')" "${WORK}/restored.raw" > "${restored_tsv}" || true
        pass "restored inventory read" \
            "$(grep -c '^BUCKET' "${restored_tsv}" || true) bucket(s), $(grep -c '^OBJECT' "${restored_tsv}" || true) object(s)"
    else
        fail "restored inventory read" "$(tail -1 "${WORK}/restored.raw" | cut -c1-160)"
        return
    fi

    if [ "${LIVE_OK}" != 1 ]; then
        fail "comparison" "no live inventory to compare against"
        return
    fi
    local live_tsv="${WORK}/live.tsv"
    printf '%s\n' "${LIVE_TSV_DATA}" > "${live_tsv}"

    # Every object is classified, and the report prints the classification
    # rather than a verdict. `same` needs identical size AND identical SHA-256 of
    # the body as served.
    awk -F'\t' -v stamp="${iso_stamp}" '
        FNR == NR {
            if ($1 == "OBJECT") { rsize[$2 "/" $3] = $4; rhash[$2 "/" $3] = $5; seen[$2 "/" $3] = 1 }
            if ($1 == "BUCKET") rbucket[$2] = 1
            next
        }
        $1 == "BUCKET" { lbucket[$2] = 1; next }
        $1 == "OBJECT" {
            id = $2 "/" $3
            live[id] = 1
            if (id in seen) {
                if (rsize[id] == $4 && rhash[id] == $5) { same++; printf "same\t%s\t%s bytes\n", id, $4 }
                else { differ++; printf "differ\t%s\tlive %s/%s restored %s/%s\n", id, $4, substr($5,1,12), rsize[id], substr(rhash[id],1,12) }
            } else if ($6 > stamp) {
                newer++; printf "newer\t%s\tcreated after the backup\n", id
            } else {
                gap++; printf "gap\t%s\tolder than the backup and absent from it\n", id
            }
            next
        }
        END {
            for (id in seen) if (!(id in live)) { gone++; printf "gone\t%s\tin the archive, not live now\n", id }
            for (b in rbucket) if (!(b in lbucket)) { bgone++; printf "bucket-gone\t%s\tin the archive, not live now\n", b }
            for (b in lbucket) if (!(b in rbucket)) { bnew++; printf "bucket-new\t%s\tnot in the archive\n", b }
            printf "TOTALS\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
                same + 0, differ + 0, gap + 0, newer + 0, gone + 0, bgone + 0, bnew + 0
        }
    ' "${restored_tsv}" "${live_tsv}" > "${WORK}/compare.tsv"

    grep -v '^TOTALS' "${WORK}/compare.tsv" | while IFS=$'\t' read -r kind id detail; do
        note "$(printf '%-11s %-58s %s' "${kind}" "${id}" "${detail}")"
    done

    local same differ gap newer gone bgone bnew
    IFS=$'\t' read -r _ same differ gap newer gone bgone bnew < <(grep '^TOTALS' "${WORK}/compare.tsv")

    # Zero objects compared is the failure mode this drill was written for: an
    # empty listing on either side would otherwise report a clean run.
    if [ "${same}" -eq 0 ] && [ "${differ}" -eq 0 ]; then
        fail "objects compared" "nothing was compared byte for byte — this drill proved nothing"
    else
        pass "objects compared" "${same} identical, ${differ} differing"
    fi
    if [ "${differ}" -eq 0 ]; then
        pass "content identical" "size and SHA-256 match on every object compared"
    else
        fail "content identical" "${differ} object(s) differ between the archive and live"
    fi
    if [ "${gap}" -eq 0 ]; then
        pass "no backup gap" "every live object older than the set is in the archive"
    else
        fail "no backup gap" "${gap} object(s) predate the set and are missing from it"
    fi

    COMPARED_LINE="Compared ${same} object(s) byte for byte in $(grep -c '^BUCKET' "${restored_tsv}" || true) archived bucket(s): size and SHA-256 of the body as served over S3 by a RustFS started on the restored tree, against the same read from the live instance. ${differ} differed, ${gap} live object(s) older than the set were missing from it, ${newer} live object(s) postdate the set, ${gone} archived object(s) no longer exist live, ${bgone} archived bucket(s) are gone and ${bnew} live bucket(s) postdate the set."
}

if [ "${DO_VERIFY}" = 1 ]; then
    echo "-- verify"
    if [ "${EXECUTE}" != 1 ]; then
        note "would verify rustfs.tar.gz against SHA256SUMS, extract it into ${TREE},"
        note "start ${DRILL_CONTAINER} on that tree with --network none and throwaway"
        note "root credentials, list and GET every object through it, and compare each"
        note "one by size and SHA-256 with the live instance."
        note "re-run with --execute to do it"
        if [ ! -f "${PLAIN}/rustfs.tar.gz" ]; then
            echo
            print_handoff
        fi
    else
        mkdir -p "${ENC}" "${PLAIN}" "${WORK}"
        chmod 700 "${SCRATCH}" "${ENC}" "${PLAIN}" "${WORK}"
        trap teardown EXIT
        verify
    fi
    echo
fi

if [ "${DO_STAGE}" = 0 ] && [ "${DO_VERIFY}" = 0 ]; then
    echo "-- plan"
    note "nothing was asked for. The drill runs in three moves:"
    note "  1. $0 --set <stamp> --stage --execute"
    note "  2. decrypt on the machine holding the private key (it prints the commands)"
    note "  3. $0 --verify --execute"
    if [ -n "${BACKUP_DEST}" ]; then
        note "available sets are listed by the rsync command in docs/operations.md"
    fi
    echo
fi

# ---------------------------------------------------------------------------
# What this run does and does not establish. This is the paragraph that goes on
# the issue, so it is printed whether the run passed or failed.
# ---------------------------------------------------------------------------

echo "${PASSED} passed, ${FAILED} failed.$([ "${EXECUTE}" = 1 ] || echo ' Dry run: pre-flight only, nothing was written.')"
echo
if [ -n "${COMPARED_LINE:-}" ]; then
    echo "Compared:"
    printf '  %s\n' "${COMPARED_LINE}"
else
    echo "Compared: nothing. This run did not reach the comparison."
fi
cat <<'EOF'

Not compared, by any run of this script: bucket policies and quotas, the
per-project S3 users and their secrets, versioning and lifecycle configuration,
and the archive's own .rustfs.sys state beyond whatever the scratch instance
needed in order to start. A restore that recreates objects still needs the
platform to re-provision the users and policies that let a tenant reach them.

restore_drill_age does not know what a drill covered. It measures that an
ops_events row of kind 'restore' was written, so a database-only drill keeps it
green for 40 days with object storage untested. If you record this run, say what
it covered in the detail:

  docker exec ritsdev-postgres-1 psql -U postgres -d _platform -c \
    "INSERT INTO ops_events (kind, status, detail) VALUES ('restore','success',
     jsonb_build_object('scope','object storage','set','<stamp>','objects_compared',<n>))"

Write that row only if this run passed. A row written regardless silences the
alert while proving nothing, which is worse than never having drilled.
EOF

[ "${FAILED}" -eq 0 ] || exit 1
