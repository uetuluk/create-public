#!/usr/bin/env bash
#
# Launch gate: capacity under load.
#
# Runs N real function runtimes belonging to disposable projects this script
# creates and destroys itself, optionally alongside one build and one render,
# and reports what the host does about it: resident and cached memory, swap and
# swap-in rate, pressure, load, per-container memory, the health of every
# platform service, and request latency through the gateway, cold and warm
# separately.
#
# It is meant to be run on a production host, so it is built to refuse and to
# stop:
#
#   * a pre-flight that will not start on a host that is already stressed;
#   * --scale N, so the load is ramped 2 -> 4 -> 8 -> 12 across separate runs
#     rather than jumped to, with an internal step of one runtime at a time
#     inside each run;
#   * abort thresholds checked after every sample, which tear the whole run down
#     mid-ramp and say which threshold went;
#   * a cleanup trap that removes every project, runtime and account it made, on
#     success, on failure, and on interrupt.
#
# Every disposable project is deleted through the platform API, never with SQL.
# The API is what revokes the database roles, the bucket and its S3 user, and
# any managed key; a raw DELETE bypasses all of it and orphaned a key on a
# shared proxy once already. For the same reason these projects are created
# without the LLM binding: the gate does not need it, and it mints real keys.
#
# Usage:
#   deploy/scripts/gate-capacity.sh --preflight-only
#   deploy/scripts/gate-capacity.sh --scale 2
#   deploy/scripts/gate-capacity.sh --scale 2 --with-render
#   GATE_ACCEPT_RISK=capacity-12 deploy/scripts/gate-capacity.sh \
#       --scale 12 --with-build --with-render
#
# Run it on the infrastructure host as a user in the docker group. It needs no
# credentials of its own: everything that talks to the platform API or the
# control database runs inside the control-plane container, which already holds
# the environment, so deploy/.env is never read and no secret is ever printed.

set -euo pipefail

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

SCALE=2
PREFLIGHT_ONLY=0
WITH_BUILD=0
WITH_RENDER=0
WARM_REQUESTS=3
HOLD_SECONDS=30
SAMPLE_SECONDS=5
# A build or a render can be over in seconds on a warm host, and the point of
# putting one alongside the runtimes is to see what it costs while it exists.
# Sample faster for as long as one is running.
# One second is already close to the floor: `docker stats --no-stream` itself
# takes a second or two on this host, so the real sampling interval is what that
# costs plus this.
BURST_SECONDS="${GATE_BURST_SECONDS:-1}"
PLATFORM_CONTAINER="${PLATFORM_CONTAINER:-ritsdev-platform-1}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-ritsdev}"
SLUG_PREFIX="${GATE_SLUG_PREFIX:-gatecap}"
GATE_EMAIL="${GATE_EMAIL:-gate-capacity@example.edu}"

usage() {
    sed -n '3,41p' "$0" | sed 's/^#\{1\} \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --scale) SCALE="$2"; shift 2 ;;
        --scale=*) SCALE="${1#*=}"; shift ;;
        --preflight-only) PREFLIGHT_ONLY=1; shift ;;
        --with-build) WITH_BUILD=1; shift ;;
        --with-render) WITH_RENDER=1; shift ;;
        --warm-requests) WARM_REQUESTS="$2"; shift 2 ;;
        --hold-seconds) HOLD_SECONDS="$2"; shift 2 ;;
        --sample-seconds) SAMPLE_SECONDS="$2"; shift 2 ;;
        -h|--help) usage 0 ;;
        *) echo "unknown option: $1" >&2; usage 2 ;;
    esac
done

case "$SCALE" in ''|*[!0-9]*) echo "--scale must be a positive integer" >&2; exit 2 ;; esac
[ "$SCALE" -ge 1 ] || { echo "--scale must be at least 1" >&2; exit 2; }

# Above four runtimes this stops being a measurement and becomes a load test of
# a host carrying ten real projects on two cores. Ramp discipline is not advice
# here; it has to be typed.
if [ "$SCALE" -gt 4 ] && [ "${GATE_ACCEPT_RISK:-}" != "capacity-${SCALE}" ]; then
    cat >&2 <<EOF
Refusing --scale ${SCALE}.

This host runs real projects on two cores. Ramp 2 -> 4 -> 8 -> 12 in separate
runs, reading the table each time, and continue only while memory, swap and
service health stay clear. When you have decided to go to ${SCALE}, say so:

  GATE_ACCEPT_RISK=capacity-${SCALE} $0 --scale ${SCALE} ...
EOF
    exit 2
fi

# ---------------------------------------------------------------------------
# Thresholds
#
# Pre-flight thresholds are about having room to start. Abort thresholds are
# about stopping before the host is damaged, and they track
# deploy/platform/src/lib/alert-rules.ts:
#
#   swap_used_fraction     0.5     -> GATE_ABORT_SWAP_FRACTION
#   disk_free_crit         20 GiB  -> GATE_ABORT_MIN_DISK_GB
#   memory_available_crit  300 MB  -> GATE_ABORT_MIN_AVAIL_MB
#   swap_in_rate           5 MiB/s -> GATE_ABORT_SWAPIN_KBPS
#   service_down/unhealthy any     -> any service not running or unhealthy
#   runtime_oom            any     -> any runtime container OOM-killed
#
# The alert rules require several consecutive breaching passes before firing,
# because an alert that flaps is worse than no alert. This script aborts on the
# first breach instead: a monitoring rule is deciding whether to wake someone,
# and this is deciding whether to keep pushing a production host.
#
# The last two of those started here as the harness's own, because this kernel
# is built without PSI — there is no /proc/pressure on RHEL 9 unless psi=1 is
# set at boot — so the signal the alert rules preferred was not there to read.
# After issue #63 alert-rules.ts uses the same two and has no pressure rules
# left, so GATE_ABORT_PSI_MEM is what now has no counterpart: it is kept for a
# host that does have PSI, and skipped on one that does not.
# ---------------------------------------------------------------------------

PREFLIGHT_MIN_AVAIL_MB="${GATE_PREFLIGHT_MIN_AVAIL_MB:-1500}"
PREFLIGHT_MAX_SWAP_FRACTION="${GATE_PREFLIGHT_MAX_SWAP_FRACTION:-0.25}"
PREFLIGHT_MAX_LOAD_PER_CPU="${GATE_PREFLIGHT_MAX_LOAD_PER_CPU:-1.5}"
PREFLIGHT_MIN_DISK_GB="${GATE_PREFLIGHT_MIN_DISK_GB:-25}"
PREFLIGHT_MAX_RUNTIMES="${GATE_PREFLIGHT_MAX_RUNTIMES:-2}"
PREFLIGHT_MAX_JOBS_DUE="${GATE_PREFLIGHT_MAX_JOBS_DUE:-5}"

ABORT_MIN_AVAIL_MB="${GATE_ABORT_MIN_AVAIL_MB:-300}"
ABORT_SWAP_FRACTION="${GATE_ABORT_SWAP_FRACTION:-0.5}"
ABORT_PSI_MEM="${GATE_ABORT_PSI_MEM:-40}"
ABORT_SWAPIN_KBPS="${GATE_ABORT_SWAPIN_KBPS:-5120}"
ABORT_LOAD_PER_CPU="${GATE_ABORT_LOAD_PER_CPU:-6}"
ABORT_MIN_DISK_GB="${GATE_ABORT_MIN_DISK_GB:-20}"

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gate-capacity.XXXXXX")"
chmod 700 "$WORK"
STEPS_CSV="$WORK/steps.csv"
ABORT_REASON=""
CLEANED=0
STARTED_ANY=0
NCPU="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
PSI_AVAILABLE=0
[ -r /proc/pressure/memory ] && PSI_AVAILABLE=1
PREV_PSWPIN=""
PREV_PSWPIN_TS=""
BASELINE_RT_N=0
BASELINE_SVC_TOTAL=0
PEAK_BUILD_MB=0
PEAK_RENDER_MB=0
PEAK_CTR_MB=0
LOW_AVAIL_MB=0

