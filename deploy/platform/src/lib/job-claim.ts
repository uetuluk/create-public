import {randomUUID} from 'node:crypto'

/**
 * Job claiming, leases, and the concurrency limits around them.
 *
 * Extracted from executor.ts so the SQL can be asserted without a database, the
 * way lib/enqueue.ts already is.
 */

export type JobKind =
    | 'provision_project'
    | 'build_version'
    | 'deploy_version'
    | 'start_runtime'
    | 'stop_runtime'
    | 'delete_project'
    | 'measure_usage'
    | 'render_version'
    | 'export_database'
    | 'probe_version'
    | 'review_site'
    | 'capture_showcase'

/**
 * Kinds that each occupy roughly a whole CPU for their duration: the node build
 * and deno cache containers, the Playwright browser, and pg_dump, plus the
 * site review and the showcase capture, each of which is a render with a model
 * call after it. On a two-core host
 * at most one of these should run at a time; `deploy_version` and
 * `start_runtime` are deliberately absent, because their cost is database and
 * I/O wait, and they are exactly what should occupy a second worker while a
 * build holds the first.
 */
export const HEAVY_KINDS: readonly JobKind[] = [
    'build_version', 'render_version', 'export_database', 'review_site', 'capture_showcase',
]

/**
 * How long a job of each kind may run before the executor stops renewing its
 * lease and lets the sweeper reclaim it.
 *
 * This is deliberately *not* the lease. The predecessor conflated the two — a
 * 15-minute "lease" that was really a runtime cap — so a legitimate 12-minute
 * build was requeued while it was still running, and a second worker then built
 * the same version into the same directory. Separating them lets a crashed
 * worker be reclaimed in two minutes while a slow-but-alive build is left alone.
 */
export const MAX_JOB_SECONDS: Record<JobKind, number> = {
    provision_project: 300,
    build_version: 900,
    deploy_version: 1200,
    start_runtime: 300,
    stop_runtime: 180,
    delete_project: 600,
    measure_usage: 180,
    render_version: 300,
    export_database: 400,
    probe_version: 300,
    // A render, plus a completion on a shared proxy that may be retried twice.
    review_site: 600,
    // The same shape as a review: one render, then one short completion.
    capture_showcase: 600,
}

/** Identifies one worker slot. Distinct per slot, and per process start. */
export function workerId(index: number, bootNonce: string): string {
    return `${process.env.HOSTNAME ?? 'executor'}:${process.pid}:${index}:${bootNonce}`
}

export function bootNonce(): string {
    // Without this a restart that recycles a pid could produce a live worker
    // whose id collides with a lease row left by its predecessor.
    return randomUUID().slice(0, 8)
}

/**
 * Serialises claiming across workers.
 *
 * This lock is the mechanism, not an optimisation. `FOR UPDATE SKIP LOCKED`
 * locks only the rows the outer query returns — it does not lock the rows the
 * per-project `NOT EXISTS` inspects. Under READ COMMITTED, worker A can claim a
 * job for project P and not yet have committed when worker B takes its snapshot;
 * B's `NOT EXISTS` then sees no running job for P and claims a second one. Every
 * same-project race returns, just rarely enough to be very hard to reproduce.
 *
 * Taking a transaction-scoped advisory lock first makes each claim see every
 * previously committed claim, because READ COMMITTED takes a fresh snapshot per
 * statement. The claim is a sub-millisecond indexed query and jobs run for
 * seconds to minutes, so serialising it costs nothing.
 */
export const CLAIM_LOCK_SQL =
    `SELECT pg_try_advisory_xact_lock(hashtext('ritsdev-executor-claim')) AS locked`

/**
 * Selects the next claimable job.
 *
 * $1 heavy kinds, $2 lease seconds, $3 true when a heavy slot is free.
 *
 * The two exclusions are both bounded by `locked_at > now() - lease` so that a
 * job orphaned by a crashed worker stops blocking its project, and stops holding
 * a heavy slot, after one lease period rather than forever.
 */
