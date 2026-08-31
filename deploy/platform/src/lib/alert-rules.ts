import {z} from 'zod'

/**
 * Alert rules, in code rather than a table.
 *
 * They are typed, reviewed alongside the evaluator, and unit-testable. Only the
 * thresholds move at runtime, through a validated ALERT_THRESHOLDS override.
 *
 * `for` and `clearAfter` are counts of consecutive evaluation passes, not
 * durations, so they scale with MONITOR_INTERVAL_MS. `clearAfter` is
 * deliberately not 1 for anything that can flap: one good pass should not
 * declare a problem over.
 */

export type Severity = 'warning' | 'critical'

/**
 * Where a rule's numbers come from. Declared per rule so that an input which
 * never arrives can be *reported* rather than quietly skipped: two rules once
 * read PSI on a kernel that has none, and because the evaluator simply had
 * nothing to add for them, they neither fired nor errored for months.
 *
 * `internal` is for values the control plane computes itself — an HTTP probe, a
 * file's absence, the rule table — which cannot fail to arrive. Everything else
 * names a source that can be missing on some host or in some container.
 */
export const RULE_INPUTS = [
    'internal', 'control_db', 'executor_snapshot',
    'host_disk', 'host_meminfo', 'host_swap', 'host_vmstat',
] as const

export type RuleInput = (typeof RULE_INPUTS)[number]

export type Rule = {
    id: string
    severity: Severity
    /** Consecutive breaching passes before it fires. */
    for: number
    /** Consecutive clear passes before it resolves. */
    clearAfter: number
    threshold: number
    input: RuleInput
    summary: (value: number, subject: string) => string
}

export const DEFAULT_THRESHOLDS = {
    job_queue_backlog: 10,
    job_queue_wait_high: 300,
    job_failures: 3,
    job_running_too_long: 1200,
    build_duration_high: 240,
    cold_start_failures: 2,
    cold_start_latency: 60,
    disk_free_warn: 40 * 1024 ** 3,
    disk_free_crit: 20 * 1024 ** 3,
    memory_available_warn: 1500 * 1024 ** 2,
    memory_available_crit: 300 * 1024 ** 2,
    swap_in_rate: 5 * 1024 ** 2,
    swap_used_fraction: 0.5,
    quota_warn_fraction: 0.8,
    quota_crit_fraction: 0.95,
    usage_measurement_stale: 1800,
    executor_snapshot_stale: 180,
    backup_age: 36 * 3600,
    restore_drill_age: 40 * 86400,
}

export const thresholdsSchema = z.object(
    Object.fromEntries(Object.keys(DEFAULT_THRESHOLDS).map(key => [key, z.number().positive().optional()])),
).strict()

export function thresholds(env: NodeJS.ProcessEnv): typeof DEFAULT_THRESHOLDS {
    if (!env.ALERT_THRESHOLDS) return {...DEFAULT_THRESHOLDS}
    const parsed = thresholdsSchema.parse(JSON.parse(env.ALERT_THRESHOLDS))
    return {...DEFAULT_THRESHOLDS, ...parsed}
}

const bytes = (value: number) => `${(value / 1024 ** 3).toFixed(1)} GiB`
const mib = (value: number) => `${Math.round(value / 1024 ** 2)} MiB`

/**
 * Warning and critical are separate rules with separate rows rather than one
 * row whose severity escalates. It keeps the state machine trivial and makes
 * each transition independently testable.
 */
