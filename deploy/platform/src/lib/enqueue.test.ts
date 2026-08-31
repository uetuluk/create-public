import assert from 'node:assert/strict'
import test from 'node:test'
import {enqueue, enqueueRerunnable} from './projects'

type Captured = {text: string; values: unknown[]}

function fakeDb(rows: Array<{id: string; status: string}> = [{id: 'job-1', status: 'queued'}]) {
    const calls: Captured[] = []
    const db = {
        async query(text: string, values: unknown[] = []) {
            calls.push({text, values})
            return {rows, rowCount: rows.length}
        },
    }
    return {db: db as any, calls}
}

test('enqueue stays DO NOTHING, so a one-shot key cannot be re-run', async () => {
    const {db, calls} = fakeDb()
    await enqueue(db, 'delete_project', 'p1', null, 'delete:p1')
    assert.match(calls[0].text, /ON CONFLICT \(idempotency_key\) DO NOTHING/)
})

test('enqueueRerunnable resets a terminal job and returns its id', async () => {
    const {db, calls} = fakeDb([{id: 'job-9', status: 'queued'}])
    const result = await enqueueRerunnable(db, 'provision_project', 'p1', null, 'provision:p1')
    assert.deepEqual(result, {jobId: 'job-9', status: 'queued'})

    const {text, values} = calls[0]
    assert.match(text, /ON CONFLICT \(idempotency_key\) DO UPDATE SET/)
    assert.deepEqual(values[4], ['succeeded', 'failed'])

    // Every field that would otherwise carry the previous attempt forward has
    // to be reset, or a re-run inherits its predecessor's attempt count and
    // error and is dropped by the retry cap.
    for (const column of ['status', 'run_after', 'attempts', 'locked_at', 'locked_by', 'finished_at', 'error_message']) {
        assert.match(text, new RegExp(`${column}\\s*= CASE WHEN jobs\\.status = ANY\\(\\$5\\)`), column)
    }
})

test('the reset is guarded by CASE, never by a WHERE that would swallow RETURNING', async () => {
    const {db, calls} = fakeDb()
    await enqueueRerunnable(db, 'export_database', 'p1', null, 'export:p1')
    const update = calls[0].text.slice(calls[0].text.indexOf('DO UPDATE SET'))
    assert.ok(
        !/\bWHERE\b/.test(update),
        'a WHERE on DO UPDATE returns no row when the predicate fails, and every caller needs the job id back',
    )
    assert.match(calls[0].text, /RETURNING id, status/)
})

test('a caller can narrow which states are re-runnable', async () => {
    const {db, calls} = fakeDb()
    // Render only re-runs a failed job: a succeeded one still owns its cached
    // screenshot.
    await enqueueRerunnable(db, 'render_version', 'p1', 'v1', 'render:p1:v1', ['failed'])
    assert.deepEqual(calls[0].values[4], ['failed'])
})
