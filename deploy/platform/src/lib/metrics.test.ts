import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BUILD_DURATION_SQL,
    DEPLOY_FAILED_SQL,
    DEPLOY_LATENCY_SQL,
    DURATION_BOUNDS,
    JOB_DURATION_SQL,
    JOB_QUEUE_WAIT_SQL,
    LOGS_SQL,
    PROJECT_USAGE_SQL,
    SITE_REVIEW_SQL,
    readExecutorSnapshot,
    ruleEvaluabilitySamples,
} from './metrics'
import {inputAvailability, RULES} from './alert-rules'
import {parseDockerSize} from '../executor'
import {parseMemInfo, parsePressure, parseSwapInPages, swapInRate} from './host-metrics'
import {withinCidrs} from '../routes/metrics'

test('superseded deployments are not counted as failures', () => {
    // Deploying twice marks the older deployment failed with 'superseded' by
    // design; counting those would report a failure on every second deploy.
    assert.match(DEPLOY_FAILED_SQL, /error_message IS DISTINCT FROM 'superseded'/)
    assert.match(DEPLOY_LATENCY_SQL, /status = 'active'/)
})

test('every duration query excludes null endpoints before subtracting', () => {
    assert.match(JOB_QUEUE_WAIT_SQL, /locked_at IS NOT NULL/)
    assert.match(JOB_DURATION_SQL, /finished_at IS NOT NULL AND locked_at IS NOT NULL/)
    assert.match(BUILD_DURATION_SQL, /finished_at IS NOT NULL/)
    assert.match(DEPLOY_LATENCY_SQL, /activated_at IS NOT NULL/)
})

test('windowed queries filter on the column that has an index', () => {
    // idx_project_logs_created is on created_at; filtering by id would not use it.
    assert.match(LOGS_SQL, /created_at > now\(\)/)
    assert.doesNotMatch(LOGS_SQL, /WHERE id/)
})

test('no metric SQL interpolates a value', () => {
    for (const sql of [
        JOBS_SQL_SAFE, JOB_QUEUE_WAIT_SQL, JOB_DURATION_SQL, BUILD_DURATION_SQL,
        DEPLOY_LATENCY_SQL, DEPLOY_FAILED_SQL, PROJECT_USAGE_SQL, LOGS_SQL, SITE_REVIEW_SQL,
    ]) {
        assert.doesNotMatch(sql, /\$\{/, sql.slice(0, 40))
    }
})
const JOBS_SQL_SAFE = JOB_QUEUE_WAIT_SQL

test('duration buckets are ascending and cover a slow cold start', () => {
    for (let i = 1; i < DURATION_BOUNDS.length; i++) {
        assert.ok(DURATION_BOUNDS[i] > DURATION_BOUNDS[i - 1])
    }
    // A cold start budget is 90s, so there must be a bound above it.
    assert.ok(DURATION_BOUNDS.some(bound => bound > 90))
})

test('a missing executor snapshot reads as absent rather than throwing', async () => {
    assert.equal(await readExecutorSnapshot('/nonexistent/executor.json'), null)
})

test('meminfo is parsed in bytes, and a swapless host yields no swap metrics', () => {
    const info = parseMemInfo(['MemTotal:       7847116 kB', 'MemAvailable:    5563932 kB',
        'SwapTotal:       4194300 kB', 'SwapFree:        4194300 kB'].join('\n'))
    assert.equal(info.totalBytes, 7847116 * 1024)
    assert.equal(info.availableBytes, 5563932 * 1024)
    assert.equal(info.swapUsedBytes, 0)

    const noSwap = parseMemInfo('MemTotal:       100 kB\nMemAvailable:    50 kB')
    assert.equal(noSwap.swapTotalBytes, null)
    assert.equal(noSwap.swapUsedBytes, null, 'must be absent, never NaN')
})

test('pressure is read from the some/avg60 field', () => {
    assert.equal(parsePressure('some avg10=0.00 avg60=12.34 avg300=1.00 total=1\nfull avg60=99.0'), 12.34)
    assert.equal(parsePressure('nothing useful'), null)
})

test('swap-in is a counter of pages, differenced into a byte rate', () => {
    assert.equal(parseSwapInPages('nr_free_pages 1\npswpin 3728\npswpout 13639'), 3728)
    assert.equal(parseSwapInPages('pswpout 13639'), null)
    // 1024 pages over 2 seconds: 2 MiB/s.
    assert.equal(swapInRate({pages: 100, at: 0}, {pages: 1124, at: 2000}), 2 * 1024 ** 2)
    // A counter that went backwards means the host rebooted, not that swap-in
    // was negative; and two samples from one instant have no rate at all.
    assert.equal(swapInRate({pages: 5000, at: 0}, {pages: 12, at: 2000}), null)
    assert.equal(swapInRate({pages: 1, at: 1000}, {pages: 9, at: 1000}), null)
})

test('every rule is exposed as evaluable or not, and the family never shrinks', () => {
    // The original defect was a family that disappeared with its source. One
    // sample per rule regardless of availability is what makes absence visible.
    const all = ruleEvaluabilitySamples(
        inputAvailability({snapshot: true, disk: true, meminfo: true, swap: true, vmstat: true}))
    assert.equal(all.length, RULES.length)
    assert.ok(all.every(sample => sample.value === 1))

    const noVmstat = ruleEvaluabilitySamples(
        inputAvailability({snapshot: true, disk: true, meminfo: true, swap: true, vmstat: false}))
    assert.equal(noVmstat.length, RULES.length, 'the dead rule stays in the output as a zero')
    const dead = noVmstat.filter(sample => sample.value === 0)
    assert.deepEqual(dead.map(sample => sample.labels?.rule), ['swap_in_rate'])
    assert.equal(dead[0].labels?.input, 'host_vmstat')
})

test('docker stats sizes parse in both decimal and binary units', () => {
    assert.equal(parseDockerSize('141.8MiB / 7.47GiB'), Math.round(141.8 * 1024 ** 2))
    assert.equal(parseDockerSize('12.3MB'), 12_300_000)
    assert.equal(parseDockerSize('512B'), 512)
    assert.equal(parseDockerSize('garbage'), 0)
})

test('the metrics peer allowlist matches only the configured networks', () => {
    assert.ok(withinCidrs('192.168.64.82', ['192.168.64.80/28']))
    assert.ok(!withinCidrs('192.168.64.120', ['192.168.64.80/28']))
    // Node reports IPv4 peers this way on a dual-stack listener.
    assert.ok(withinCidrs('::ffff:192.168.64.82', ['192.168.64.80/28']))
    // An empty allowlist means the token is the only gate.
    assert.ok(withinCidrs('10.0.0.1', []))
    // An address that cannot be parsed is refused when a list is configured.
    assert.ok(!withinCidrs('not-an-ip', ['10.0.0.0/8']))
})