export const RULES: Rule[] = [
    {id: 'service_down', severity: 'critical', for: 3, clearAfter: 3, threshold: 1, input: 'executor_snapshot',
        summary: (_v, subject) => `service ${subject} is not running`},
    {id: 'service_unhealthy', severity: 'critical', for: 3, clearAfter: 3, threshold: 1, input: 'executor_snapshot',
        summary: (_v, subject) => `service ${subject} reports an unhealthy healthcheck`},
    // Its input is the snapshot's *age*, which the control plane can compute
    // whether or not the file exists; a missing snapshot reads as infinitely
    // old, which is the alert.
    {id: 'executor_snapshot_stale', severity: 'critical', for: 2, clearAfter: 2, threshold: DEFAULT_THRESHOLDS.executor_snapshot_stale, input: 'internal',
        summary: value => `the executor has not published a snapshot for ${Math.round(value)}s; it may be down`},
    {id: 'postgres_unreachable', severity: 'critical', for: 2, clearAfter: 2, threshold: 1, input: 'internal',
        summary: () => 'the control database did not answer'},
    {id: 'gateway_unhealthy', severity: 'critical', for: 3, clearAfter: 3, threshold: 1, input: 'internal',
        summary: () => 'the site gateway health check failed'},
    {id: 'tunnel_unreachable', severity: 'critical', for: 3, clearAfter: 3, threshold: 1, input: 'internal',
        summary: () => 'the public URL did not answer through the Cloudflare tunnel'},

    {id: 'job_queue_backlog', severity: 'warning', for: 5, clearAfter: 3, threshold: DEFAULT_THRESHOLDS.job_queue_backlog, input: 'control_db',
        summary: value => `${Math.round(value)} jobs are queued and due`},
    {id: 'job_queue_wait_high', severity: 'warning', for: 3, clearAfter: 3, threshold: DEFAULT_THRESHOLDS.job_queue_wait_high, input: 'control_db',
        summary: value => `jobs are waiting ${Math.round(value)}s before being claimed`},
    {id: 'job_failures', severity: 'warning', for: 2, clearAfter: 3, threshold: DEFAULT_THRESHOLDS.job_failures, input: 'control_db',
        summary: value => `${Math.round(value)} jobs failed in the last 15 minutes`},
    // Load-bearing for concurrency: once the lease renews rather than expiring,
    // a wedged-but-alive worker holds its project's slot indefinitely. The old
    // fixed sweep was acting as an accidental watchdog; this replaces it.
    {id: 'job_running_too_long', severity: 'critical', for: 2, clearAfter: 2, threshold: DEFAULT_THRESHOLDS.job_running_too_long, input: 'control_db',
        summary: value => `a job has been running for ${Math.round(value)}s; a worker may be wedged`},
    {id: 'build_duration_high', severity: 'warning', for: 5, clearAfter: 5, threshold: DEFAULT_THRESHOLDS.build_duration_high, input: 'control_db',
        summary: value => `builds are taking ${Math.round(value)}s`},
    {id: 'cold_start_failures', severity: 'warning', for: 2, clearAfter: 3, threshold: DEFAULT_THRESHOLDS.cold_start_failures, input: 'control_db',
        summary: value => `${Math.round(value)} cold starts failed in the last 30 minutes`},
    {id: 'cold_start_latency', severity: 'warning', for: 3, clearAfter: 3, threshold: DEFAULT_THRESHOLDS.cold_start_latency, input: 'control_db',
        summary: value => `cold starts are taking ${Math.round(value)}s`},
    {id: 'runtime_failed', severity: 'warning', for: 2, clearAfter: 2, threshold: 1, input: 'control_db',
        summary: (_v, subject) => `the runtime for ${subject} is in the failed state`},
    {id: 'runtime_oom', severity: 'warning', for: 1, clearAfter: 3, threshold: 1, input: 'executor_snapshot',
        summary: (_v, subject) => `the runtime for ${subject} was killed by the OOM killer`},

    {id: 'disk_free_warn', severity: 'warning', for: 3, clearAfter: 2, threshold: DEFAULT_THRESHOLDS.disk_free_warn, input: 'host_disk',
        summary: value => `data filesystem free space is down to ${bytes(value)}`},
    {id: 'disk_free_crit', severity: 'critical', for: 3, clearAfter: 3, threshold: DEFAULT_THRESHOLDS.disk_free_crit, input: 'host_disk',
        summary: value => `data filesystem free space is down to ${bytes(value)}`},

    // These two replaced `memory_pressure_warn`/`_crit`, which read
    // /proc/pressure. RHEL 9 ships PSI compiled in but disabled without `psi=1`
    // at boot, so on this host the file does not exist and both rules evaluated
    // never — see issue #63.
    //
    // MemAvailable is not "free memory". It is the kernel's own estimate of what
    // a new allocation could get without swapping, reclaimable page cache
    // already counted in, which is exactly the objection that made PSI the first
    // choice: a host with several gigabytes of healthy cache reports a healthy
    // MemAvailable and an alarming MemFree. The floors come from
    // deploy/scripts/gate-capacity.sh, where they carried the abort decision
    // through the capacity run on this host: 1500 MB is the pre-flight floor,
    // below which the harness will not start work, and 300 MB is the abort
    // floor, below which it tears a run down.
    {id: 'memory_available_warn', severity: 'warning', for: 5, clearAfter: 5, threshold: DEFAULT_THRESHOLDS.memory_available_warn, input: 'host_meminfo',
        summary: value => `host memory available is down to ${mib(value)}`},
    {id: 'memory_available_crit', severity: 'critical', for: 5, clearAfter: 5, threshold: DEFAULT_THRESHOLDS.memory_available_crit, input: 'host_meminfo',
        summary: value => `host memory available is down to ${mib(value)}`},
    // The other half of the substitution, and the one that is a stall rather
    // than a level: pages being faulted back *in* from swap mean the host is
    // already paying for the memory it does not have. 5 MiB/s sustained is
    // GATE_ABORT_SWAPIN_KBPS=5120 from the same script.
    {id: 'swap_in_rate', severity: 'critical', for: 5, clearAfter: 5, threshold: DEFAULT_THRESHOLDS.swap_in_rate, input: 'host_vmstat',
        summary: value => `the host has been swapping in at ${mib(value)}/s; it is thrashing`},
    {id: 'swap_used', severity: 'warning', for: 5, clearAfter: 5, threshold: DEFAULT_THRESHOLDS.swap_used_fraction, input: 'host_swap',
        summary: value => `${Math.round(value * 100)}% of swap is in use`},

    {id: 'db_quota_warn', severity: 'warning', for: 2, clearAfter: 2, threshold: DEFAULT_THRESHOLDS.quota_warn_fraction, input: 'control_db',
        summary: (value, subject) => `${subject} is at ${Math.round(value * 100)}% of its database quota`},
    {id: 'db_quota_crit', severity: 'critical', for: 2, clearAfter: 2, threshold: DEFAULT_THRESHOLDS.quota_crit_fraction, input: 'control_db',
        summary: (value, subject) => `${subject} is at ${Math.round(value * 100)}% of its database quota`},
    {id: 'object_quota_warn', severity: 'warning', for: 2, clearAfter: 2, threshold: DEFAULT_THRESHOLDS.quota_warn_fraction, input: 'control_db',
        summary: (value, subject) => `${subject} is at ${Math.round(value * 100)}% of its object storage quota`},
    {id: 'object_quota_crit', severity: 'critical', for: 2, clearAfter: 2, threshold: DEFAULT_THRESHOLDS.quota_crit_fraction, input: 'control_db',
        summary: (value, subject) => `${subject} is at ${Math.round(value * 100)}% of its object storage quota`},
    {id: 'usage_measurement_stale', severity: 'warning', for: 3, clearAfter: 3, threshold: DEFAULT_THRESHOLDS.usage_measurement_stale, input: 'control_db',
        summary: value => `project usage has not been measured for ${Math.round(value / 60)} minutes`},

    // Fires on day one, deliberately: there are no off-host backups yet, and a
    // rule that nags is more honest than one commented out.
    {id: 'backup_age', severity: 'critical', for: 1, clearAfter: 1, threshold: DEFAULT_THRESHOLDS.backup_age, input: 'control_db',
        summary: value => Number.isFinite(value)
            ? `the last successful backup was ${Math.round(value / 3600)} hours ago`
            : 'no successful backup has ever been recorded'},
    {id: 'restore_drill_age', severity: 'warning', for: 1, clearAfter: 1, threshold: DEFAULT_THRESHOLDS.restore_drill_age, input: 'control_db',
        summary: value => Number.isFinite(value)
            ? `the last restore drill was ${Math.round(value / 86400)} days ago`
            : 'no restore drill has ever been recorded'},
    {id: 'alert_delivery_failing', severity: 'warning', for: 1, clearAfter: 1, threshold: 1, input: 'control_db',
        summary: value => `${Math.round(value)} alert emails failed to send in the last hour`},

    // Fires on one pass and clears on one, unlike every measurement above it. A
    // review is a recorded fact rather than a sample: it does not flap, and
    // waiting for a second identical pass would only delay the mail.
    //
    // Warning, not critical. The verdict is a judgement about a page, it never
    // takes a site down, and a student building a sign-in form is a normal
    // thing that will land here sometimes. It should cost an operator a look
    // the same working day, not wake anyone.
    //
    // Its input is `control_db`: the reviews are rows the executor writes, read
    // by the same query pass as everything else here. Note what that does and
    // does not cover — a readable table says the rule can be evaluated, not
    // that any site has been reviewed. A project that was never enqueued has no
    // row and produces no observation, which is silence of a kind this file
    // cannot detect. `ritsdev_site_reviews` is where that shows.
    {id: 'site_review_flagged', severity: 'warning', for: 1, clearAfter: 1, threshold: 1, input: 'control_db',
        summary: (_v, subject) => `the latest automated review of ${subject} came back urgent;`
            + ' read it with GET /v1/ops/site-reviews. It flags, it never blocks, and a site can serve'
            + ' one page to the reviewer and another to visitors'},

    // The rule that watches the other rules. One alert per input, so it clears
    // per input too, and its own input is the rule table, which is always here.
    {id: 'alert_rule_unevaluable', severity: 'warning', for: 2, clearAfter: 2, threshold: 1, input: 'internal',
        summary: (value, subject) => `${Math.round(value)} alert rules cannot be evaluated because ${subject}`
            + ` is not readable on this host: ${rulesForInput(subject).map(rule => rule.id).join(', ')}`},
]

