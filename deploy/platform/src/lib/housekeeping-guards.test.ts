import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import test from 'node:test'

/**
 * Housekeeping used to run strictly between jobs, so several of its sweeps
 * could assume nothing else was in flight. With more than one worker it now
 * overlaps them, and each sweep below needs a guard it did not need before.
 * These assert the guards are present in the statements the executor issues.
 */

const source = readFileSync(join(import.meta.dirname, '..', 'executor.ts'), 'utf8')

test('the idle sweep skips a project with live jobs', () => {
    // A render or probe that reused a warm runtime would otherwise have it
    // stopped out from under it mid-job.
    // Anchored on the idempotency key, which is unique to this statement.
    const start = source.indexOf("'stop:' ||")
    assert.ok(start > 0, 'idle sweep statement not found')
    const sweep = source.slice(start, start + 900)
    assert.match(sweep, /NOT EXISTS/)
    assert.match(sweep, /status IN \('queued', 'running'\)/)
})

test('the runtime reconcile skips a project with live jobs', () => {
    // startRuntime writes 'running' only after the health probe passes, so
    // without this guard a cold start in flight is demoted between `docker run`
    // and that update — and the gateway waiting on it then times out.
    const start = source.indexOf('private async reconcileRuntimeState')
    assert.ok(start > 0, 'reconcileRuntimeState not found')
    const reconcile = source.slice(start, source.indexOf('\n    private async removeRuntime', start))
    assert.match(reconcile, /pr\.state = 'running'/)
    assert.match(reconcile, /status IN \('queued', 'running'\)/)
    // Demotion must be limited to rows with no live container.
    assert.match(reconcile, /unnest\(\$1::uuid\[\], \$2::uuid\[\]\)/)
})

test('the runtime reconcile lists containers intolerantly', () => {
    // `docker()` forgives only "no such container", so an unreachable daemon
    // throws and housekeeping's catch skips the pass. Passing the tolerant flag
    // here would read a daemon outage as "nothing is running" and demote every
    // healthy runtime on the host at once.
    const start = source.indexOf('private async reconcileRuntimeState')
    const listing = source.slice(source.indexOf("'ps', '--filter', 'label=ritsdev.project'", start))
    assert.match(listing.slice(0, 300), /\n\s+30_000,\n\s+\)/)
    // And the pass has to run before the idle sweep hands out stop jobs.
    assert.ok(
        source.indexOf('await this.reconcileRuntimeState()') < source.indexOf("'stop:' ||"),
        'reconcile must precede the idle sweep',
    )
})

test('render GC only expires the result of a finished render', () => {
    // render_version reuses one job row per version, so without this a re-run
    // in flight is marked failed underneath itself.
    const gc = source.slice(source.indexOf('render result expired') - 400, source.indexOf('render result expired') + 400)
    assert.match(gc, /j\.status = 'succeeded'/)
})

test('the pre-warm reuse path refreshes last_seen_at', () => {
    // Only the gateway marks traffic, so an executor-internal pre-warm is
    // otherwise invisible to the idle sweep.
    const reuse = source.slice(source.indexOf('runtimeHealthCommand(runtimeName(projectId, versionId))'))
    assert.match(reuse.slice(0, 600), /UPDATE project_runtime SET last_seen_at = now\(\)/)
})

test('job pruning cannot delete a job whose result rows would cascade', () => {
    const prune = source.slice(source.indexOf('DELETE FROM jobs'), source.indexOf('DELETE FROM jobs') + 400)
    assert.match(prune, /status = 'succeeded'/)
    assert.match(prune, /finished_at </)
    for (const kind of ['measure_usage', 'start_runtime', 'stop_runtime', 'provision_project']) {
        assert.match(prune, new RegExp(`'${kind}'`), kind)
    }
    // render_results, probe_results and database_exports all reference
    // jobs(id) ON DELETE CASCADE.
    for (const kind of ['render_version', 'export_database', 'probe_version']) {
        assert.doesNotMatch(prune, new RegExp(`'${kind}'`), kind)
    }
})

test('the service snapshot is scoped to this compose project', () => {
    // Without the value the filter also matches the retired legacy stack, every
    // container of which is legitimately stopped and would look like an outage.
    assert.match(source, /label=com\.docker\.compose\.project=\$\{project\}/)
    assert.match(source, /-data-init/)
})

test('the snapshot never inspects cloudflared', () => {
    // Its tunnel token is in the command line, which is how it leaked before.
    // Scoped to the whole method rather than its first N characters: a comment
    // added above the skip used to be enough to push it out of the window.
    const start = source.indexOf('private async writeMetricsSnapshot')
    assert.ok(start > 0, 'writeMetricsSnapshot not found')
    assert.match(source.slice(start, source.indexOf('\n    /**', start)), /cloudflared/)
})