export const CLAIM_SELECT_SQL =
    `SELECT j.id, j.kind, j.project_id, j.version_id, j.deployment_id, j.attempts
     FROM jobs j
     WHERE j.status = 'queued' AND j.run_after <= now()
       AND ($3 OR NOT (j.kind = ANY($1)))
       AND NOT EXISTS (
           SELECT 1 FROM jobs r
           WHERE r.status = 'running'
             AND r.project_id = j.project_id
             AND r.locked_at > now() - make_interval(secs => $2))
     ORDER BY j.created_at
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1`

/** Counts running heavy jobs, so the claim can tell whether a slot is free. */
export const HEAVY_RUNNING_SQL =
    `SELECT count(*)::int AS running FROM jobs
     WHERE status = 'running' AND kind = ANY($1)
       AND locked_at > now() - make_interval(secs => $2)`

export const CLAIM_UPDATE_SQL =
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1
     WHERE id = $1`

/**
 * Terminal updates are guarded by ownership.
 *
 * Without the guard, a worker whose lease was reclaimed still overwrites the
 * state of the row its successor now owns — marking a version failed that the
 * new owner is in the middle of rebuilding.
 */
export const TERMINAL_SUCCESS_SQL =
    `UPDATE jobs SET status = 'succeeded', finished_at = now(), error_message = NULL
     WHERE id = $1 AND status = 'running' AND locked_by = $2
     RETURNING id`

export const TERMINAL_FAILURE_SQL =
    `UPDATE jobs
     SET status = $3,
         run_after = CASE WHEN $3 = 'queued' THEN now() + interval '30 seconds' ELSE run_after END,
         finished_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END,
         error_message = $4
     WHERE id = $1 AND status = 'running' AND locked_by = $2
     RETURNING id`

export const RENEW_LEASE_SQL =
    `UPDATE jobs SET locked_at = now()
     WHERE id = $1 AND status = 'running' AND locked_by = $2
     RETURNING id`

/**
 * Hands work back on a clean shutdown instead of leaving it to time out.
 *
 * `attempts - 1` matters: the claim incremented it, and a restart must not
 * consume one of the two retries the failure path allows.
 */
export const RELEASE_LEASES_SQL =
    `UPDATE jobs
     SET status = 'queued', run_after = now(), locked_at = NULL, locked_by = NULL,
         attempts = GREATEST(attempts - 1, 0),
         error_message = 'executor restarting; requeued'
     WHERE id = ANY($1) AND status = 'running'
     RETURNING id`

/** Reclaims jobs whose worker stopped renewing. Single interval, by design. */
export const SWEEP_LEASES_SQL =
    `UPDATE jobs
     SET status = 'queued', run_after = now(), locked_at = NULL, locked_by = NULL,
         error_message = 'worker lease expired; safely requeued'
     WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)
     RETURNING id, kind`

export function executorConcurrency(env: NodeJS.ProcessEnv): number {
    return readPositiveInt(env, 'EXECUTOR_CONCURRENCY', 2)
}

export function heavyConcurrency(env: NodeJS.ProcessEnv): number {
    const heavy = readPositiveInt(env, 'EXECUTOR_HEAVY_CONCURRENCY', 1)
    // A heavy allowance above the worker count cannot be honoured anyway, and
    // reads as a bigger budget than exists.
    return Math.min(heavy, executorConcurrency(env))
}

export function leaseSeconds(env: NodeJS.ProcessEnv): number {
    return readPositiveInt(env, 'EXECUTOR_LEASE_SECONDS', 120)
}

/** Renewal has to happen comfortably inside the lease, not at its edge. */
export function renewIntervalMs(env: NodeJS.ProcessEnv): number {
    return Math.floor((leaseSeconds(env) * 1000) / 3)
}

export function shutdownGraceMs(env: NodeJS.ProcessEnv): number {
    return readPositiveInt(env, 'EXECUTOR_SHUTDOWN_GRACE_MS', 30_000)
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const raw = env[key]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`)
    }
    return value
}