say()  { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { printf '\n!! %s\n' "$*" >&2; }
gt()   { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 > b+0)}'; }
lt()   { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 < b+0)}'; }

# ---------------------------------------------------------------------------
# The control-plane driver
#
# Everything that speaks to the platform API or the control database runs inside
# the control-plane container, the way the other verification scripts in this
# repository do. That is where the environment already is, so this script needs
# no credentials, reads no .env, and never has a token in its own arguments.
#
# The driver is stateless between invocations. It mints a fresh short-lived
# token each time and finds its own projects by slug prefix, so cleanup works
# even when the run was killed between two other invocations and nothing was
# handed back to it.
# ---------------------------------------------------------------------------

cat > "$WORK/driver.mjs" <<'GATE_DRIVER'
import {createHash, randomBytes} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {Pool} from 'pg'

const BASE = 'http://127.0.0.1:3000'
const OP = process.env.GATE_OP
const ARGS = JSON.parse(process.env.GATE_ARGS || '{}')
const PREFIX = process.env.GATE_PREFIX || 'gatecap'
const EMAIL = process.env.GATE_EMAIL || 'gate-capacity@example.edu'

const pool = new Pool({
    connectionString: (() => {
        const url = new URL(process.env.PLATFORM_ADMIN_DATABASE_URL)
        url.pathname = '/_platform'
        return url.toString()
    })(),
    max: 3,
})

let token = null
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')

async function api(path, init = {}) {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            ...(init.body ? {'content-type': 'application/json'} : {}),
            ...init.headers,
        },
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return {status: response.status, body}
}

async function waitFor(fn, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const value = await fn()
        if (value) return value
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
        await new Promise(r => setTimeout(r, 1000))
    }
}

/** Minimal ustar writer, so the image needs no tar. As in verify-2026-08-03. */
function tarGz(files) {
    const blocks = []
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content, 'utf8')
        const header = Buffer.alloc(512)
        header.write(name, 0, 100, 'utf8')
        header.write('000644 \0', 100, 8)
        header.write('000000 \0', 108, 8)
        header.write('000000 \0', 116, 8)
        header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12)
        header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ', 136, 12)
        header.write('        ', 148, 8)
        header.write('0', 156, 1)
        header.write('ustar\0', 257, 6)
        header.write('00', 263, 2)
        let sum = 0
        for (const byte of header) sum += byte
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
        blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
    }
    blocks.push(Buffer.alloc(1024))
    return gzipSync(Buffer.concat(blocks))
}

/**
 * The smallest honest function: it imports nothing, so `deno cache` has nothing
 * to fetch and each of the N builds costs seconds rather than a minute. Its
 * resident size is therefore a floor for a real tenant runtime, not an average.
 * The report says so, and the arithmetic also carries the 256 MiB cgroup limit
 * as the other bound.
 */
const FUNCTION_APP = {
    'ritsdev.site.json': JSON.stringify({
        schemaVersion: 1,
        functions: {entrypoint: 'functions/index.ts'},
        resources: {postgres: false, storage: false, llm: false},
    }),
    'functions/index.ts': `export default {
  fetch(request) {
    const url = new URL(request.url)
    return Response.json({ok: true, path: url.pathname, at: Date.now()})
  },
}`,
}

/**
 * The build fixture. A real dependency install through build-proxy and a real
 * bundler, because a build that installs nothing measures nothing. `install` is
 * a command string rather than the default `npm ci`, which would need a
 * lockfile this script cannot generate honestly.
 */
const BUILD_APP = {
    'ritsdev.site.json': JSON.stringify({
        schemaVersion: 1,
        build: {
            command: 'npx vite build',
            output: 'dist',
            install: 'npm install --no-audit --no-fund --loglevel=error',
        },
        functions: {entrypoint: 'functions/index.ts'},
        resources: {postgres: false, storage: false, llm: false},
    }),
    'package.json': JSON.stringify({
        name: 'gate-capacity-build', private: true, type: 'module',
        devDependencies: {vite: '5.4.11'},
    }),
    'index.html': '<!doctype html><html><body><div id="app">gate-capacity</div>'
        + '<script type="module" src="/main.js"></script></body></html>',
    'main.js': 'document.querySelector("#app").textContent = "gate-capacity build marker"',
    'functions/index.ts': FUNCTION_APP['functions/index.ts'],
}

async function mintToken(quota) {
    const raw = `rits_${randomBytes(27).toString('base64url')}`
    const account = await pool.query(
        `INSERT INTO accounts (email, display_name, platform_role, project_quota)
         VALUES ($1,'Capacity Gate','user',$2)
         ON CONFLICT (email) DO UPDATE SET project_quota = GREATEST(accounts.project_quota, $2)
         RETURNING id`,
        [EMAIL, quota],
    )
    await pool.query(
        `INSERT INTO personal_access_tokens (account_id, name, token_hash, token_last_four, scopes, expires_at)
         VALUES ($1,'gate-capacity',$2,$3,
                 ARRAY['sites:read','sites:write','deployments:write','logs:read'],
                 now() + interval '2 hours')`,
        [account.rows[0].id, createHash('sha256').update(raw).digest('hex'), raw.slice(-4)],
    )
    token = raw
}

async function projectId(slug) {
    const row = await pool.query(`SELECT id::text AS id FROM projects WHERE slug = $1`, [slug])
    return row.rows[0]?.id ?? null
}

async function uploadBuildDeploy(slug, files, buildTimeoutMs) {
    const archive = tarGz(files)
    const upload = await fetch(`${BASE}/v1/projects/${slug}/sources`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/gzip',
            'x-content-sha256': createHash('sha256').update(archive).digest('hex'),
        },
        body: archive,
    })
    const source = await upload.json()
    if (!source.sourceRevisionId) throw new Error(`upload ${slug}: ${JSON.stringify(source)}`)
    const version = await api(`/v1/projects/${slug}/versions`, {
        method: 'POST',
        body: JSON.stringify({sourceRevisionId: source.sourceRevisionId}),
    })
    const versionId = version.body.id ?? version.body.versionId
    const settled = await waitFor(async () => {
        const state = await api(`/v1/projects/${slug}/versions/${versionId}`)
        return ['ready', 'failed'].includes(state.body.status) ? state.body : null
    }, buildTimeoutMs, `${slug} build`)
    if (settled.status !== 'ready') throw new Error(`build ${slug} failed: ${settled.error ?? ''}`)
    const deployment = await api(`/v1/projects/${slug}/deployments`, {
        method: 'POST', body: JSON.stringify({versionId}),
    })
    const id = deployment.body.id ?? deployment.body.deploymentId
    const active = await waitFor(async () => {
        const state = await api(`/v1/projects/${slug}/deployments/${id}`)
        return ['active', 'failed'].includes(state.body.status) ? state.body : null
    }, 300_000, `${slug} deployment`)
    if (active.status !== 'active') throw new Error(`deploy ${slug} failed: ${active.error ?? ''}`)
    return versionId
}

