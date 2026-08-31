import {readFile} from 'node:fs/promises'
import type {Pool} from 'pg'
import {inputAvailability, RULES, type InputAvailability} from './alert-rules'
import {diskUsage, memInfo, pressure, swapInPages, PAGE_BYTES} from './host-metrics'
import {bucketize, render, type Counters, type Family, type Histogram, type Sample} from './prometheus'

/**
 * Every metric is derived from tables the platform already writes — jobs,
 * versions, deployments, project_runtime, project_resources — plus a snapshot
 * the executor leaves on disk for the things only it can see. No new
 * instrumentation was added to the hot paths for anything below.
 *
 * Site visit analytics is the one thing in the system that does write from a
 * request path, and it is deliberately not here. It is product data an owner
 * asked for rather than operator telemetry, it cannot be derived from anything
 * else because a visit is not otherwise written down, and its numbers describe
 * one tenant's audience rather than the platform's health. `/metrics` does not
 * expose it: doing so would put per-project visitor counts on the operator
 * scrape, which is a wider audience than the owner who asked for them.
 *
 * Cold-start latency needs none either: for a `start_runtime` job,
 * `finished_at - locked_at` *is* the cold start, from claim to health check.
 */

/** Seconds. Chosen to straddle the interesting range for a 90s cold start. */
export const DURATION_BOUNDS = [1, 5, 15, 60, 300, 900]

export const JOBS_BY_STATE_SQL =
    `SELECT kind, status, count(*)::int AS count FROM jobs GROUP BY kind, status`

export const JOB_QUEUE_WAIT_SQL =
    `SELECT kind, extract(epoch FROM locked_at - created_at)::float8 AS seconds
     FROM jobs
     WHERE locked_at IS NOT NULL AND created_at > now() - interval '1 hour'`

export const JOB_DURATION_SQL =
    `SELECT kind, extract(epoch FROM finished_at - locked_at)::float8 AS seconds
     FROM jobs
     WHERE finished_at IS NOT NULL AND locked_at IS NOT NULL
       AND finished_at > now() - interval '1 hour'`

export const JOB_RUNNING_AGE_SQL =
    `SELECT kind, max(extract(epoch FROM now() - locked_at))::float8 AS seconds
     FROM jobs WHERE status = 'running' AND locked_at IS NOT NULL GROUP BY kind`

export const JOB_QUEUE_DEPTH_SQL =
    `SELECT count(*)::int AS due FROM jobs WHERE status = 'queued' AND run_after <= now()`

export const BUILD_DURATION_SQL =
    `SELECT extract(epoch FROM finished_at - created_at)::float8 AS seconds
     FROM versions
     WHERE finished_at IS NOT NULL AND status IN ('ready', 'failed')
       AND finished_at > now() - interval '24 hours'`

export const DEPLOY_LATENCY_SQL =
    `SELECT extract(epoch FROM activated_at - created_at)::float8 AS seconds
     FROM deployments
     WHERE status = 'active' AND activated_at IS NOT NULL
       AND created_at > now() - interval '24 hours'`

/**
 * Superseded deployments are marked failed by design when a newer one takes
 * over, so counting them as failures would report a deploy failure every time
 * someone deploys twice.
 */
export const DEPLOY_FAILED_SQL =
    `SELECT count(*)::int AS count FROM deployments
     WHERE status = 'failed' AND error_message IS DISTINCT FROM 'superseded'
       AND created_at > now() - interval '24 hours'`

export const RUNTIMES_SQL =
    `SELECT state, count(*)::int AS count FROM project_runtime GROUP BY state`

export const PROJECTS_SQL =
    `SELECT status, count(*)::int AS count FROM projects GROUP BY status`

export const PROJECT_USAGE_SQL =
    `SELECT p.slug,
            r.postgres_bytes::float8 AS postgres_bytes,
            p.database_bytes_max::float8 AS postgres_bytes_max,
            r.object_bytes::float8 AS object_bytes,
            p.object_bytes_max::float8 AS object_bytes_max,
            extract(epoch FROM now() - r.measured_at)::float8 AS measured_age
     FROM projects p JOIN project_resources r ON r.project_id = p.id
     WHERE p.status NOT IN ('deleted')`

