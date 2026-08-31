import assert from 'node:assert/strict'
import {mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {MonitorService} from './monitor'

/**
 * These drive a whole evaluation pass against a fake pool and fake host files.
 *
 * The regression they exist for is issue #63: a rule whose input never arrived
 * produced no observation, no row, no log and no metric, so two rules sat dead
 * for months. Asserting on the rows a pass writes is the only way to say "it
 * was reported" rather than "the code reads as though it reports it".
 */

type Captured = {text: string; values: unknown[]}

const MEMINFO = [
    'MemTotal:        7832580 kB',
    'MemFree:          466488 kB',
    'MemAvailable:    4618524 kB',
    'SwapTotal:       4116476 kB',
    'SwapFree:        4076732 kB',
].join('\n')

const vmstat = (pswpin: number) => `nr_free_pages 116622\npswpin ${pswpin}\npswpout 13639\n`

function rowsFor(sql: string): Array<Record<string, unknown>> {
    if (sql.includes('pg_try_advisory_xact_lock')) return [{locked: true}]
    // No prior state, so every pass starts from EMPTY_STATE.
    if (sql.includes('FROM alerts WHERE rule')) return []
    if (sql.includes("kind = 'start_runtime'")) return [{failures: 0, p95: null}]
    if (sql.includes('percentile_disc')) return [{p95: null}]
    if (sql.includes("status = 'queued' AND run_after")) return [{due: 0, failed: 0, longest: null}]
    if (sql.includes('alert_deliveries SET status')) return []
    if (sql.includes('FROM alert_deliveries')) return [{failed: 0}]
    // Recent enough that neither backup_age nor restore_drill_age fires, which
    // would otherwise drag the mail path into every one of these tests.
    if (sql.includes('ops_events')) return [{kind: 'backup', age: 60}, {kind: 'restore', age: 60}]
    return []
}

function fakePool() {
    const calls: Captured[] = []
    const query = async (text: string, values: unknown[] = []) => {
        calls.push({text, values})
        return {rows: rowsFor(text), rowCount: 0}
    }
    const client = {query, release() {}}
    return {pool: {query, connect: async () => client} as any, calls}
}

/**
 * The parameters of every alerts row the pass wrote for one rule. Positions
 * come from the INSERT in monitor.ts: 1 subject, 4 value, 6 summary,
 * 7 breach_count, 8 clear_count.
 */
function recorded(calls: Captured[], rule: string, subject?: string): unknown[][] {
    return calls
        .filter(call => call.text.includes('INSERT INTO alerts') && call.values[0] === rule)
        .filter(call => subject === undefined || call.values[1] === subject)
        .map(call => call.values)
}

async function fixtures(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-test-'))
    await writeFile(join(dir, 'meminfo'), MEMINFO)
    await writeFile(join(dir, 'vmstat'), vmstat(3728))
    return dir
}

function monitorOn(dir: string, pool: any, options: {vmstat?: string; now?: () => number} = {}) {
    return new MonitorService({
        pool,
        now: options.now ?? (() => 1_000_000),
        meminfoPath: join(dir, 'meminfo'),
        vmstatPath: join(dir, options.vmstat ?? 'vmstat'),
        env: {
            DATA_ROOT: dir,
            GATEWAY_DOMAIN: 'sites.example.test',
            ANALYTICS_TIMEZONE: 'UTC',
            EXECUTOR_METRICS_FILE: join(dir, 'missing-executor.json'),
            // Refused immediately, so the probes cost nothing and reach nothing.
            GATEWAY_INTERNAL_URL: 'http://127.0.0.1:9',
            PUBLIC_BASE_URL: 'http://127.0.0.1:9',
        },
    })
}

test('a rule whose input is missing is reported, not silently skipped', async () => {
    const dir = await fixtures()
    const {pool, calls} = fakePool()
    // No readable vmstat, which is exactly what happened to /proc/pressure.
    await monitorOn(dir, pool, {vmstat: 'no-such-vmstat'}).runOnce()

    const [row] = recorded(calls, 'alert_rule_unevaluable', 'host_vmstat')
    assert.ok(row, 'the missing input must produce an alert row of its own')
    assert.equal(row[7], 1, 'first breaching pass')
    assert.match(String(row[6]), /host_vmstat is not readable.*swap_in_rate/)
    // The rule that could not be evaluated wrote nothing at all, which is the
    // silence the row above exists to break.
    assert.equal(recorded(calls, 'swap_in_rate').length, 0)
})

test('an input that is readable clears its own alert instead of lingering', async () => {
    const dir = await fixtures()
    const {pool, calls} = fakePool()
    await monitorOn(dir, pool).runOnce()

    for (const input of ['host_disk', 'host_meminfo', 'host_swap', 'host_vmstat']) {
        const [row] = recorded(calls, 'alert_rule_unevaluable', input)
        assert.ok(row, `${input} must be observed every pass, not only when it is missing`)
        assert.equal(row[8], 1, `${input} recorded a clear pass`)
    }
    // The executor snapshot really is absent in this fixture, so that one
    // breaches: a run in which everything came back clear would prove nothing.
    const [snapshot] = recorded(calls, 'alert_rule_unevaluable', 'executor_snapshot')
    assert.equal(snapshot[7], 1)
    assert.match(String(snapshot[6]), /service_down/)
})

test('the memory rules read MemAvailable, and swap-in needs two passes for a rate', async () => {
    const dir = await fixtures()
    const {pool, calls} = fakePool()
    let clock = 1_000_000
    const monitor = monitorOn(dir, pool, {now: () => clock})
    await monitor.runOnce()

    const [warn] = recorded(calls, 'memory_available_warn')
    assert.equal(warn[4], 4618524 * 1024, 'MemAvailable in bytes, and not MemFree')
    assert.equal(warn[7], 0, '4.4 GiB available is not a breach')
    assert.equal(recorded(calls, 'swap_in_rate').length, 0, 'nothing to difference on the first pass')

    // 4096 pages a second over 60 seconds: 16 MiB/s read back from swap.
    await writeFile(join(dir, 'vmstat'), vmstat(3728 + 4096 * 60))
    clock += 60_000
    await monitor.runOnce()
    const [rate] = recorded(calls, 'swap_in_rate')
    assert.ok(rate, 'the second pass has a rate')
    assert.equal(rate[4], 4096 * 4096)
    assert.equal(rate[7], 1, 'breaching, being past the 5 MiB/s threshold')
})