export const RULES_BY_ID = new Map(RULES.map(rule => [rule.id, rule]))

/** The rules that go dead if `input` is missing. Empty for an unknown input. */
export function rulesForInput(input: string): Rule[] {
    return RULES.filter(rule => rule.input === input)
}

/**
 * Which sources a pass actually managed to read. Total over `RuleInput` on
 * purpose: adding a rule with a new kind of input will not compile until this
 * says how to tell whether that input arrived.
 */
export type InputAvailability = Record<RuleInput, boolean>

export function inputAvailability(present: {
    snapshot: boolean
    disk: boolean
    meminfo: boolean
    swap: boolean
    vmstat: boolean
}): InputAvailability {
    return {
        internal: true,
        // Both callers reach this having already queried the database. When it
        // is down, `postgres_unreachable` is the rule that says so.
        control_db: true,
        executor_snapshot: present.snapshot,
        host_disk: present.disk,
        host_meminfo: present.meminfo,
        host_swap: present.swap,
        host_vmstat: present.vmstat,
    }
}

/** The inputs at least one rule depends on, in declaration order. */
export const USED_INPUTS: RuleInput[] = RULE_INPUTS.filter(input => rulesForInput(input).length > 0)

export type AlertState = {
    state: 'pending' | 'firing' | 'resolved'
    breachCount: number
    clearCount: number
    firedAt: number | null
    notifiedAt: number | null
}