export const LOGS_SQL =
    `SELECT source, level, count(*)::int AS count FROM project_logs
     WHERE created_at > now() - interval '5 minutes' GROUP BY source, level`

export const ALERTS_SQL =
    `SELECT rule, severity, count(*)::int AS count FROM alerts WHERE state = 'firing'
     GROUP BY rule, severity`

export const DELIVERY_HEALTH_SQL =
    `SELECT
        count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '1 hour')::int AS failed_recent,
        extract(epoch FROM now() - max(sent_at) FILTER (WHERE status = 'sent'))::float8 AS last_success_age
     FROM alert_deliveries`

/**
 * The current verdict on each site anyone on the network can reach, plus how
 * many of those verdicts were reached with no model opinion behind them.
 *
 * Both numbers matter, and the second is the one that would otherwise go
 * missing: a review recorded without a model is a review carried entirely by
 * the static signals, which is a working check but a narrower one. A binding
 * that quietly stopped answering looks exactly like a platform with no binding
 * configured, and only this says so.
 *
 * The left join is what makes it useful: every project at `network` appears,
 * including the ones with no review at all, which are the ones an operator
 * would otherwise have no way to notice.
 */
export const SITE_REVIEW_SQL =
    `WITH latest AS (
         SELECT DISTINCT ON (s.project_id) s.project_id, s.level, s.model_unavailable
         FROM site_reviews s
         ORDER BY s.project_id, s.created_at DESC
     )
     SELECT p.slug, l.level, l.model_unavailable
     FROM projects p LEFT JOIN latest l ON l.project_id = p.id
     WHERE p.access_mode <> 'owner' AND p.status NOT IN ('deleted', 'deleting')`

export const OPS_EVENT_AGE_SQL =
    `SELECT kind, extract(epoch FROM now() - max(created_at))::float8 AS age
     FROM ops_events WHERE status = 'success' GROUP BY kind`

export type ExecutorSnapshot = {
    writtenAt?: number
    concurrency?: number
    workersBusy?: number
    services?: Array<{name: string; running: boolean; health: string; restarts: number}>
    runtimes?: Array<{slug: string; cpuPercent: number; memoryBytes: number; pids: number; oomKilled: boolean}>
}

export async function readExecutorSnapshot(path: string): Promise<ExecutorSnapshot | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as ExecutorSnapshot
    } catch {
        // Absent on a fresh install and stale if the executor has died; both are
        // reported as a large snapshot age rather than a missing scrape.
        return null
    }
}

/**
 * One sample per configured rule, always, whether or not its input arrived.
 *
 * The bug this answers was a metric family that disappeared along with its
 * source: absence read as "nothing to report", and two rules were dead for
 * months without a trace. A family that is always emitted cannot do that — it
 * goes to 0 and names both the rule and the source it wanted.
 */
export function ruleEvaluabilitySamples(available: InputAvailability): Sample[] {
    return RULES.map(rule => ({
        labels: {rule: rule.id, input: rule.input},
        value: available[rule.input] ? 1 : 0,
    }))
}

function groupSeconds(rows: Array<{kind: string; seconds: number}>): Histogram['series'] {
    const byKind = new Map<string, number[]>()
    for (const row of rows) {
        if (row.seconds === null || !Number.isFinite(row.seconds)) continue
        const list = byKind.get(row.kind) ?? []
        list.push(row.seconds)
        byKind.set(row.kind, list)
    }
    return [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, values]) => ({
        labels: {kind},
        ...bucketize(values, DURATION_BOUNDS),
    }))
}