const ops = {
    /** Everything the control plane knows that the host cannot see for itself. */
    async preflight() {
        const metricsToken = process.env.METRICS_TOKEN
        let metrics = {}
        try {
            const response = await fetch(`http://127.0.0.1:${process.env.METRICS_PORT ?? 9090}/metrics`, {
                headers: metricsToken ? {authorization: `Bearer ${metricsToken}`} : {},
            })
            const text = await response.text()
            metrics.status = response.status
            metrics.bytes = text.length
            // The interesting families only. These are gauges over a trailing
            // window, not counters, so they are recorded as levels and never
            // differenced into a rate.
            metrics.sample = text.split('\n').filter(line =>
                /^ritsdev_(runtimes|jobs_due|host_|executor_(concurrency|workers|snapshot)|alerts_firing|data_free)/
                    .test(line))
        } catch (error) {
            metrics = {error: String(error.message ?? error)}
        }
        const [runtimes, due, alerts, leftovers] = await Promise.all([
            pool.query(`SELECT count(*)::int AS n FROM project_runtime WHERE state = 'running'`),
            pool.query(`SELECT count(*)::int AS n FROM jobs WHERE status = 'queued' AND run_after <= now()`),
            pool.query(`SELECT rule, severity FROM alerts WHERE state = 'firing' ORDER BY rule`),
            pool.query(`SELECT slug, status FROM projects WHERE slug LIKE $1 AND status <> 'deleted'`, [`${PREFIX}-%`]),
        ])
        emit({
            event: 'preflight',
            runningRuntimes: runtimes.rows[0].n,
            jobsDue: due.rows[0].n,
            alertsFiring: alerts.rows.map(r => `${r.rule}(${r.severity})`),
            leftovers: leftovers.rows.map(r => `${r.slug}:${r.status}`),
            metrics,
        })
    },

    /** Creates, builds and deploys the disposable projects. Runtimes stay stopped. */
    async setup() {
        const scale = Number(ARGS.scale)
        await mintToken(scale + 4)
        const nonce = randomBytes(3).toString('hex')
        const projects = []
        for (let index = 1; index <= scale; index++) {
            const slug = `${PREFIX}-${String(index).padStart(2, '0')}-${nonce}`
            // No postgres, no storage, and emphatically no llm: the gate
            // measures runtime containers, and the LLM binding mints a real key
            // on a shared proxy.
            const created = await api('/v1/projects', {
                method: 'POST',
                body: JSON.stringify({slug, access: 'owner', postgres: false, storage: false, llm: false}),
            })
            if (created.status !== 202) {
                throw new Error(`create ${slug}: ${created.status} ${JSON.stringify(created.body)}`)
            }
            await waitFor(async () => {
                const project = await api(`/v1/projects/${slug}`)
                return project.body?.resources?.provisionState === 'ready'
            }, 120_000, `${slug} provisioning`)
            const versionId = await uploadBuildDeploy(slug, FUNCTION_APP, 300_000)
            projects.push({slug, projectId: await projectId(slug), versionId})
            emit({event: 'deployed', slug, index, of: scale})
        }
        emit({event: 'setup', projects})
    },

    /**
     * Starts one runtime the way a visitor's first request does, and reports the
     * cold start the way /metrics defines it: for a start_runtime job,
     * finished_at - locked_at is the cold start, from claim to health check. The
     * queue wait is reported separately, so a deep executor queue is never
     * mistaken for a slow container.
     */
    async start() {
        const {projectId: id, versionId} = ARGS
        const key = `start:${id}:${versionId}`
        // Byte for byte the gateway's own enqueueRuntimeStart.
        await pool.query(
            `INSERT INTO jobs (kind, project_id, version_id, idempotency_key)
             VALUES ('start_runtime',$1,$2,$3)
             ON CONFLICT (idempotency_key) DO UPDATE
             SET status = 'queued', run_after = now(), finished_at = NULL, error_message = NULL
             WHERE jobs.status IN ('succeeded', 'failed')`,
            [id, versionId, key],
        )
        const job = await waitFor(async () => {
            const row = await pool.query(
                `SELECT status, error_message,
                        extract(epoch FROM finished_at - locked_at)::float8 AS run_seconds,
                        extract(epoch FROM locked_at - created_at)::float8 AS wait_seconds
                 FROM jobs WHERE idempotency_key = $1`, [key])
            const value = row.rows[0]
            return value && ['succeeded', 'failed'].includes(value.status) ? value : null
        }, 240_000, 'start_runtime')
        const state = await pool.query(
            `SELECT state FROM project_runtime WHERE project_id = $1 AND version_id = $2`, [id, versionId])
        emit({
            event: 'start',
            ok: job.status === 'succeeded' && state.rows[0]?.state === 'running',
            coldStartSeconds: job.run_seconds,
            queueWaitSeconds: job.wait_seconds,
            state: state.rows[0]?.state ?? 'unknown',
            error: job.error_message ?? null,
        })
    },

    /**
     * One or more requests to each live runtime, through the gateway.
     *
     * probe_version is the platform's own instrument: the executor issues the
     * request to GATEWAY_INTERNAL_URL and records what the gateway and the
     * runtime took. That figure excludes the executor's own queue, so both are
     * reported — gatewayMs is the visitor's latency, wallMs adds the wait for a
     * worker.
     */
    async probe() {
        await mintToken(4)
        const results = []
        for (let attempt = 0; attempt < (ARGS.count ?? 1); attempt++) {
            for (const target of ARGS.targets) {
                const began = Date.now()
                const response = await api(`/v1/projects/${target.slug}/versions/${target.versionId}/probe`, {
                    method: 'POST', body: JSON.stringify({path: '/api'}),
                })
                results.push({
                    slug: target.slug,
                    status: response.body?.status ?? response.status,
                    gatewayMs: response.body?.durationMs ?? null,
                    wallMs: Date.now() - began,
                    coldStart: response.body?.coldStart ?? null,
                })
            }
        }
        emit({event: 'probe', results})
    },

    /** A real build, concurrent with whatever is already running. */
    async build() {
        await mintToken(4)
        const began = Date.now()
        try {
            const versionId = await uploadBuildDeploy(ARGS.slug, BUILD_APP, 600_000)
            emit({event: 'build', ok: true, slug: ARGS.slug, versionId,
                seconds: (Date.now() - began) / 1000})
        } catch (error) {
            emit({event: 'build', ok: false, slug: ARGS.slug, seconds: (Date.now() - began) / 1000,
                error: String(error.message ?? error).slice(0, 300)})
        }
    },

    /** A real render: a full browser, 768 MiB, executing a tenant page. */
    async render() {
        await mintToken(4)
        const began = Date.now()
        try {
            let render = await api(`/v1/projects/${ARGS.slug}/versions/${ARGS.versionId}/render`, {method: 'POST'})
            if (render.body?.status === 'queued') {
                render = await waitFor(async () => {
                    const again = await api(
                        `/v1/projects/${ARGS.slug}/versions/${ARGS.versionId}/render`, {method: 'POST'})
                    return again.body?.screenshotBase64 || again.body?.status === 'failed' ? again : null
                }, 300_000, 'render')
            }
            const bytes = render.body?.screenshotBase64
                ? Buffer.from(render.body.screenshotBase64, 'base64').length : 0
            emit({event: 'render', ok: bytes > 1000, bytes,
                seconds: (Date.now() - began) / 1000, error: render.body?.error ?? null})
        } catch (error) {
            emit({event: 'render', ok: false, bytes: 0, seconds: (Date.now() - began) / 1000,
                error: String(error.message ?? error).slice(0, 300)})
        }
    },

    /** Stops every runtime this run started, through the executor. */
    async stop() {
        for (const target of ARGS.targets) {
            await pool.query(
                `INSERT INTO jobs (kind, project_id, version_id, idempotency_key)
                 VALUES ('stop_runtime',$1,$2,$3) ON CONFLICT (idempotency_key) DO NOTHING`,
                [target.projectId, target.versionId,
                    `gate-stop:${target.projectId}:${target.versionId}:${Date.now()}`],
            )
        }
        const ids = ARGS.targets.map(t => t.projectId)
        let remaining = ids.length
        try {
            await waitFor(async () => {
                const row = await pool.query(
                    `SELECT count(*)::int AS n FROM project_runtime
                     WHERE project_id = ANY($1) AND state = 'running'`, [ids])
                remaining = row.rows[0].n
                return remaining === 0
            }, 240_000, 'runtimes to stop')
        } catch { /* reported below; cleanup removes them regardless */ }
        emit({event: 'stop', stillRunning: remaining})
    },

    /**
     * Deletes every project this gate has ever created, through the API, then
     * brings the purge forward so a disposable project does not sit in
     * 'deleting' for seven days holding quota.
     *
     * The API delete is what revokes the database roles, the bucket and its S3
     * user, and any managed key. Both halves of the purge are needed: the
     * executor refuses to purge unless projects.purge_after has also passed.
     *
     * The account is removed only once nothing references it. accounts is the
     * parent of projects with ON DELETE CASCADE, so deleting it while a project
     * row survives would take that row out from under the executor and orphan
     * its database and bucket for good.
     */
    async cleanup() {
        await mintToken(4)
        // Scoped by owner as well as by name. The slug prefix alone is just a
        // naming convention: nothing stops a real user from creating
        // `gatecap-notes`, and this loop would then delete it through the API,
        // confirmation string and all. mintToken upserts the account before
        // this runs and GATE_EMAIL is constant across runs, so requiring
        // ownership still cleans up after a run that was killed earlier.
        const owned = await pool.query(
            `SELECT slug FROM projects
             WHERE slug LIKE $1 AND status <> 'deleted'
               AND owner_id = (SELECT id FROM accounts WHERE email = $2)
             ORDER BY slug`,
            [`${PREFIX}-%`, EMAIL],
        )
        const slugs = owned.rows.map(r => r.slug)
        for (const slug of slugs) {
            await api(`/v1/projects/${slug}`, {
                method: 'DELETE', body: JSON.stringify({confirmation: slug}),
            }).catch(() => {})
        }
        if (slugs.length) {
            await pool.query(
                `UPDATE projects SET purge_after = now() - interval '1 minute' WHERE slug = ANY($1)`,
                [slugs]).catch(() => {})
            await pool.query(
                `UPDATE jobs SET run_after = now(), status = 'queued', attempts = 0, error_message = NULL
                 WHERE kind = 'delete_project' AND status IN ('queued','failed')
                   AND project_id IN (SELECT id FROM projects WHERE slug = ANY($1))`,
                [slugs]).catch(() => {})
        }
        let survivors = slugs.length
        const deadline = Date.now() + 300_000
        while (Date.now() < deadline) {
            const left = await pool.query(
                `SELECT count(*)::int AS n FROM projects
                 WHERE slug LIKE $1 AND status <> 'deleted'
                   AND owner_id = (SELECT id FROM accounts WHERE email = $2)`,
                [`${PREFIX}-%`, EMAIL]).catch(() => null)
            if (left) survivors = left.rows[0].n
            if (survivors === 0) break
            await new Promise(r => setTimeout(r, 3000))
        }
        await pool.query(
            `UPDATE personal_access_tokens SET revoked_at = now()
             WHERE account_id = (SELECT id FROM accounts WHERE email = $1) AND revoked_at IS NULL`,
            [EMAIL]).catch(() => {})
        const referenced = await pool.query(
            `SELECT count(*)::int AS n FROM projects
             WHERE owner_id = (SELECT id FROM accounts WHERE email = $1)`, [EMAIL])
        let accountRemoved = false
        if (referenced.rows[0].n === 0) {
            await pool.query(`DELETE FROM accounts WHERE email = $1`, [EMAIL])
            accountRemoved = true
        }
        const runtimes = await pool.query(
            `SELECT count(*)::int AS n FROM project_runtime WHERE state = 'running'`)
        emit({
            event: 'cleanup',
            deleted: slugs,
            survivors,
            accountRemoved,
            accountKeptBecause: accountRemoved ? null
                : `${referenced.rows[0].n} project rows still reference it`,
            runningRuntimes: runtimes.rows[0].n,
        })
    },
}

