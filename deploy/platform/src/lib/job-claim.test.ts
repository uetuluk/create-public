import assert from 'node:assert/strict'
import test from 'node:test'
import {
    bootNonce,
    CLAIM_LOCK_SQL,
    CLAIM_SELECT_SQL,
    CLAIM_UPDATE_SQL,
    executorConcurrency,
    heavyConcurrency,
    HEAVY_KINDS,
    HEAVY_RUNNING_SQL,
    leaseSeconds,
    MAX_JOB_SECONDS,
    RELEASE_LEASES_SQL,
    RENEW_LEASE_SQL,
    renewIntervalMs,
    SWEEP_LEASES_SQL,
    TERMINAL_FAILURE_SQL,
    TERMINAL_SUCCESS_SQL,
    workerId,
    type JobKind,
} from './job-claim'

test('the claim takes an advisory lock, and it is the try_ variant', () => {
    // FOR UPDATE SKIP LOCKED locks only the rows the outer query returns, not
    // the rows the per-project NOT EXISTS inspects. Under READ COMMITTED,
    // worker A can claim a job for project P and not yet have committed when B
    // takes its snapshot; B's NOT EXISTS then sees no running job for P and
    // claims a second one. Serialising the claim is what makes the exclusion
    // real, so this ordering is load-bearing rather than an optimisation.
    assert.match(CLAIM_LOCK_SQL, /pg_try_advisory_xact_lock\(hashtext\('ritsdev-executor-claim'\)\)/)
    // The blocking form would hold a pool client while waiting.
    assert.doesNotMatch(CLAIM_LOCK_SQL, /pg_advisory_xact_lock\(/)
    assert.doesNotMatch(CLAIM_LOCK_SQL, /\bFROM\s+jobs\b/i)
})

test('the claim excludes projects that already have a running job', () => {
    assert.match(CLAIM_SELECT_SQL, /NOT EXISTS/)
    assert.match(CLAIM_SELECT_SQL, /r\.project_id = j\.project_id/)
    // project_id is nullable. IS NOT DISTINCT FROM would make every
    // null-project job serialise against every other one for no reason.
    assert.doesNotMatch(CLAIM_SELECT_SQL, /IS NOT DISTINCT FROM/)
})

test('both exclusions expire with the lease, so a dead worker stops blocking', () => {
    for (const sql of [CLAIM_SELECT_SQL, HEAVY_RUNNING_SQL]) {
        assert.match(sql, /locked_at > now\(\) - make_interval\(secs => \$2\)/)
    }
})

test('SKIP LOCKED is retained and scoped to the claimed row', () => {
    assert.match(CLAIM_SELECT_SQL, /FOR UPDATE OF j SKIP LOCKED/)
    assert.match(CLAIM_SELECT_SQL, /ORDER BY j\.created_at/)
    assert.match(CLAIM_SELECT_SQL, /LIMIT 1/)
})

test('heavy kinds are the ones that each take a whole core', () => {
    assert.deepEqual([...HEAVY_KINDS], [
        'build_version', 'render_version', 'export_database', 'review_site', 'capture_showcase',
    ])
    // review_site and capture_showcase both run the same Playwright container
    // render_version does, so each costs the same core and must queue behind a
    // build rather than beside it.
    // deploy_version and start_runtime wait on the database and on Docker, so
    // they are exactly what should occupy a second worker while a build runs.
    assert.ok(!HEAVY_KINDS.includes('deploy_version' as JobKind))
    assert.ok(!HEAVY_KINDS.includes('start_runtime' as JobKind))
    assert.match(CLAIM_SELECT_SQL, /\(\$3 OR NOT \(j\.kind = ANY\(\$1\)\)\)/)
})

test('terminal updates only apply to a job this worker still owns', () => {
    for (const sql of [TERMINAL_SUCCESS_SQL, TERMINAL_FAILURE_SQL, RENEW_LEASE_SQL]) {
        assert.match(sql, /status = 'running'/)
        assert.match(sql, /locked_by = \$2/)
        assert.match(sql, /RETURNING id/)
    }
})

test('the failure path keeps its retry backoff', () => {
    assert.match(TERMINAL_FAILURE_SQL, /now\(\) \+ interval '30 seconds'/)
    assert.match(TERMINAL_FAILURE_SQL, /CASE WHEN \$3 = 'queued'/)
})

test('a shutdown requeue gives back the attempt the claim consumed', () => {
    // Otherwise every restart burns one of the two retries the failure path
    // allows, and a job that has been through two restarts can never run.
    assert.match(RELEASE_LEASES_SQL, /attempts = GREATEST\(attempts - 1, 0\)/)
    assert.doesNotMatch(RELEASE_LEASES_SQL, /attempts \+ 1/)
    assert.match(RELEASE_LEASES_SQL, /status = 'queued'/)
    assert.match(RELEASE_LEASES_SQL, /locked_by = NULL/)
})

test('the lease sweep uses one interval rather than a per-kind CASE', () => {
    // The per-kind numbers were runtime caps mislabelled as leases, which is
    // why a legitimate long build could be requeued while still running.
    assert.doesNotMatch(SWEEP_LEASES_SQL, /CASE WHEN kind/)
    assert.match(SWEEP_LEASES_SQL, /make_interval\(secs => \$1\)/)
})

test('the claim update stamps the worker that won it', () => {
    assert.match(CLAIM_UPDATE_SQL, /locked_by = \$2/)
    assert.match(CLAIM_UPDATE_SQL, /attempts = attempts \+ 1/)
})

test('every job kind has a maximum runtime', () => {
    const kinds: JobKind[] = [
        'provision_project', 'build_version', 'deploy_version', 'start_runtime', 'stop_runtime',
        'delete_project', 'measure_usage', 'render_version', 'export_database', 'probe_version',
        'review_site', 'capture_showcase',
    ]
    for (const kind of kinds) {
        assert.ok(Number.isInteger(MAX_JOB_SECONDS[kind]) && MAX_JOB_SECONDS[kind] > 0, kind)
    }
    assert.equal(Object.keys(MAX_JOB_SECONDS).length, kinds.length)
    // A build legitimately runs for minutes; its cap has to exceed the two
    // five-minute container timeouts it can incur back to back.
    assert.ok(MAX_JOB_SECONDS.build_version >= 900)
})

test('renewal happens well inside the lease', () => {
    // Asserted as a property so the two cannot be tuned independently into a
    // combination where a live job loses its lease.
    for (const seconds of ['60', '120', '600']) {
        const env = {EXECUTOR_LEASE_SECONDS: seconds}
        assert.ok(renewIntervalMs(env) * 2 < leaseSeconds(env) * 1000, seconds)
    }
})

test('concurrency settings default sanely and reject nonsense', () => {
    assert.equal(executorConcurrency({}), 2)
    assert.equal(heavyConcurrency({}), 1)
    assert.equal(leaseSeconds({}), 120)
    for (const bad of ['0', '-1', '1.5', 'two']) {
        assert.throws(() => executorConcurrency({EXECUTOR_CONCURRENCY: bad}), /positive integer/, bad)
    }
})

test('the heavy allowance can never exceed the worker count', () => {
    const env = {EXECUTOR_CONCURRENCY: '2', EXECUTOR_HEAVY_CONCURRENCY: '8'}
    assert.equal(heavyConcurrency(env), 2)
})

test('worker identities are unique per slot and per process start', () => {
    const nonce = bootNonce()
    assert.notEqual(workerId(0, nonce), workerId(1, nonce))
    assert.match(workerId(0, nonce), new RegExp(`:${process.pid}:0:`))
    // A restart that recycles a pid must not produce an id matching a lease row
    // left behind by its predecessor.
    assert.notEqual(bootNonce(), bootNonce())
})