export async function collect(options: {
    pool: Pool
    counters: Counters
    snapshotPath: string
    dataRoot: string
    perProject: boolean
}): Promise<string> {
    const {pool, counters, snapshotPath, dataRoot, perProject} = options
    const parts: Array<Family | Histogram> = []
    const query = async <T extends Record<string, any>>(sql: string): Promise<T[]> =>
        (await pool.query<T>(sql)).rows

    const [jobs, queueWait, durations, runningAge, depth, builds, deploys, deployFailed,
        runtimes, projects, usage, logs, alerts, delivery, siteReviews, opsAges] = await Promise.all([
        query<{kind: string; status: string; count: number}>(JOBS_BY_STATE_SQL),
        query<{kind: string; seconds: number}>(JOB_QUEUE_WAIT_SQL),
        query<{kind: string; seconds: number}>(JOB_DURATION_SQL),
        query<{kind: string; seconds: number}>(JOB_RUNNING_AGE_SQL),
        query<{due: number}>(JOB_QUEUE_DEPTH_SQL),
        query<{seconds: number}>(BUILD_DURATION_SQL),
        query<{seconds: number}>(DEPLOY_LATENCY_SQL),
        query<{count: number}>(DEPLOY_FAILED_SQL),
        query<{state: string; count: number}>(RUNTIMES_SQL),
        query<{status: string; count: number}>(PROJECTS_SQL),
        query<Record<string, string | number>>(PROJECT_USAGE_SQL),
        query<{source: string; level: string; count: number}>(LOGS_SQL),
        query<{rule: string; severity: string; count: number}>(ALERTS_SQL),
        query<{failed_recent: number; last_success_age: number | null}>(DELIVERY_HEALTH_SQL),
        query<{slug: string; level: string | null; model_unavailable: boolean | null}>(SITE_REVIEW_SQL),
        query<{kind: string; age: number}>(OPS_EVENT_AGE_SQL),
    ])

    parts.push({
        name: 'ritsdev_jobs',
        help: 'Jobs by kind and status. A gauge over the whole table, not a counter.',
        type: 'gauge',
        samples: jobs.map(row => ({labels: {kind: row.kind, status: row.status}, value: row.count})),
    })
    parts.push({
        name: 'ritsdev_jobs_due',
        help: 'Queued jobs whose run_after has passed: the real backlog.',
        type: 'gauge',
        samples: [{value: depth[0]?.due ?? 0}],
    })
    parts.push({
        name: 'ritsdev_job_queue_wait_seconds',
        help: 'Time from enqueue to claim, over the last hour.',
        bounds: DURATION_BOUNDS,
        series: groupSeconds(queueWait),
    })
    parts.push({
        name: 'ritsdev_job_duration_seconds',
        help: 'Time from claim to finish, over the last hour. kind="start_runtime" is cold-start latency.',
        bounds: DURATION_BOUNDS,
        series: groupSeconds(durations),
    })
    parts.push({
        name: 'ritsdev_job_running_age_seconds',
        help: 'Age of the oldest running job of each kind; detects a wedged worker.',
        type: 'gauge',
        samples: runningAge.map(row => ({labels: {kind: row.kind}, value: row.seconds ?? 0})),
    })
    parts.push({
        name: 'ritsdev_build_duration_seconds',
        help: 'Version build wall clock over the last 24 hours.',
        bounds: DURATION_BOUNDS,
        series: [{...bucketize(builds.map(row => row.seconds), DURATION_BOUNDS)}],
    })
    parts.push({
        name: 'ritsdev_deploy_latency_seconds',
        help: 'Deployment request to activation over the last 24 hours.',
        bounds: DURATION_BOUNDS,
        series: [{...bucketize(deploys.map(row => row.seconds), DURATION_BOUNDS)}],
    })
    parts.push({
        name: 'ritsdev_deployments_failed',
        help: 'Genuinely failed deployments in the last 24 hours, excluding superseded ones.',
        type: 'gauge',
        samples: [{value: deployFailed[0]?.count ?? 0}],
    })
    parts.push({
        name: 'ritsdev_runtimes',
        help: 'Function runtimes by recorded state.',
        type: 'gauge',
        samples: runtimes.map(row => ({labels: {state: row.state}, value: row.count})),
    })
    parts.push({
        name: 'ritsdev_projects',
        help: 'Projects by status.',
        type: 'gauge',
        samples: projects.map(row => ({labels: {status: row.status}, value: row.count})),
    })
    parts.push({
        name: 'ritsdev_project_logs',
        help: 'Project log lines in the last five minutes, by source and level.',
        type: 'gauge',
        samples: logs.map(row => ({labels: {source: row.source, level: row.level}, value: row.count})),
    })

    if (perProject) {
        const usageFamily = (name: string, help: string, key: string): Family => ({
            name, help, type: 'gauge',
            samples: usage.map(row => ({labels: {slug: String(row.slug)}, value: Number(row[key] ?? 0)})),
        })
        parts.push(usageFamily('ritsdev_project_postgres_bytes', 'Measured database size per project.', 'postgres_bytes'))
        parts.push(usageFamily('ritsdev_project_postgres_bytes_max', 'Database quota per project.', 'postgres_bytes_max'))
        parts.push(usageFamily('ritsdev_project_object_bytes', 'Measured object storage per project.', 'object_bytes'))
        parts.push(usageFamily('ritsdev_project_object_bytes_max', 'Object storage quota per project.', 'object_bytes_max'))
        parts.push(usageFamily('ritsdev_project_usage_age_seconds', 'Age of the last usage measurement.', 'measured_age'))
    }

    // Host signals.
    const disk = await diskUsage(dataRoot)
    if (disk) {
        parts.push({name: 'ritsdev_data_free_bytes', help: 'Free space on the data filesystem.', type: 'gauge', samples: [{value: disk.freeBytes}]})
        parts.push({name: 'ritsdev_data_total_bytes', help: 'Size of the data filesystem.', type: 'gauge', samples: [{value: disk.totalBytes}]})
    }
    const memory = await memInfo()
    if (memory.availableBytes !== null) {
        parts.push({name: 'ritsdev_host_mem_available_bytes', help: 'Host memory available.', type: 'gauge', samples: [{value: memory.availableBytes}]})
    }
    if (memory.swapTotalBytes !== null && memory.swapUsedBytes !== null) {
        parts.push({name: 'ritsdev_host_swap_used_bytes', help: 'Host swap in use.', type: 'gauge', samples: [{value: memory.swapUsedBytes}]})
        parts.push({name: 'ritsdev_host_swap_total_bytes', help: 'Host swap configured.', type: 'gauge', samples: [{value: memory.swapTotalBytes}]})
    }
    // pswpin is a genuine kernel counter, so unlike almost everything else here
    // a scraper can rate() it. That rate is what the swap_in_rate alert reads.
    const swapIn = await swapInPages()
    if (swapIn !== null) {
        parts.push({
            name: 'ritsdev_host_swap_in_bytes_total',
            help: 'Bytes faulted back in from swap since boot. A counter, not a window.',
            type: 'counter',
            samples: [{value: swapIn * PAGE_BYTES}],
        })
    }
    // Exported wherever the kernel supplies it, though no alert rule reads it:
    // this host has no PSI. See alert-rules.ts.
    for (const resource of ['memory', 'io'] as const) {
        const stalled = await pressure(resource)
        if (stalled !== null) {
            parts.push({
                name: `ritsdev_host_psi_${resource}_avg60`,
                help: `Percentage of the last 60s stalled on ${resource}.`,
                type: 'gauge',
                samples: [{value: stalled}],
            })
        }
    }

    // Executor snapshot: service health and container stats, which only the
    // process holding the Docker socket can see.
    const snapshot = await readExecutorSnapshot(snapshotPath)
    parts.push({
        name: 'ritsdev_executor_snapshot_age_seconds',
        help: 'Age of the executor snapshot. Large means the executor is not running.',
        type: 'gauge',
        samples: [{value: snapshot?.writtenAt ? (Date.now() - snapshot.writtenAt) / 1000 : Number.POSITIVE_INFINITY}],
    })
    if (snapshot?.services?.length) {
        parts.push({
            name: 'ritsdev_service_up',
            help: '1 when the container is running.',
            type: 'gauge',
            samples: snapshot.services.map(s => ({labels: {service: s.name}, value: s.running ? 1 : 0})),
        })
        parts.push({
            name: 'ritsdev_service_healthy',
            help: '1 when the container reports a healthy healthcheck, 0 when unhealthy, absent when it has none.',
            type: 'gauge',
            samples: snapshot.services.filter(s => s.health === 'healthy' || s.health === 'unhealthy')
                .map(s => ({labels: {service: s.name}, value: s.health === 'healthy' ? 1 : 0})),
        })
        parts.push({
            name: 'ritsdev_service_restarts',
            help: 'Container restart count.',
            type: 'gauge',
            samples: snapshot.services.map(s => ({labels: {service: s.name}, value: s.restarts})),
        })
    }
    if (perProject && snapshot?.runtimes?.length) {
        parts.push({
            name: 'ritsdev_runtime_memory_bytes',
            help: 'Function runtime memory in use.',
            type: 'gauge',
            samples: snapshot.runtimes.map(r => ({labels: {slug: r.slug}, value: r.memoryBytes})),
        })
        parts.push({
            name: 'ritsdev_runtime_oom_killed',
            help: '1 when the runtime container was last killed by the OOM killer.',
            type: 'gauge',
            samples: snapshot.runtimes.map(r => ({labels: {slug: r.slug}, value: r.oomKilled ? 1 : 0})),
        })
    }
    if (snapshot?.concurrency !== undefined) {
        parts.push({name: 'ritsdev_executor_concurrency', help: 'Configured worker count.', type: 'gauge', samples: [{value: snapshot.concurrency}]})
        parts.push({name: 'ritsdev_executor_workers_busy', help: 'Workers currently running a job.', type: 'gauge', samples: [{value: snapshot.workersBusy ?? 0}]})
    }

    parts.push({
        name: 'ritsdev_alert_rule_evaluable',
        help: '1 when the source a rule reads was readable at scrape time, 0 when the rule cannot fire at all.',
        type: 'gauge',
        samples: ruleEvaluabilitySamples(inputAvailability({
            snapshot: snapshot !== null,
            disk: disk !== null,
            meminfo: memory.availableBytes !== null,
            swap: memory.swapTotalBytes !== null && memory.swapTotalBytes > 0,
            vmstat: swapIn !== null,
        })),
    })
    parts.push({
        name: 'ritsdev_alerts_firing',
        help: 'Alerts currently firing.',
        type: 'gauge',
        samples: alerts.map(row => ({labels: {rule: row.rule, severity: row.severity}, value: row.count})),
    })
    parts.push({
        name: 'ritsdev_alert_deliveries_failed_recent',
        help: 'Alert deliveries that failed in the last hour.',
        type: 'gauge',
        samples: [{value: delivery[0]?.failed_recent ?? 0}],
    })
    if (delivery[0]?.last_success_age !== null && delivery[0]?.last_success_age !== undefined) {
        parts.push({
            name: 'ritsdev_alert_last_delivery_age_seconds',
            help: 'Time since an alert email last went out successfully.',
            type: 'gauge',
            samples: [{value: delivery[0].last_success_age}],
        })
    }
    // Always emitted, including as all-zero. A family that appears only once
    // there is something to report is one nobody notices the absence of, which
    // is how two alert rules stayed dead for months (#63).
    const reviewLevels = ['clean', 'review', 'urgent', 'none'] as const
    parts.push({
        name: 'ritsdev_site_reviews',
        help: 'Sites at network access by their latest review verdict. "none" has never been reviewed.',
        type: 'gauge',
        samples: reviewLevels.map(level => ({
            labels: {level},
            value: siteReviews.filter(row => (row.level ?? 'none') === level).length,
        })),
    })
    parts.push({
        name: 'ritsdev_site_reviews_without_model',
        help: 'Sites whose latest review had no usable model opinion, and so rests on the static signals alone.',
        type: 'gauge',
        samples: [{value: siteReviews.filter(row => row.level !== null && row.model_unavailable !== false).length}],
    })

    if (opsAges.length) {
        parts.push({
            name: 'ritsdev_ops_event_age_seconds',
            help: 'Time since the last successful backup or restore drill.',
            type: 'gauge',
            samples: opsAges.map(row => ({labels: {kind: row.kind}, value: row.age})),
        })
    }

    counters.increment('ritsdev_metrics_scrapes_total')
    const snapshotCounters = counters.snapshot()
    for (const [name, value] of Object.entries(snapshotCounters)) {
        parts.push({name, help: 'Process-local monotonic counter since start.', type: 'counter', samples: [{value}]})
    }

    return render(parts)
}
