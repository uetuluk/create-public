import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DEFAULT_THRESHOLDS, EMPTY_STATE, inputAvailability, RULE_INPUTS, RULES, RULES_BY_ID,
    rulesForInput, step, thresholds, USED_INPUTS, type Rule,
} from './alert-rules'

const rule: Rule = {
    id: 'test', severity: 'warning', for: 3, clearAfter: 3, threshold: 1, input: 'internal',
    summary: () => 'test',
}
const RENOTIFY = 6 * 3600_000

function run(sequence: boolean[], candidate = rule) {
    let state = EMPTY_STATE
    const transitions: Array<string | null> = []
    let now = 0
    for (const breaching of sequence) {
        now += 60_000
        const result = step(candidate, state, breaching, now, RENOTIFY)
        state = result.next
        transitions.push(result.transition)
    }
    return {state, transitions, fired: transitions.filter(t => t === 'firing').length}
}

test('it does not fire before the required consecutive breaches', () => {
    assert.equal(run([true, true]).state.state, 'pending')
    assert.equal(run([true, true]).fired, 0)
    assert.equal(run([true, true, true]).state.state, 'firing')
})

test('it fires exactly once while the condition persists', () => {
    const {fired, transitions} = run([true, true, true, true, true, true])
    assert.equal(fired, 1)
    assert.deepEqual(transitions.slice(3), [null, null, null])
})

test('a single good pass does not resolve a flapping condition', () => {
    // The flap case: one clear evaluation in the middle of a real problem must
    // not declare it over and then re-fire on the next pass.
    const {state, transitions} = run([true, true, true, false, true, true])
    assert.equal(state.state, 'firing')
    assert.ok(!transitions.includes('resolved'))
})

test('alternating breach and clear produces no deliveries after the first', () => {
    const sequence = Array.from({length: 20}, (_, i) => i % 2 === 0)
    const {transitions} = run(sequence)
    // Never reaches three consecutive of either, so it never even fires.
    assert.deepEqual(transitions.filter(Boolean), [])
})

test('resolution happens once, and a later breach fires again', () => {
    const {transitions, state} = run([
        true, true, true, // fires
        false, false, false, // resolves
        true, true, true, // fires again
    ])
    assert.deepEqual(transitions.filter(Boolean), ['firing', 'resolved', 'firing'])
    assert.equal(state.state, 'firing')
})

test('a reminder is sent only after the renotify window', () => {
    let state = EMPTY_STATE
    let now = 0
    const seen: Array<string | null> = []
    for (let pass = 0; pass < 8; pass++) {
        now += 3600_000 // an hour per pass
        const result = step(rule, state, true, now, RENOTIFY)
        state = result.next
        seen.push(result.transition)
    }
    assert.equal(seen[2], 'firing')
    // Fired at hour 3; the first reminder cannot come before hour 9.
    assert.ok(!seen.slice(3).includes('reminder'), 'no reminder inside the window')
})

test('warning and critical are independent rules with independent state', () => {
    const warn = RULES_BY_ID.get('disk_free_warn')!
    const crit = RULES_BY_ID.get('disk_free_crit')!
    assert.notEqual(warn, crit)
    assert.equal(warn.severity, 'warning')
    assert.equal(crit.severity, 'critical')
    // The critical threshold must be the more severe of the two: less free disk.
    assert.ok(crit.threshold < warn.threshold)
})

test('every rule id is unique and every threshold is configurable', () => {
    const ids = RULES.map(r => r.id)
    assert.equal(new Set(ids).size, ids.length, 'duplicate rule id')
    for (const item of RULES) {
        assert.ok(item.for >= 1 && item.clearAfter >= 1, item.id)
        assert.ok(typeof item.summary(1, 'slug') === 'string', item.id)
    }
})

test('threshold overrides are validated, not trusted', () => {
    assert.equal(thresholds({}).job_failures, DEFAULT_THRESHOLDS.job_failures)
    assert.equal(thresholds({ALERT_THRESHOLDS: '{"job_failures": 9}'}).job_failures, 9)
    // A typo in a key must fail loudly rather than silently doing nothing.
    assert.throws(() => thresholds({ALERT_THRESHOLDS: '{"job_failure": 9}'}))
    assert.throws(() => thresholds({ALERT_THRESHOLDS: '{"job_failures": -1}'}))
})

