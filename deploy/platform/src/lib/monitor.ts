import type {Pool} from 'pg'
import {
    EMPTY_STATE, inputAvailability, RULES_BY_ID, rulesForInput, step, thresholds, USED_INPUTS,
    type AlertState, type Rule,
} from './alert-rules'
import {deploymentFromEnv, type DeploymentConfig} from './deployment'
import {diskUsage, memInfo, swapInPages, swapInRate, type SwapInSample} from './host-metrics'
import {readExecutorSnapshot} from './metrics'
import {mailerFromEnv, type Mailer} from './mailer'

/**
 * Evaluates alert rules and mails the transitions.
 *
 * This runs in the **control plane, not the executor**, for one decisive
 * reason: if it lived in the executor then "the executor is down" would be
 * unevaluable, and the single most important alert would be the one that can
 * never fire.
 *
 * Evaluation and recording happen inside a transaction; sending happens outside
 * it, so a slow relay never holds a database transaction open.
 */

export interface MonitorDeps {
    pool: Pool
    env: NodeJS.ProcessEnv
    /** Overridable for tests. */
    now?: () => number
    /** Overridable for tests. */
    mailer?: Mailer
    /** Overridable for tests: the host files are absent on a developer's machine. */
    meminfoPath?: string
    vmstatPath?: string
}

type Observation = {rule: string; subject: string; value: number; breaching: boolean}

const MONITOR_LOCK_SQL = `SELECT pg_try_advisory_xact_lock(hashtext('ritsdev-monitor')) AS locked`

export class MonitorService {
    private timer: NodeJS.Timeout | null = null
    private readonly mailer: Mailer | null
    private readonly deployment: DeploymentConfig
    private readonly now: () => number
    /** Previous /proc/vmstat reading; the swap-in rate is a difference. */
    private previousSwapIn: SwapInSample | null = null
    private lastMissingInputs: string | null = null

    constructor(private readonly deps: MonitorDeps) {
        this.now = deps.now ?? (() => Date.now())
        this.deployment = deploymentFromEnv(deps.env)
        this.mailer = deps.mailer ?? mailerFromEnv(deps.env, this.deployment.heloName)
        console.warn(this.mailer
            ? `[monitor] alerts will be mailed via ${this.mailer.describe}`
            : '[monitor] no mail transport is configured; alerts will be recorded but not mailed')
    }