export type Transition = {kind: 'firing' | 'resolved' | 'reminder'; rule: Rule; subject: string; value: number}

export const EMPTY_STATE: AlertState = {
    state: 'pending', breachCount: 0, clearCount: 0, firedAt: null, notifiedAt: null,
}

/**
 * Advances one alert's state machine by a single evaluation.
 * Pure, so the flapping behaviour is testable without a database or a clock.
 */
export function step(
    rule: Rule,
    previous: AlertState,
    breaching: boolean,
    now: number,
    renotifyMs: number,
): {next: AlertState; transition: Transition['kind'] | null} {
    const next: AlertState = {...previous}
    if (breaching) {
        next.breachCount = previous.breachCount + 1
        next.clearCount = 0
    } else {
        next.clearCount = previous.clearCount + 1
        next.breachCount = 0
    }

    if (breaching && next.breachCount >= rule.for && previous.state !== 'firing') {
        next.state = 'firing'
        next.firedAt = now
        next.notifiedAt = now
        return {next, transition: 'firing'}
    }
    if (!breaching && next.clearCount >= rule.clearAfter && previous.state === 'firing') {
        next.state = 'resolved'
        return {next, transition: 'resolved'}
    }
    if (previous.state === 'firing' && breaching && previous.notifiedAt !== null
        && now - previous.notifiedAt >= renotifyMs) {
        next.notifiedAt = now
        return {next, transition: 'reminder'}
    }
    return {next, transition: null}
}