try {
    if (!ops[OP]) throw new Error(`unknown GATE_OP ${OP}`)
    await ops[OP]()
} catch (error) {
    emit({event: 'error', op: OP, message: String(error && error.stack || error).slice(0, 800)})
    await pool.end().catch(() => {})
    process.exit(1)
}
await pool.end().catch(() => {})
GATE_DRIVER

# `docker exec -e` puts the value in this host's process list, so GATE_ARGS
# carries slugs and identifiers only. The token never leaves the container.
drive() {
    local op="$1" args="${2:-}"
    [ -n "$args" ] || args='{}'
    docker exec -i \
        -e GATE_OP="$op" -e GATE_ARGS="$args" \
        -e GATE_PREFIX="$SLUG_PREFIX" -e GATE_EMAIL="$GATE_EMAIL" \
        "$PLATFORM_CONTAINER" node --input-type=module < "$WORK/driver.mjs"
}

# ---------------------------------------------------------------------------
# Small helpers, written out rather than inlined so the shell quoting stays
# readable.
# ---------------------------------------------------------------------------

cat > "$WORK/pick.py" <<'PY'
import json, sys
mode, path = sys.argv[1], sys.argv[2]
targets = json.load(open(path))['targets']
if mode == 'one':
    print(json.dumps(targets[int(sys.argv[3]) - 1]))
elif mode == 'upto':
    print(json.dumps({'targets': targets[:int(sys.argv[3])], 'count': int(sys.argv[4])}))
elif mode == 'all':
    print(json.dumps({'targets': targets}))
elif mode == 'slug':
    print(targets[int(sys.argv[3])]['slug'])
elif mode == 'render':
    t = targets[-1]
    print(json.dumps({'slug': t['slug'], 'versionId': t['versionId']}))
PY

cat > "$WORK/setup_targets.py" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    row = json.loads(line)
    if row.get('event') == 'setup':
        json.dump({'targets': row['projects']}, open(sys.argv[2], 'w'))
        break
PY

# p50 and worst case, gateway-side and wall-clock. Prints four numbers.
cat > "$WORK/probe_stats.py" <<'PY'
import json, sys
gateway, wall = [], []
for line in open(sys.argv[1]):
    try:
        row = json.loads(line)
    except Exception:
        continue
    if row.get('event') != 'probe':
        continue
    for result in row['results']:
        if result.get('gatewayMs') is not None:
            gateway.append(result['gatewayMs'])
        if result.get('wallMs') is not None:
            wall.append(result['wallMs'])