    start(): void {
        const interval = Number(this.deps.env.MONITOR_INTERVAL_MS ?? 60_000)
        const tick = () => {
            this.runOnce().catch(error => console.error('[monitor] evaluation failed', error))
        }
        this.timer = setInterval(tick, interval)
        this.timer.unref?.()
        setTimeout(tick, 5_000).unref?.()
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    async runOnce(): Promise<void> {
        const observations = await this.observe()
        const transitions = await this.record(observations)
        if (transitions.length) await this.deliver(transitions)
        await this.drainQueued()
    }

    /** Gathers every signal the rules consume. */
    private async observe(): Promise<Observation[]> {
        const limits = thresholds(this.deps.env)
        const out: Observation[] = []
        const add = (rule: string, subject: string, value: number, breaching: boolean) =>
            out.push({rule, subject, value, breaching})

        let databaseUp = true
        try {
            await this.deps.pool.query('SELECT 1')
        } catch {
            databaseUp = false
        }
        add('postgres_unreachable', '', 1, !databaseUp)
        // Everything below reads the database; without it there is nothing more
        // to say, and the rule above is the one that matters.
        if (!databaseUp) return out

        const query = async <T extends Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> =>
            (await this.deps.pool.query<T>(sql, params)).rows

        const [backlog] = await query<{due: number; failed: number; longest: number | null}>(`
            SELECT
              count(*) FILTER (WHERE status = 'queued' AND run_after <= now())::int AS due,
              count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '15 minutes')::int AS failed,
              max(extract(epoch FROM now() - locked_at)) FILTER (WHERE status = 'running')::float8 AS longest
            FROM jobs`)
        add('job_queue_backlog', '', backlog.due, backlog.due > limits.job_queue_backlog)
        add('job_failures', '', backlog.failed, backlog.failed > limits.job_failures)
        add('job_running_too_long', '', backlog.longest ?? 0, (backlog.longest ?? 0) > limits.job_running_too_long)

        const [waits] = await query<{p95: number | null}>(`
            SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM locked_at - created_at))::float8 AS p95
            FROM jobs WHERE locked_at IS NOT NULL AND created_at > now() - interval '15 minutes'`)
        add('job_queue_wait_high', '', waits.p95 ?? 0, (waits.p95 ?? 0) > limits.job_queue_wait_high)

        const [builds] = await query<{p95: number | null}>(`
            SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - created_at))::float8 AS p95
            FROM versions WHERE finished_at IS NOT NULL AND finished_at > now() - interval '24 hours'`)
        add('build_duration_high', '', builds.p95 ?? 0, (builds.p95 ?? 0) > limits.build_duration_high)

        const [cold] = await query<{failures: number; p95: number | null}>(`
            SELECT
              count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '30 minutes')::int AS failures,
              percentile_disc(0.95) WITHIN GROUP (
                ORDER BY extract(epoch FROM finished_at - locked_at))
                FILTER (WHERE status = 'succeeded' AND finished_at > now() - interval '1 hour')::float8 AS p95
            FROM jobs WHERE kind = 'start_runtime'`)
        add('cold_start_failures', '', cold.failures, cold.failures >= limits.cold_start_failures)
        add('cold_start_latency', '', cold.p95 ?? 0, (cold.p95 ?? 0) > limits.cold_start_latency)

        for (const row of await query<{slug: string}>(
            `SELECT p.slug FROM project_runtime r JOIN projects p ON p.id = r.project_id WHERE r.state = 'failed'`)) {
            add('runtime_failed', row.slug, 1, true)
        }

        const usage = await query<{
            slug: string; db_fraction: number | null; object_fraction: number | null; measured_age: number | null
        }>(`
            SELECT p.slug,
                   (r.postgres_bytes::float8 / NULLIF(p.database_bytes_max, 0))::float8 AS db_fraction,
                   (r.object_bytes::float8 / NULLIF(p.object_bytes_max, 0))::float8 AS object_fraction,
                   extract(epoch FROM now() - r.measured_at)::float8 AS measured_age
            FROM projects p JOIN project_resources r ON r.project_id = p.id
            WHERE p.status NOT IN ('deleted', 'deleting')`)
        let stalest = 0
        for (const row of usage) {
            const db = row.db_fraction ?? 0
            const objects = row.object_fraction ?? 0
            add('db_quota_warn', row.slug, db, db > limits.quota_warn_fraction)
            add('db_quota_crit', row.slug, db, db > limits.quota_crit_fraction)
            add('object_quota_warn', row.slug, objects, objects > limits.quota_warn_fraction)
            add('object_quota_crit', row.slug, objects, objects > limits.quota_crit_fraction)
            stalest = Math.max(stalest, row.measured_age ?? 0)
        }
        add('usage_measurement_stale', '', stalest, stalest > limits.usage_measurement_stale)

        // The latest review of each project that has one, so a verdict that
        // improves clears the alert the previous one raised. Projects with no
        // review produce no observation at all: there is nothing to say about a
        // page that has not been looked at, and saying "clean" would be a lie.
        for (const row of await query<{slug: string; level: string}>(`
            SELECT DISTINCT ON (s.project_id) p.slug, s.level
            FROM site_reviews s JOIN projects p ON p.id = s.project_id
            WHERE p.status NOT IN ('deleted', 'deleting') AND p.access_mode <> 'owner'
            ORDER BY s.project_id, s.created_at DESC`)) {
            add('site_review_flagged', row.slug, 1, row.level === 'urgent')
        }

        const [delivery] = await query<{failed: number}>(
            `SELECT count(*)::int AS failed FROM alert_deliveries
             WHERE status = 'failed' AND created_at > now() - interval '1 hour'`)
        add('alert_delivery_failing', '', delivery.failed, delivery.failed >= 1)

        const opsAges = await query<{kind: string; age: number}>(
            `SELECT kind, extract(epoch FROM now() - max(created_at))::float8 AS age
             FROM ops_events WHERE status = 'success' GROUP BY kind`)
        const ageOf = (kind: string) => opsAges.find(row => row.kind === kind)?.age ?? Number.POSITIVE_INFINITY
        add('backup_age', '', ageOf('backup'), ageOf('backup') > limits.backup_age)
        add('restore_drill_age', '', ageOf('restore'), ageOf('restore') > limits.restore_drill_age)

        // Host and container signals.
        const snapshot = await readExecutorSnapshot(
            this.deps.env.EXECUTOR_METRICS_FILE ?? '/data/metrics/executor.json')
        const snapshotAge = snapshot?.writtenAt ? (this.now() - snapshot.writtenAt) / 1000 : Number.POSITIVE_INFINITY
        add('executor_snapshot_stale', '', snapshotAge, snapshotAge > limits.executor_snapshot_stale)
        for (const service of snapshot?.services ?? []) {
            add('service_down', service.name, service.running ? 1 : 0, !service.running)
            add('service_unhealthy', service.name, 1, service.health === 'unhealthy')
        }
        for (const runtime of snapshot?.runtimes ?? []) {
            add('runtime_oom', runtime.slug, 1, runtime.oomKilled)
        }

        const disk = await diskUsage(this.deps.env.DATA_ROOT ?? '/data')
        if (disk) {
            add('disk_free_warn', '', disk.freeBytes, disk.freeBytes < limits.disk_free_warn)
            add('disk_free_crit', '', disk.freeBytes, disk.freeBytes < limits.disk_free_crit)
        }
        const memory = await memInfo(this.deps.meminfoPath)
        if (memory.availableBytes !== null) {
            add('memory_available_warn', '', memory.availableBytes, memory.availableBytes < limits.memory_available_warn)
            add('memory_available_crit', '', memory.availableBytes, memory.availableBytes < limits.memory_available_crit)
        }
        if (memory.swapTotalBytes && memory.swapUsedBytes !== null) {
            const fraction = memory.swapUsedBytes / memory.swapTotalBytes
            add('swap_used', '', fraction, fraction > limits.swap_used_fraction)
        }
        const pages = await swapInPages(this.deps.vmstatPath)
        if (pages !== null) {
            const sample = {pages, at: this.now()}
            const rate = this.previousSwapIn ? swapInRate(this.previousSwapIn, sample) : null
            this.previousSwapIn = sample
            // Null on the first pass after a restart and after a reboot: there
            // is nothing to difference yet. The input is still readable, so the
            // rule is not dead, and the next pass has a rate.
            if (rate !== null) add('swap_in_rate', '', rate, rate > limits.swap_in_rate)
        }

        this.reportInputs(add, {
            snapshot: snapshot !== null,
            disk: disk !== null,
            meminfo: memory.availableBytes !== null,
            // A host with swap switched off reports SwapTotal 0, and `swap_used`
            // has no denominator: that is a dead rule too, not a healthy zero.
            swap: memory.swapTotalBytes !== null && memory.swapTotalBytes > 0,
            vmstat: pages !== null,
        })

        const gatewayUrl = this.deps.env.GATEWAY_INTERNAL_URL ?? 'http://gateway:3001'
        add('gateway_unhealthy', '', 1, !(await probe(`${gatewayUrl}/healthz`)))
        // End to end: DNS, the Cloudflare edge, the tunnel, and this app. A
        // better signal than cloudflared's own opinion of itself, and it needs
        // no debug endpoint on that container.
        const publicUrl = this.deployment.publicBaseUrl
        add('tunnel_unreachable', '', 1, !(await probe(`${publicUrl}/healthz`)))

        return out
    }

    /**
     * Reports which rule inputs this pass could read.
     *
     * One observation per input **every pass**, not only for the missing ones:
     * an observation that appears only while something is wrong can never
     * clear, which would be the same silence moved somewhere else. The rule it
     * feeds is an ordinary alert, so a dead rule mails, shows up in
     * `GET /v1/ops/alerts`, and resolves itself when the input comes back.
     *
     * The log line is written only when the set changes, so an unreadable input
     * says so at the first evaluation after a restart and then stops repeating.
     */
    private reportInputs(
        add: (rule: string, subject: string, value: number, breaching: boolean) => void,
        present: Parameters<typeof inputAvailability>[0],
    ): void {
        const available = inputAvailability(present)
        for (const input of USED_INPUTS) {
            add('alert_rule_unevaluable', input, rulesForInput(input).length, !available[input])
        }
        const missing = USED_INPUTS.filter(input => !available[input])
        const fingerprint = missing.join(',')
        if (fingerprint === this.lastMissingInputs) return
        this.lastMissingInputs = fingerprint
        if (!missing.length) {
            console.log('[monitor] every alert rule input is readable')
            return
        }
        for (const input of missing) {
            console.warn(`[monitor] ${input} is not readable here, so these rules cannot be evaluated: `
                + rulesForInput(input).map(rule => rule.id).join(', '))
        }
    }

    /** Applies the state machine and returns the transitions worth mailing. */
    private async record(observations: Observation[]): Promise<Array<{rule: Rule; subject: string; value: number; kind: string}>> {
        const renotifyMs = Number(this.deps.env.ALERT_RENOTIFY_MINUTES ?? 360) * 60_000
        const transitions: Array<{rule: Rule; subject: string; value: number; kind: string}> = []
        const client = await this.deps.pool.connect()
        try {
            await client.query('BEGIN')
            // A second control-plane replica must not double-mail.
            const lock = await client.query<{locked: boolean}>(MONITOR_LOCK_SQL)
            if (!lock.rows[0]?.locked) {
                await client.query('ROLLBACK')
                return []
            }
            for (const observation of observations) {
                const rule = RULES_BY_ID.get(observation.rule)
                if (!rule) continue
                const existing = await client.query<{
                    state: string; breach_count: number; clear_count: number
                    fired_at: Date | null; notified_at: Date | null
                }>(
                    `SELECT state, breach_count, clear_count, fired_at, notified_at
                     FROM alerts WHERE rule = $1 AND subject = $2`,
                    [rule.id, observation.subject],
                )
                const previous: AlertState = existing.rows[0]
                    ? {
                        state: existing.rows[0].state as AlertState['state'],
                        breachCount: existing.rows[0].breach_count,
                        clearCount: existing.rows[0].clear_count,
                        firedAt: existing.rows[0].fired_at?.getTime() ?? null,
                        notifiedAt: existing.rows[0].notified_at?.getTime() ?? null,
                    }
                    : EMPTY_STATE
                const {next, transition} = step(rule, previous, observation.breaching, this.now(), renotifyMs)
                await client.query(
                    `INSERT INTO alerts (rule, subject, state, severity, value, threshold, summary,
                                         breach_count, clear_count, first_breach_at, last_eval_at,
                                         fired_at, resolved_at, notified_at, notify_attempts)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                             CASE WHEN $8 > 0 THEN now() ELSE NULL END, now(),
                             $10, CASE WHEN $3 = 'resolved' THEN now() ELSE NULL END, $11, 0)
                     ON CONFLICT (rule, subject) DO UPDATE SET
                        state = EXCLUDED.state, severity = EXCLUDED.severity, value = EXCLUDED.value,
                        threshold = EXCLUDED.threshold, summary = EXCLUDED.summary,
                        breach_count = EXCLUDED.breach_count, clear_count = EXCLUDED.clear_count,
                        first_breach_at = CASE WHEN EXCLUDED.breach_count = 1 THEN now() ELSE alerts.first_breach_at END,
                        last_eval_at = now(),
                        fired_at = EXCLUDED.fired_at,
                        resolved_at = CASE WHEN EXCLUDED.state = 'resolved' THEN now() ELSE alerts.resolved_at END,
                        notified_at = EXCLUDED.notified_at,
                        notify_attempts = alerts.notify_attempts + CASE WHEN $12 THEN 1 ELSE 0 END`,
                    [
                        rule.id, observation.subject, next.state, rule.severity, observation.value,
                        rule.threshold, rule.summary(observation.value, observation.subject),
                        next.breachCount, next.clearCount,
                        next.firedAt ? new Date(next.firedAt) : null,
                        next.notifiedAt ? new Date(next.notifiedAt) : null,
                        transition !== null,
                    ],
                )
                if (transition) transitions.push({rule, subject: observation.subject, value: observation.value, kind: transition})
            }
            await client.query('COMMIT')
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
        return transitions
    }

    /**
     * One email per pass containing every transition, not one per alert. When a
     * host problem trips twenty project rules at once that is the difference
     * between one message and twenty.
     */
    private async deliver(transitions: Array<{rule: Rule; subject: string; value: number; kind: string}>): Promise<void> {
        const recipients = (this.deps.env.ALERT_TO ?? '').split(',').map(v => v.trim()).filter(Boolean)
        const critical = transitions.filter(t => t.rule.severity === 'critical' && t.kind !== 'resolved').length
        const firing = transitions.filter(t => t.kind !== 'resolved').length
        const host = this.deployment.domain
        const subject = `[${critical ? 'CRITICAL' : 'warning'}] ${host}: `
            + `${firing} firing, ${transitions.length - firing} resolved`
        const body = [
            `Platform: ${host}`,
            `Evaluated: ${new Date(this.now()).toISOString()}`,
            '',
            ...transitions.map(t => {
                const verb = t.kind === 'resolved' ? 'RESOLVED' : t.kind === 'reminder' ? 'STILL FIRING' : 'FIRING'
                const subjectPart = t.subject ? ` [${t.subject}]` : ''
                return `${verb} ${t.rule.severity.toUpperCase()} ${t.rule.id}${subjectPart}\n    ${t.rule.summary(t.value, t.subject)}`
            }),
            '',
            'Current state: GET /v1/ops/alerts, or the metrics endpoint.',
        ].join('\n')

        await this.deps.pool.query(
            `INSERT INTO alert_deliveries (transition, recipients, subject, body, status)
             VALUES ($1,$2,$3,$4,'queued')`,
            [critical ? 'firing' : firing ? 'firing' : 'resolved', recipients.join(','), subject, body],
        )
    }

    /** Sends queued deliveries. Claimed the same way jobs are, so two passes cannot double-send. */
    private async drainQueued(): Promise<void> {
        const claimed = await this.deps.pool.query<{id: string; recipients: string; subject: string; body: string}>(
            `UPDATE alert_deliveries SET status = 'sending', attempts = attempts + 1
             WHERE id IN (
                 SELECT id FROM alert_deliveries
                 WHERE status = 'queued' AND attempts < 3
                 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 5)
             RETURNING id, recipients, subject, body`,
        )
        for (const delivery of claimed.rows) {
            const recipients = delivery.recipients.split(',').map(v => v.trim()).filter(Boolean)
            if (!this.mailer || !recipients.length) {
                // Marked failed rather than left queued, which would grow
                // without bound while looking like work in progress.
                await this.deps.pool.query(
                    `UPDATE alert_deliveries SET status = 'failed', error_message = $2 WHERE id = $1`,
                    [delivery.id, this.mailer ? 'no ALERT_TO recipients configured' : 'no mail transport configured'],
                )
                continue
            }
            try {
                await this.mailer.send({
                    from: this.deployment.alertFrom,
                    to: recipients,
                    subject: delivery.subject,
                    body: delivery.body,
                })
                await this.deps.pool.query(
                    `UPDATE alert_deliveries SET status = 'sent', sent_at = now(), error_message = NULL WHERE id = $1`,
                    [delivery.id],
                )
            } catch (error) {
                const message = this.mailer.redact(error)
                console.error(`[monitor] alert delivery failed: ${message}`)
                await this.deps.pool.query(
                    `UPDATE alert_deliveries
                     SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END, error_message = $2
                     WHERE id = $1`,
                    [delivery.id, message],
                )
            }
        }
    }
}

async function probe(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, {signal: AbortSignal.timeout(10_000)})
        return response.ok
    } catch {
        return false
    }
}