test('the rules cover every bullet in the operations monitoring list', () => {
    for (const required of [
        'service_down', 'executor_snapshot_stale', 'postgres_unreachable', 'gateway_unhealthy',
        'tunnel_unreachable', 'job_queue_backlog', 'job_failures', 'build_duration_high',
        'cold_start_failures', 'cold_start_latency', 'runtime_oom', 'disk_free_crit',
        'memory_available_warn', 'swap_in_rate', 'swap_used', 'db_quota_warn', 'object_quota_warn',
        'backup_age', 'restore_drill_age', 'alert_delivery_failing', 'alert_rule_unevaluable',
        'site_review_flagged',
    ]) {
        assert.ok(RULES_BY_ID.has(required), `missing rule: ${required}`)
    }
})

test('no rule reads PSI, which this kernel does not have', () => {
    // Issue #63: /proc/pressure does not exist on RHEL 9 without psi=1 at boot,
    // so these two evaluated never and reported nothing at all.
    assert.ok(!RULES_BY_ID.has('memory_pressure_warn'))
    assert.ok(!RULES_BY_ID.has('memory_pressure_crit'))
})

test('the memory rules use MemAvailable floors and a swap-in rate, at the capacity gate values', () => {
    // gate-capacity.sh: GATE_PREFLIGHT_MIN_AVAIL_MB=1500, GATE_ABORT_MIN_AVAIL_MB=300,
    // GATE_ABORT_SWAPIN_KBPS=5120. Both carried the abort decision on this host.
    assert.equal(DEFAULT_THRESHOLDS.memory_available_warn, 1500 * 1024 ** 2)
    assert.equal(DEFAULT_THRESHOLDS.memory_available_crit, 300 * 1024 ** 2)
    assert.equal(DEFAULT_THRESHOLDS.swap_in_rate, 5120 * 1024)
    const warn = RULES_BY_ID.get('memory_available_warn')!
    const crit = RULES_BY_ID.get('memory_available_crit')!
    assert.equal(warn.severity, 'warning')
    assert.equal(crit.severity, 'critical')
    // Less memory left is the more severe of the two.
    assert.ok(crit.threshold < warn.threshold)
})

test('every rule declares an input, and every input can be told present or absent', () => {
    const available = inputAvailability({snapshot: true, disk: true, meminfo: true, swap: true, vmstat: true})
    for (const item of RULES) {
        assert.ok(RULE_INPUTS.includes(item.input), `${item.id} has an unknown input`)
        assert.equal(available[item.input], true, item.id)
    }
    const none = inputAvailability({snapshot: false, disk: false, meminfo: false, swap: false, vmstat: false})
    // `internal` and `control_db` are the two that cannot go missing here: one
    // is computed in process, and the other has its own rule.
    assert.deepEqual(
        RULE_INPUTS.filter(input => none[input]),
        ['internal', 'control_db'],
    )
})

test('a rule with a missing input is named, not left to be inferred', () => {
    // The point of the whole exercise: the dead rule must be identifiable from
    // the input alone, because that is all the reporter has to go on.
    assert.deepEqual(rulesForInput('host_vmstat').map(item => item.id), ['swap_in_rate'])
    assert.deepEqual(rulesForInput('host_meminfo').map(item => item.id),
        ['memory_available_warn', 'memory_available_crit'])
    assert.deepEqual(rulesForInput('nonsense'), [])
})

test('the rule that reports dead rules cannot itself go dead', () => {
    const reporter = RULES_BY_ID.get('alert_rule_unevaluable')!
    // Its input is the rule table, which is in this file; it is evaluable on
    // every pass on every host, or the detector would need a detector.
    assert.equal(reporter.input, 'internal')
    assert.ok(USED_INPUTS.includes('internal'))
    assert.ok(USED_INPUTS.every(input => rulesForInput(input).length > 0))
    // The summary names the rules, since the subject is only the input.
    assert.match(reporter.summary(1, 'host_vmstat'), /host_vmstat is not readable.*swap_in_rate/)
})

test('the site review rule fires and clears on a single pass', () => {
    // Unlike every measurement rule here, a review is a recorded fact rather
    // than a sample. It does not flap, so waiting for a second identical pass
    // would only delay the mail — and a verdict that improved should clear at
    // once rather than linger as a firing alert on a page that is now fine.
    const rule = RULES_BY_ID.get('site_review_flagged')!
    assert.equal(rule.for, 1)
    assert.equal(rule.clearAfter, 1)
    // Warning, not critical: it never takes a site down, and a student's own
    // sign-in form will land here sometimes.
    assert.equal(rule.severity, 'warning')
    // Its rows are in the control database, which the same pass already reads.
    assert.equal(rule.input, 'control_db')
    // The summary has to carry the caveat, because an operator reading the mail
    // at 2am is not going to open the runbook first.
    assert.match(rule.summary(1, 'demo'), /one page to the reviewer and another to visitors/)
})
