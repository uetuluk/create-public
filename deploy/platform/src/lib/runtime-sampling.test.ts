import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import test from 'node:test'
import type {RunningRuntime} from '../executor'
import {runtimeReadings} from '../executor'

/**
 * `runtime_samples` for the operator tables and the /metrics snapshot are built
 * from one sweep. These cover the join, and in particular that the snapshot half
 * is still behind the leading-digit guard in `parseDockerStats` — before the
 * unification it had no guard at all.
 */

const source = readFileSync(join(import.meta.dirname, '..', 'executor.ts'), 'utf8')

function containers(...names: string[]): Map<string, RunningRuntime> {
    return new Map(names.map((name, index) => [name, {
        project_id: `project-${index}`,
        version_id: `version-${index}`,
        slug: `slug-${index}`,
    }]))
}

function stats(rows: Array<Record<string, string>>): string {
    return rows.map(row => JSON.stringify(row)).join('\n')
}

test('one sweep answers both the operator tables and the metrics snapshot', () => {
    const readings = runtimeReadings(
        containers('rits-site-aaa-bbb', 'rits-site-ccc-ddd'),
        stats([
            {Name: 'rits-site-aaa-bbb', MemUsage: '52.43MiB / 256MiB', CPUPerc: '1.23%', PIDs: '9'},
            {Name: 'rits-site-ccc-ddd', MemUsage: '1.5GiB / 2GiB', CPUPerc: '0.00%', PIDs: '17'},
        ]),
        '/rits-site-ccc-ddd true\n/rits-site-aaa-bbb false\n',
    )

    assert.deepEqual(readings, [
        {
            name: 'rits-site-aaa-bbb', projectId: 'project-0', versionId: 'version-0', slug: 'slug-0',
            memoryBytes: 54976840, memoryLimitBytes: 268435456, cpuPercent: 1.23, pids: 9, oomKilled: false,
        },
        {
            name: 'rits-site-ccc-ddd', projectId: 'project-1', versionId: 'version-1', slug: 'slug-1',
            memoryBytes: 1610612736, memoryLimitBytes: 2147483648, cpuPercent: 0, pids: 17, oomKilled: true,
        },
    ])
})

test('a container that exited mid-sweep reaches neither consumer', () => {
    // This is the leading-digit guard, reached through the unified path. Both
    // the operator tables and the snapshot are now built from what this
    // function returns, so dropping the guard would record a dead container as
    // healthy and using no memory in both of them at once. `parseDockerSize`
    // answers 0 for anything it cannot read, which is indistinguishable from a
    // genuinely idle runtime.
    const readings = runtimeReadings(
        containers('rits-site-aaa-bbb', 'rits-site-dead-beef'),
        stats([
            {Name: 'rits-site-aaa-bbb', MemUsage: '10MiB / 20MiB', CPUPerc: '0.50%', PIDs: '4'},
            {Name: 'rits-site-dead-beef', MemUsage: '-- / --', CPUPerc: '--', PIDs: '--'},
        ]),
        '',
    )

    assert.deepEqual(readings.map(reading => reading.name), ['rits-site-aaa-bbb'])
    assert.equal(readings[0].pids, 4)
})

test('a sample for a container the database did not list is ignored', () => {
    // The sweep names its containers, so this should not happen; if it ever
    // does, a sample with no project and version cannot be written anywhere.
    const readings = runtimeReadings(
        containers('rits-site-aaa-bbb'),
        stats([{Name: 'some-other-container', MemUsage: '10MiB / 20MiB', CPUPerc: '1%', PIDs: '2'}]),
        '',
    )
    assert.deepEqual(readings, [])
})

test('unusable sweep output costs the pass its samples, not the pass', () => {
    assert.deepEqual(runtimeReadings(containers('a'), '', ''), [])
    assert.deepEqual(runtimeReadings(containers('a'), null, null), [])
    assert.deepEqual(runtimeReadings(new Map(), stats([{Name: 'a', MemUsage: '1MiB / 2MiB', CPUPerc: '1%'}]), ''), [])
})

test('the metrics snapshot no longer sweeps the runtimes a second time', () => {
    // The two sweeps were 2N docker invocations a minute on a two-core host,
    // and slow housekeeping is a heartbeat risk: the executor's health check
    // fails once its heartbeat file is 120 seconds stale.
    const start = source.indexOf('private async writeMetricsSnapshot')
    assert.ok(start > 0, 'writeMetricsSnapshot not found')
    const snapshot = source.slice(start, source.indexOf('\n    /**', start))
    assert.doesNotMatch(snapshot, /'stats'/, 'the snapshot must take its runtime figures from sampleResources')
    assert.doesNotMatch(snapshot, /FROM project_runtime/, 'the running runtimes are queried once per pass')
})

test('the service snapshot ignores containers compose did not create', () => {
    // `docker compose build` stamps com.docker.compose.project onto the images
    // it builds and a container inherits its image's labels, so the label alone
    // does not mean compose started the container. container-number is set on
    // the container and never on an image.
    assert.match(source, /com\.docker\.compose\.container-number/)
})

test('the render container does not claim to be a platform service', () => {
    const start = source.indexOf("'run', '--rm',", source.indexOf('private async renderVersion'))
    assert.ok(start > 0, 'render container launch not found')
    assert.match(source.slice(start, start + 1400), /'--label', 'com\.docker\.compose\.project='/)
})