def stats(values):
    if not values:
        return '-', '-'
    values.sort()
    return int(values[len(values) // 2]), int(values[-1])
print(*stats(gateway), *stats(wall))
PY

# ---------------------------------------------------------------------------
# Host sampling
#
# Two docker calls per sample, both batched over every container at once. The
# per-container sweep this avoids — one `docker stats` invocation per container
# — is already recorded in the handoff as too expensive for a two-core host, and
# a sampler that costs what it measures is worthless.
# ---------------------------------------------------------------------------

collect() {
    docker stats --no-stream --format '{{.Name}}	{{.MemUsage}}	{{.CPUPerc}}' \
        > "$WORK/stats.tsv" 2>/dev/null || : > "$WORK/stats.tsv"
    # -a so a service that died reads as dead rather than as absent. The compose
    # project label keeps the retired legacy stack, which is legitimately
    # stopped, out of the health count.
    docker ps -a --format '{{.Names}}	{{.Image}}	{{.State}}	{{.Status}}	{{.Label "com.docker.compose.project"}}' \
        > "$WORK/ps.tsv" 2>/dev/null || : > "$WORK/ps.tsv"

    local now psi_mem psi_full psi_cpu disk_kb
    now="$(date +%s)"
    psi_mem="n/a"; psi_full="n/a"; psi_cpu="n/a"
    if [ "$PSI_AVAILABLE" = 1 ]; then
        psi_mem="$(awk '/^some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub("avg10=","",$i); print $i}}' /proc/pressure/memory)"
        psi_full="$(awk '/^full/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub("avg10=","",$i); print $i}}' /proc/pressure/memory)"
        psi_cpu="$(awk '/^some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub("avg10=","",$i); print $i}}' /proc/pressure/cpu)"
    fi
    disk_kb="$(df -Pk "$DATA_HOST_PATH" | awk 'NR==2{print $4}')"

    awk -v now="$now" -v psi_mem="$psi_mem" -v psi_full="$psi_full" -v psi_cpu="$psi_cpu" \
        -v disk_kb="$disk_kb" -v prev_in="${PREV_PSWPIN:-}" -v prev_ts="${PREV_PSWPIN_TS:-}" \
        -v project="$COMPOSE_PROJECT" -v stats="$WORK/stats.tsv" -v pslist="$WORK/ps.tsv" '
    function mib(text,   value, unit) {
        # docker stats memory reads like "12.3MiB / 256MiB"
        value = text + 0
        unit = text; sub(/^[0-9.]+/, "", unit)
        if (unit ~ /^GiB/) return value * 1024
        if (unit ~ /^KiB/) return value / 1024
        if (unit ~ /^B/)   return value / 1048576
        return value
    }
    BEGIN {
        while ((getline line < "/proc/meminfo") > 0) {
            split(line, f, /[: ]+/); mem[f[1]] = f[2] / 1024
        }
        while ((getline line < "/proc/vmstat") > 0) {
            split(line, f, / +/); if (f[1] == "pswpin") pswpin = f[2]
        }
        while ((getline line < stats) > 0) {
            split(line, f, /\t/)
            split(f[2], parts, / *\/ */)
            used = mib(parts[1])
            container_total += used
            memof[f[1]] = used
            # The right-hand side of "12.3MiB / 256MiB" is the cgroup limit, so
            # the budget arithmetic needs no `docker inspect` — and in
            # particular never needs to inspect cloudflared, whose tunnel token
            # is in its command line.
            limitof[f[1]] = mib(parts[2])
            if (f[1] ~ /^rits-site-/) { rt_n++; rt_mem += used; rt_limit = limitof[f[1]] }
            if (f[1] ~ /^rits-build-/ || f[1] ~ /^rits-cache-/) { build_n++; build_mem += used }
        }
        while ((getline line < pslist) > 0) {
            split(line, f, /\t/)
            name = f[1]; image = f[2]; state = f[3]; status = f[4]; label = f[5]
            # The render container is started with --rm and no --name, so it can
            # only be recognised by its image.
            if (state == "running" && (image ~ /ritsdev-render/ || image ~ /playwright/)) {
                render_n++; render_mem += memof[name]
            }
            # The compose project label alone is not enough. `docker compose
            # build` stamps it onto the images it builds, and a container
            # inherits its image labels — so the render container, started by
            # the executor from ritsdev-render:local, arrives carrying it. It
            # was counted as an eleventh platform service, and because it runs
            # with --rm it would eventually be caught mid-exit and read as a
            # service that had died, aborting the run for no reason. Compose
            # also names its own containers, and the executor does not.
            #
            # The executor now clears that label where it starts the render
            # container, so on a host running current code nothing reaches this
            # line wearing it. Both checks stay: the gate has to give the same
            # answer against a host that has not been redeployed yet, and
            # against the next container someone runs from a compose-built
            # image.
            if (label != project) continue
            if (index(name, project "-") != 1) continue
            if (name ~ /-data-init/) continue          # one-shot, exits by design
            svc_total++
            svc_limit += limitof[name]
            if (state != "running") { svc_bad++; bad = bad name ":" state ","; continue }
            if (status ~ /\(unhealthy\)/) { svc_bad++; bad = bad name ":unhealthy," }
        }
        swap_used = mem["SwapTotal"] - mem["SwapFree"]
        swap_frac = mem["SwapTotal"] > 0 ? swap_used / mem["SwapTotal"] : 0
        swapin = -1
        if (prev_in != "" && prev_ts != "" && now - prev_ts > 0) {
            swapin = (pswpin - prev_in) * 4 / (now - prev_ts)
        }
        printf "%s|%d|%d|%d|%d|%d|%d|%.4f|%d|%.1f|%s|%s|%s|%.1f|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d|%d|%s\n",
            now, mem["MemTotal"], mem["MemAvailable"], mem["MemFree"],
            mem["Buffers"] + mem["Cached"], mem["SwapTotal"], swap_used, swap_frac,
            pswpin, swapin, psi_mem, psi_full, psi_cpu, disk_kb / 1048576,
            rt_n, rt_mem, build_n, build_mem, render_n, render_mem,
            container_total, svc_total, svc_bad, svc_limit, rt_limit,
            (bad == "" ? "-" : bad)
    }'
}

snap() {
    local line
    line="$(collect)"
    IFS='|' read -r S_TS S_MEMTOTAL S_MEMAVAIL S_MEMFREE S_CACHE S_SWAPTOTAL S_SWAPUSED \
        S_SWAPFRAC S_PSWPIN S_SWAPIN S_PSI_MEM S_PSI_FULL S_PSI_CPU S_DISK_GB \
        S_RT_N S_RT_MEM S_BUILD_N S_BUILD_MEM S_RENDER_N S_RENDER_MEM \
        S_CTR_MEM S_SVC_TOTAL S_SVC_BAD S_SVC_LIMIT S_RT_LIMIT S_SVC_DETAIL <<<"$line"
    S_LOAD1="$(awk '{print $1}' /proc/loadavg)"
    PREV_PSWPIN="$S_PSWPIN"
    PREV_PSWPIN_TS="$S_TS"
    # High-water marks, so a build or render that is over in seconds still
    # leaves its cost on the record.
    [ "${S_BUILD_MEM:-0}"  -gt "$PEAK_BUILD_MB"  ] && PEAK_BUILD_MB="$S_BUILD_MEM"
    [ "${S_RENDER_MEM:-0}" -gt "$PEAK_RENDER_MB" ] && PEAK_RENDER_MB="$S_RENDER_MEM"
    [ "${S_CTR_MEM:-0}"    -gt "$PEAK_CTR_MB"    ] && PEAK_CTR_MB="$S_CTR_MEM"
    if [ "$LOW_AVAIL_MB" = 0 ] || [ "${S_MEMAVAIL:-0}" -lt "$LOW_AVAIL_MB" ]; then
        LOW_AVAIL_MB="$S_MEMAVAIL"
    fi
    return 0
}

# Sets ABORT_REASON and returns non-zero when a danger line is crossed.
check_abort() {
    local reason=""
    if lt "$S_MEMAVAIL" "$ABORT_MIN_AVAIL_MB"; then
        reason="MemAvailable ${S_MEMAVAIL} MB is below memory_available_crit (${ABORT_MIN_AVAIL_MB} MB)"
    elif gt "$S_SWAPFRAC" "$ABORT_SWAP_FRACTION"; then
        reason="swap is ${S_SWAPUSED} MB of ${S_SWAPTOTAL} MB used, past the ${ABORT_SWAP_FRACTION} fraction in alert-rules"
    elif [ "$S_PSI_MEM" != "n/a" ] && gt "$S_PSI_MEM" "$ABORT_PSI_MEM"; then
        reason="memory pressure avg10 is ${S_PSI_MEM}%, past GATE_ABORT_PSI_MEM (${ABORT_PSI_MEM})"
    elif gt "$S_SWAPIN" "$ABORT_SWAPIN_KBPS"; then
        reason="swap-in is running at ${S_SWAPIN} KB/s, past swap_in_rate (${ABORT_SWAPIN_KBPS} KB/s): the host is thrashing"
    elif gt "$S_LOAD1" "$(awk -v p="$ABORT_LOAD_PER_CPU" -v n="$NCPU" 'BEGIN{print p*n}')"; then
        reason="load average ${S_LOAD1} is past ${ABORT_LOAD_PER_CPU} per core on ${NCPU} cores"
    elif lt "$S_DISK_GB" "$ABORT_MIN_DISK_GB"; then
        reason="data filesystem free space ${S_DISK_GB} GiB is below disk_free_crit (${ABORT_MIN_DISK_GB} GiB)"
    elif [ "${S_SVC_BAD:-0}" -gt 0 ]; then
        reason="platform services not healthy: ${S_SVC_DETAIL}"
    elif [ "${S_SVC_TOTAL:-0}" -lt "${BASELINE_SVC_TOTAL:-0}" ]; then
        reason="only ${S_SVC_TOTAL} of ${BASELINE_SVC_TOTAL} platform services are present"
    else
        local oom=""
        while read -r name; do
            [ -n "$name" ] || continue
            if [ "$(docker inspect -f '{{.State.OOMKilled}}' "$name" 2>/dev/null)" = "true" ]; then
                oom="${oom}${name} "
            fi
        done < <(awk -F'\t' '$1 ~ /^rits-site-/{print $1}' "$WORK/stats.tsv")
        [ -n "$oom" ] && reason="runtime container OOM-killed: ${oom}"
    fi
    [ -z "$reason" ] && return 0
    ABORT_REASON="$reason"
    return 1
}

# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

ROW_FMT='%-16s %3s %8s %7s %7s %6s %6s %6s %6s %8s %6s %11s %6s %12s %6s\n'

table_header() {
    # shellcheck disable=SC2059
    printf "$ROW_FMT" phase rt availMB cacheMB ctrMB rtMB bldMB rndMB swapMB swapInKB load \
        'psiMemS/F' psiCpu 'cold p50/max' svc
    printf '%s\n' '--------------------------------------------------------------------------------------------------------------------------------'
}

# table_row <phase> [coldSeconds] [p50ms] [maxms]
table_row() {
    local latency='-'
    [ "${3:--}" != "-" ] && latency="${3}/${4}"
    # shellcheck disable=SC2059
    printf "$ROW_FMT" "$1" "$S_RT_N" "$S_MEMAVAIL" "$S_CACHE" "$S_CTR_MEM" "$S_RT_MEM" \
        "$S_BUILD_MEM" "$S_RENDER_MEM" "$S_SWAPUSED" \
        "$(awk -v v="$S_SWAPIN" 'BEGIN{if (v < 0) print "-"; else printf "%.0f", v}')" \
        "$S_LOAD1" "$([ "$S_PSI_MEM" = 'n/a' ] && echo 'n/a' || echo "${S_PSI_MEM}/${S_PSI_FULL}")" \
        "$S_PSI_CPU" "${2:--} $latency" \
        "$((S_SVC_TOTAL - S_SVC_BAD))/$S_SVC_TOTAL"
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "$1" "$S_RT_N" "$S_MEMAVAIL" "$S_CACHE" "$S_CTR_MEM" "$S_RT_MEM" "$S_SWAPUSED" \
        "$S_LOAD1" "${2:-}" "${3:-}" "${4:-}" "$S_SVC_TOTAL" "$S_SVC_BAD" \
        "$S_BUILD_MEM" "$S_RENDER_MEM" "$S_PSI_MEM" "$S_PSI_FULL" "$S_PSI_CPU" >> "$STEPS_CSV"
}

# ---------------------------------------------------------------------------
# Teardown. Runs on success, on failure, and on interrupt.
# ---------------------------------------------------------------------------

teardown() {
    local status=$?
    trap - EXIT INT TERM
    if [ "$CLEANED" = 1 ]; then exit "$status"; fi
    CLEANED=1
    echo
    if [ -n "$ABORT_REASON" ]; then
        fail "ABORTED: $ABORT_REASON"
        say "tearing down"
    else
        say "cleaning up"
    fi
    if [ "$STARTED_ANY" = 1 ] && [ -s "$WORK/targets.json" ]; then
        drive stop "$(python3 "$WORK/pick.py" all "$WORK/targets.json")" 2>&1 | sed 's/^/    /' || true
    fi
    drive cleanup > "$WORK/cleanup.json" 2>&1 || true
    sed 's/^/    /' "$WORK/cleanup.json" || true

    # The gate is only over when the host is back where it started.
    snap
    echo
    say "final state: ${S_RT_N} runtime containers, $((S_SVC_TOTAL - S_SVC_BAD))/${S_SVC_TOTAL} services healthy, ${S_MEMAVAIL} MB available"
    if [ "${S_RT_N:-0}" -ne "${BASELINE_RT_N:-0}" ]; then
        fail "runtime container count is ${S_RT_N}, baseline was ${BASELINE_RT_N}"
        status=1
    fi
    if [ "${S_SVC_BAD:-0}" -ne 0 ] || [ "${S_SVC_TOTAL:-0}" -lt "${BASELINE_SVC_TOTAL:-0}" ]; then
        fail "service health did not return to baseline: ${S_SVC_DETAIL}"
        status=1
    fi
    if grep -q '"survivors":0' "$WORK/cleanup.json" 2>/dev/null; then
        say "every disposable project was deleted through the API and purged"
    else
        fail "disposable projects survived cleanup; look for slugs matching ${SLUG_PREFIX}-*"
        status=1
    fi
    rm -rf "$WORK"
    if [ -n "$ABORT_REASON" ]; then status=1; fi
    exit "$status"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

command -v docker  >/dev/null || { echo "docker is required"  >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }
docker inspect "$PLATFORM_CONTAINER" >/dev/null 2>&1 || {
    echo "control-plane container ${PLATFORM_CONTAINER} not found; run this on the infrastructure host" >&2
    exit 2
}
# Where /data actually is, asked of docker rather than read out of deploy/.env.
DATA_HOST_PATH="$(docker inspect "$PLATFORM_CONTAINER" \
    --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
[ -n "$DATA_HOST_PATH" ] || DATA_HOST_PATH=/

# The two limits that no running container can be asked for, because a build and
# a render only exist while one is in flight. BUILD_MEMORY_MB is a tunable and is
# read from the executor's own environment; the render's 768 MiB is a literal in
# executor.ts. Never inspect cloudflared for anything — its tunnel token is in
# its command line — which is why every other limit in this script is read out of
# `docker stats` instead.
BUILD_LIMIT_MB="$(docker inspect "${EXECUTOR_CONTAINER:-ritsdev-executor-1}" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | awk -F= '$1 == "BUILD_MEMORY_MB" {print $2}' | head -1)"
[ -n "$BUILD_LIMIT_MB" ] || BUILD_LIMIT_MB=2048
RENDER_LIMIT_MB="${GATE_RENDER_LIMIT_MB:-768}"
# What the launch gate is actually about: twelve active function containers.
PREDICT_RUNTIMES="${GATE_PREDICT_RUNTIMES:-12}"

extras=""
[ "$WITH_BUILD"  = 1 ] && extras="${extras} + 1 build"
[ "$WITH_RENDER" = 1 ] && extras="${extras} + 1 render"
echo "=============================================================================================="
echo " capacity gate: ${SCALE} function runtimes${extras}"
echo " host: $(hostname -f 2>/dev/null || hostname), ${NCPU} cores, kernel $(uname -r)"
if [ "$PSI_AVAILABLE" = 1 ]; then
    echo " PSI: available"
else
    echo " PSI: NOT AVAILABLE. /proc/pressure is absent on this kernel, so the MemAvailable floor"
    echo "      and the swap-in rate carry the abort decision. alert-rules.ts uses the same two"
    echo "      signals for the same reason; no alert rule reads PSI."
fi
echo "=============================================================================================="
echo

# ---- pre-flight ------------------------------------------------------------
say "pre-flight"
snap
BASELINE_RT_N="$S_RT_N"
BASELINE_SVC_TOTAL="$S_SVC_TOTAL"
BASELINE_AVAIL="$S_MEMAVAIL"
BASELINE_CTR_MEM="$S_CTR_MEM"

if ! drive preflight > "$WORK/preflight.json" 2>&1; then
    cat "$WORK/preflight.json"
    echo "pre-flight driver failed" >&2
    rm -rf "$WORK"
    exit 1
fi

printf '  memory      %s MB total, %s MB available, %s MB cache\n' "$S_MEMTOTAL" "$S_MEMAVAIL" "$S_CACHE"
printf '  swap        %s MB of %s MB used (%s%%)\n' "$S_SWAPUSED" "$S_SWAPTOTAL" \
    "$(awk -v v="$S_SWAPFRAC" 'BEGIN{printf "%.0f", v*100}')"
printf '  pressure    memory some=%s full=%s, cpu some=%s (avg10)\n' "$S_PSI_MEM" "$S_PSI_FULL" "$S_PSI_CPU"
printf '  load        %s on %s cores\n' "$S_LOAD1" "$NCPU"
printf '  disk        %s GiB free on %s\n' "$S_DISK_GB" "$DATA_HOST_PATH"
printf '  services    %s of %s healthy  %s\n' "$((S_SVC_TOTAL - S_SVC_BAD))" "$S_SVC_TOTAL" "$S_SVC_DETAIL"
printf '  containers  %s MB resident in all containers, %s function runtimes live\n' "$S_CTR_MEM" "$S_RT_N"
echo '  control plane:'
sed 's/^/    /' "$WORK/preflight.json"
echo

PRE_RUNTIMES="$(grep -o '"runningRuntimes":[0-9]*' "$WORK/preflight.json" | head -1 | cut -d: -f2 || true)"
PRE_JOBS_DUE="$(grep -o '"jobsDue":[0-9]*' "$WORK/preflight.json" | head -1 | cut -d: -f2 || true)"

refuse=""
if   lt "$S_MEMAVAIL" "$PREFLIGHT_MIN_AVAIL_MB"; then
    refuse="only ${S_MEMAVAIL} MB available, ${PREFLIGHT_MIN_AVAIL_MB} MB needed to start"
elif gt "$S_SWAPFRAC" "$PREFLIGHT_MAX_SWAP_FRACTION"; then
    refuse="swap is already ${S_SWAPUSED} MB of ${S_SWAPTOTAL} MB used"
elif gt "$S_LOAD1" "$(awk -v p="$PREFLIGHT_MAX_LOAD_PER_CPU" -v n="$NCPU" 'BEGIN{print p*n}')"; then
    refuse="load average is already ${S_LOAD1} on ${NCPU} cores"
elif lt "$S_DISK_GB" "$PREFLIGHT_MIN_DISK_GB"; then
    refuse="only ${S_DISK_GB} GiB free on the data filesystem"
elif [ "${S_SVC_BAD:-0}" -gt 0 ]; then
    refuse="platform services are not healthy: ${S_SVC_DETAIL}"
elif [ "${PRE_RUNTIMES:-0}" -gt "$PREFLIGHT_MAX_RUNTIMES" ]; then
    refuse="${PRE_RUNTIMES} runtimes are already running; real traffic is in progress"
elif [ "${PRE_JOBS_DUE:-0}" -gt "$PREFLIGHT_MAX_JOBS_DUE" ]; then
    refuse="${PRE_JOBS_DUE} jobs are already queued and due; the executor is behind"
fi

if [ -n "$refuse" ]; then
    fail "REFUSING TO START: ${refuse}"
    echo "Wait for the host to settle, or move the threshold deliberately." >&2
    rm -rf "$WORK"
    exit 1
fi
say "pre-flight clear"
if [ "$PREFLIGHT_ONLY" = 1 ]; then
    say "--preflight-only: nothing was created"
    rm -rf "$WORK"
    exit 0
fi
echo

trap teardown EXIT INT TERM

# ---- disposable projects ---------------------------------------------------
say "creating ${SCALE} disposable projects (no postgres, no storage, no llm)"
# Streamed rather than captured: setup is the long part of the run, and a
# progress line per project is the only sign it is still working.
{ drive setup "{\"scale\":${SCALE}}" 2>&1 || true; } | tee "$WORK/setup.jsonl" | sed 's/^/    /'
if ! grep -q '"event":"setup"' "$WORK/setup.jsonl"; then
    ABORT_REASON="project setup did not complete"
    exit 1
fi
python3 "$WORK/setup_targets.py" "$WORK/setup.jsonl" "$WORK/targets.json"
echo

# ---- ramp ------------------------------------------------------------------
say "ramping to ${SCALE} live runtimes, one at a time"
echo
table_header
snap
table_row baseline

STARTED_ANY=1
for step in $(seq 1 "$SCALE"); do
    target="$(python3 "$WORK/pick.py" one "$WORK/targets.json" "$step")"
    drive start "$target" > "$WORK/start-$step.json" 2>&1 || true
    if ! grep -q '"ok":true' "$WORK/start-$step.json"; then
        sed 's/^/    /' "$WORK/start-$step.json"
        ABORT_REASON="runtime ${step} failed to start"
        exit 1
    fi
    cold="$(grep -o '"coldStartSeconds":[0-9.]*' "$WORK/start-$step.json" | head -1 | cut -d: -f2)"

    # One round of requests to every live runtime, so latency is measured under
    # the load that exists at this step rather than on a quiet host.
    live="$(python3 "$WORK/pick.py" upto "$WORK/targets.json" "$step" "$WARM_REQUESTS")"
    drive probe "$live" > "$WORK/probe-$step.json" 2>&1 || true
    read -r gw_p50 gw_max wall_p50 wall_max < <(python3 "$WORK/probe_stats.py" "$WORK/probe-$step.json")
    echo "$step,$gw_p50,$gw_max,$wall_p50,$wall_max" >> "$WORK/latency.csv"

    snap
    table_row "runtimes=${step}" "$(awk -v v="${cold:-0}" 'BEGIN{printf "%.1f", v}')" "$gw_p50" "$gw_max"
    check_abort || exit 1
done
echo

# ---- optional build --------------------------------------------------------
if [ "$WITH_BUILD" = 1 ]; then
    say "starting a real build alongside ${SCALE} live runtimes (BUILD_MEMORY_MB allowance is 2048)"
    build_slug="$(python3 "$WORK/pick.py" slug "$WORK/targets.json" 0)"
    drive build "{\"slug\":\"${build_slug}\"}" > "$WORK/build.json" 2>&1 &
    build_pid=$!
    while kill -0 "$build_pid" 2>/dev/null; do
        snap
        table_row "build+rt=${SCALE}"
        if ! check_abort; then kill "$build_pid" 2>/dev/null || true; exit 1; fi
        sleep "$BURST_SECONDS"
    done
    wait "$build_pid" || true
    sed 's/^/    /' "$WORK/build.json"
    echo
fi

# ---- optional render -------------------------------------------------------
if [ "$WITH_RENDER" = 1 ]; then
    say "starting a render alongside ${SCALE} live runtimes (768 MiB browser, 3.4 GB image)"
    render_args="$(python3 "$WORK/pick.py" render "$WORK/targets.json")"
    drive render "$render_args" > "$WORK/render.json" 2>&1 &
    render_pid=$!
    while kill -0 "$render_pid" 2>/dev/null; do
        snap
        table_row "render+rt=${SCALE}"
        if ! check_abort; then kill "$render_pid" 2>/dev/null || true; exit 1; fi
        sleep "$BURST_SECONDS"
    done
    wait "$render_pid" || true
    sed 's/^/    /' "$WORK/render.json"
    echo
fi

# ---- hold ------------------------------------------------------------------
say "holding at full scale for ${HOLD_SECONDS}s"
held=0
while [ "$held" -lt "$HOLD_SECONDS" ]; do
    sleep "$SAMPLE_SECONDS"
    held=$((held + SAMPLE_SECONDS))
    snap
    table_row "hold+${held}s"
    check_abort || exit 1
done
echo

# ---- verdict ---------------------------------------------------------------
say "measurement complete"
echo
echo "=============================================================================================="
echo " what this run says about the ceiling"
echo "=============================================================================================="
python3 - "$STEPS_CSV" "$WORK/latency.csv" "$S_MEMTOTAL" "$ABORT_MIN_AVAIL_MB" \
        "$BASELINE_AVAIL" "$BASELINE_CTR_MEM" "$NCPU" \
        "$PEAK_BUILD_MB" "$PEAK_RENDER_MB" "$PEAK_CTR_MB" "$LOW_AVAIL_MB" \
        "$S_SVC_LIMIT" "$S_SVC_TOTAL" "$S_RT_LIMIT" "$BUILD_LIMIT_MB" "$RENDER_LIMIT_MB" \
        "$PREDICT_RUNTIMES" <<'PY'
import sys

steps_path, latency_path, mem_total, floor, base_avail, base_ctr, ncpu = sys.argv[1:8]
peak_build, peak_render, peak_ctr, low_avail = (float(v) for v in sys.argv[8:12])
svc_limit, svc_count, rt_limit, build_limit, render_limit, predict = (
    float(v) for v in sys.argv[12:18])
mem_total, floor, base_avail, base_ctr = (float(mem_total), float(floor),
                                          float(base_avail), float(base_ctr))
ncpu = int(ncpu)
# The ramp leaves no runtime behind at the end of a --scale 0 style run, so fall
# back to the documented default rather than dividing by a zero limit.
if rt_limit <= 0:
    rt_limit = 256.0

rows = []
for line in open(steps_path):
    f = line.rstrip('\n').split(',')
    if not f[0].startswith('runtimes='):
        continue
    rows.append({'n': int(f[1]), 'avail': float(f[2]), 'ctr': float(f[4]),
                 'rt': float(f[5]), 'swap': float(f[6]), 'load': float(f[7]),
                 'cold': float(f[8] or 0)})

if len(rows) < 2:
    print('  Not enough ramp steps to extrapolate; run at a larger --scale.')
    sys.exit(0)

first, last = rows[0], rows[-1]
per_rt = last['rt'] / last['n'] if last['n'] else 0.0
slope = (first['avail'] - last['avail']) / (last['n'] - first['n'])
headroom = last['avail'] - floor
colds = sorted(r['cold'] for r in rows if r['cold'])

print(f"  measured, at {last['n']} live runtimes:")
print(f"    per-runtime resident memory        {per_rt:8.1f} MB  (cgroup limit 256 MB)")
print(f"    MemAvailable consumed per runtime  {slope:8.1f} MB")
print(f"    all containers resident            {last['ctr']:8.1f} MB  (baseline {base_ctr:.0f} MB)")
print(f"    MemAvailable                       {last['avail']:8.1f} MB  (baseline {base_avail:.0f} MB)")
print(f"    swap in use                        {last['swap']:8.1f} MB")
print(f"    load average                       {last['load']:8.2f}     on {ncpu} cores")
if peak_build:
    print(f"    build container, peak resident     {peak_build:8.1f} MB  (BUILD_MEMORY_MB allowance 2048)")
if peak_render:
    print(f"    render container, peak resident    {peak_render:8.1f} MB  (cgroup limit 768 MB)")
print(f"    all containers, peak resident      {peak_ctr:8.1f} MB")
print(f"    MemAvailable, low-water mark       {low_avail:8.1f} MB")
if colds:
    print(f"    cold start, median / worst         {colds[len(colds)//2]:8.1f} / {colds[-1]:.1f} s"
          f"  (budget is 90 s)")
try:
    lat = [line.rstrip('\n').split(',') for line in open(latency_path)]
    gw = [int(r[2]) for r in lat if r[2].isdigit()]
    wall = [int(r[4]) for r in lat if r[4].isdigit()]
    if gw:
        print(f"    warm request through the gateway   {max(gw):8d} ms  worst case")
    if wall:
        print(f"    same request including queue wait   {max(wall):7d} ms  worst case")
except Exception:
    pass
print()

# MemAvailable moves on its own — page cache, the ten real projects, the host's
# own agents. Unless the per-runtime slope is clearly larger than that movement,
# extrapolating from it is arithmetic on noise.
quiet = [float(line.split(',')[2]) for line in open(steps_path)
         if line.startswith('hold+')]
noise = (max(quiet) - min(quiet)) if len(quiet) >= 3 else 0.0

print('  extrapolated from the ramp:')
if len(rows) < 4:
    print(f"    only {len(rows)} ramp steps. Too few to fit a slope; re-run at --scale 8 or")
    print('    more before quoting a number. The budget arithmetic below does not depend')
    print('    on the ramp length and is the better guide until then.')
elif slope <= 0:
    print('    memory did not move measurably across the ramp, so no memory ceiling is')
    print('    visible at this scale.')
elif slope <= noise:
    print(f"    the per-runtime slope ({slope:.0f} MB) is inside the {noise:.0f} MB that")
    print('    MemAvailable moved on its own while the host was merely holding. No ceiling')
    print('    can be read out of this run; re-run at a larger --scale.')
else:
    more = headroom / slope
    print(f"    {headroom:.0f} MB of headroom above the {floor:.0f} MB floor at {slope:.0f} MB per")
    print(f"    runtime (against {noise:.0f} MB of idle drift) leaves room for about {more:.0f} more,")
    print(f"    i.e. a ceiling near {last['n'] + more:.0f} concurrent runtimes on top of the real")
    print('    projects already on this host.')
print()

print('  which resource binds first:')
binding = []
if slope > noise and slope > 0 and headroom / slope < 30:
    binding.append(f"memory: {slope:.0f} MB per runtime against {headroom:.0f} MB of headroom")
if last['load'] > ncpu:
    binding.append(f"CPU: load {last['load']:.2f} already exceeds {ncpu} cores")
if last['swap'] > first['swap'] + 50:
    binding.append(f"swap: grew {last['swap'] - first['swap']:.0f} MB across the ramp")
print('    ' + ('\n    '.join(binding) if binding
      else 'nothing is close at the scale this run reached.'))
print()

# The other half of the answer, and the half that does not depend on how far
# this particular run got: what the cgroup limits add up to. Every figure here
# is read from `docker stats`, which reports each container's limit alongside
# its usage, so nothing had to be inspected and no compose file had to be read.
def line(label, value, note=''):
    print(f"    {label:<36}{value:8.0f} MB{'  ' + note if note else ''}")

print(f"  budget arithmetic for {predict:.0f} runtimes + 1 build + 1 render:")
line('platform services, sum of limits', svc_limit, f"({int(svc_count)} containers)")
line(f"{predict:.0f} runtimes at {rt_limit:.0f} MB", predict * rt_limit)
line('one build', build_limit, '(BUILD_MEMORY_MB)')
line('one render', render_limit)
total_limit = svc_limit + predict * rt_limit + build_limit + render_limit
print(f"    {'':36}--------")
line('everything at its limit', total_limit, f"against {mem_total:.0f} MB of RAM")
if total_limit > mem_total:
    print(f"    -> the limits over-commit RAM by {total_limit - mem_total:.0f} MB "
          f"({total_limit / mem_total:.2f}x).")
    print('       That is not a prediction of failure: a limit is a ceiling, not a')
    print('       reservation. It is the statement that nothing but tenant restraint')
    print('       stands between this host and the OOM killer if every container')
    print('       actually used what it is allowed.')
else:
    print('    -> the limits fit in RAM with no over-commitment.')
print()
if per_rt > 0:
    services_now = last['ctr'] - last['rt']
    expected_ctr = services_now + predict * per_rt + peak_build + peak_render
    expected_avail = last['avail'] - (expected_ctr - last['ctr'])
    print('  the same arithmetic with measured numbers instead of limits:')
    line('platform services, as measured', services_now)
    line(f"{predict:.0f} runtimes at {per_rt:.0f} MB measured", predict * per_rt)
    line('one build, measured peak', peak_build,
         '' if peak_build else '(no build ran; this term is missing)')
    line('one render, measured peak', peak_render,
         '' if peak_render else '(no render ran; this term is missing)')
    print(f"    {'':36}--------")
    line('expected container resident', expected_ctr)
    line('-> MemAvailable would land near', expected_avail, f"against a {floor:.0f} MB floor")
print()

print('  what this run cannot tell you:')
print('    * the disposable app imports nothing, so per-runtime resident memory is a')
print('      floor. A real tenant runtime holding a database pool sits higher, and the')
print('      256 MB cgroup limit is the only hard bound.')
print('    * these are steady-state numbers. Simultaneous cold starts are a CPU event,')
print('      not a memory one, and the executor serialises them two at a time; this ramp')
print('      starts one runtime at a time on purpose.')
PY
echo
