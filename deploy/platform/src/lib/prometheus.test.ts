import assert from 'node:assert/strict'
import test from 'node:test'
import {bucketize, Counters, escapeLabelValue, render, renderFamily, renderHistogram} from './prometheus'

test('label values escape the characters that would break the format', () => {
    assert.equal(escapeLabelValue('a"b'), 'a\\"b')
    assert.equal(escapeLabelValue('a\\b'), 'a\\\\b')
    assert.equal(escapeLabelValue('a\nb'), 'a\\nb')
})

test('help and type appear once each, before the samples', () => {
    const text = renderFamily({
        name: 'ritsdev_jobs', help: 'Jobs by kind.', type: 'gauge',
        samples: [{labels: {kind: 'build_version'}, value: 3}],
    })
    const lines = text.split('\n')
    assert.equal(lines[0], '# HELP ritsdev_jobs Jobs by kind.')
    assert.equal(lines[1], '# TYPE ritsdev_jobs gauge')
    assert.equal(lines[2], 'ritsdev_jobs{kind="build_version"} 3')
    assert.equal(text.match(/# HELP/g)?.length, 1)
})

test('an empty or absent label is omitted rather than rendered as a series', () => {
    // A host-wide rule has no subject; rendering it as subject="null" would
    // create a distinct and meaningless time series.
    const text = renderFamily({
        name: 'ritsdev_alerts_firing', help: 'x', type: 'gauge',
        samples: [{labels: {rule: 'disk_free', subject: null, extra: undefined, blank: ''}, value: 1}],
    })
    assert.match(text, /ritsdev_alerts_firing\{rule="disk_free"\} 1/)
})

test('histogram buckets are cumulative and consistent with the count', () => {
    const text = renderHistogram({
        name: 'ritsdev_job_duration_seconds', help: 'x',
        bounds: [1, 5, 15],
        series: [{labels: {kind: 'start_runtime'}, counts: [2, 3, 1, 4], sum: 120}],
    })
    assert.match(text, /_bucket\{kind="start_runtime",le="1"\} 2/)
    assert.match(text, /_bucket\{kind="start_runtime",le="5"\} 5/)
    assert.match(text, /_bucket\{kind="start_runtime",le="15"\} 6/)
    assert.match(text, /_bucket\{kind="start_runtime",le="\+Inf"\} 10/)
    assert.match(text, /_count\{kind="start_runtime"\} 10/)
    assert.match(text, /_sum\{kind="start_runtime"\} 120/)
})

test('bucket bounds must be non-empty and strictly ascending', () => {
    const base = {name: 'x_seconds', help: 'x', series: []}
    assert.throws(() => renderHistogram({...base, bounds: []}), /at least one bucket bound/)
    assert.throws(() => renderHistogram({...base, bounds: [5, 5]}), /ascend strictly/)
    assert.throws(() => renderHistogram({...base, bounds: [5, 1]}), /ascend strictly/)
})

test('non-finite values render as valid exposition rather than breaking the scrape', () => {
    const text = renderFamily({
        name: 'ritsdev_executor_snapshot_age_seconds', help: 'x', type: 'gauge',
        samples: [{value: Number.POSITIVE_INFINITY}, {labels: {a: 'b'}, value: Number.NaN}],
    })
    assert.match(text, /ritsdev_executor_snapshot_age_seconds \+Inf/)
    assert.match(text, /ritsdev_executor_snapshot_age_seconds\{a="b"\} NaN/)
})

test('illegal metric and label names are refused', () => {
    assert.throws(() => renderFamily({name: 'has-a-dash', help: 'x', type: 'gauge', samples: []}), /invalid metric name/)
    assert.throws(
        () => renderFamily({name: 'ok', help: 'x', type: 'gauge', samples: [{labels: {'bad-label': 'v'}, value: 1}]}),
        /invalid label name/,
    )
})

test('rendering is stable, so a diff between two scrapes is meaningful', () => {
    const family = {
        name: 'ritsdev_projects', help: 'x', type: 'gauge' as const,
        samples: [{labels: {status: 'ready'}, value: 10}, {labels: {status: 'failed'}, value: 1}],
    }
    assert.equal(render([family]), render([family]))
})

test('bucketize places observations and totals them', () => {
    const {counts, sum} = bucketize([0.5, 2, 7, 1000], [1, 5, 15])
    assert.deepEqual(counts, [1, 1, 1, 1])
    assert.equal(sum, 1009.5)
    // A non-finite observation is skipped rather than poisoning the sum.
    assert.equal(bucketize([Number.NaN, 1], [1]).sum, 1)
})

test('counters are monotonic within a process and sort stably', () => {
    const counters = new Counters()
    counters.increment('b_total')
    counters.increment('a_total', 5)
    counters.increment('b_total')
    assert.deepEqual(counters.snapshot(), {a_total: 5, b_total: 2})
    assert.equal(counters.get('missing_total'), 0)
})
