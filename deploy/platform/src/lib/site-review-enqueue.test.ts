import assert from 'node:assert/strict'
import test from 'node:test'
import {SecretBox} from './crypto'
import {ProjectService} from './projects'

/**
 * Which sites get reviewed, and which deliberately do not.
 *
 * The rule these guard is not a detail: reviewing an owner-only project spends
 * inference on a shared 30B proxy to form an opinion about a page exactly one
 * authenticated person can load. It is the enqueue, not the job, that has to
 * know that — a job that decides not to review has already paid for the render.
 */

type Captured = {text: string; values: unknown[]}

function projectRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'p-1',
        owner_id: 'a-1',
        slug: 'demo',
        access_mode: 'owner',
        status: 'ready',
        current_version_id: 'v-1',
        runtime_memory_mb: 256,
        runtime_cpu: '0.25',
        database_bytes_max: '1',
        object_bytes_max: '1',
        version_limit: 5,
        postgres_enabled: true,
        storage_enabled: true,
        llm_enabled: false,
        llm_rpm_max: 60,
        llm_tpm_max: 200000,
        created_at: new Date('2026-08-04T00:00:00Z'),
        ...overrides,
    }
}

function fakeDb(row: Record<string, unknown>, options: {failJobInsert?: boolean} = {}) {
    const calls: Captured[] = []
    const db = {
        async query(text: string, values: unknown[] = []) {
            calls.push({text, values})
            if (/^SELECT p\.\*/.test(text.trim())) return {rows: [row], rowCount: 1}
            if (/INSERT INTO jobs/.test(text)) {
                if (options.failJobInsert) throw new Error('jobs_kind_check violated')
                return {rows: [{id: 'job-1', status: 'queued'}], rowCount: 1}
            }
            return {rows: [], rowCount: 0}
        },
    }
    return {db: db as any, calls}
}

const principal = {accountId: 'a-1', role: 'user' as const, email: 'a@example.edu'}

function service(db: any) {
    return new ProjectService(db, 'sites.example.test', 'UTC', '/tmp/sources', new SecretBox('x'.repeat(32)))
}

function reviewJobs(calls: Captured[]): Captured[] {
    return calls.filter(call => /INSERT INTO jobs/.test(call.text) && call.values[0] === 'review_site')
}

test('flipping a project to network queues a review of its live version', async () => {
    const {db, calls} = fakeDb(projectRow({access_mode: 'owner'}))
    await service(db).updateAccess(principal as any, 'demo', 'network')

    const queued = reviewJobs(calls)
    assert.equal(queued.length, 1)
    assert.deepEqual(queued[0].values.slice(0, 4), ['review_site', 'p-1', 'v-1', 'review:p-1:v-1'])
    // Rerunnable, so that a deliberate flip back and forth reviews again even
    // when that version has been reviewed before.
    assert.match(queued[0].text, /ON CONFLICT \(idempotency_key\) DO UPDATE SET/)
})

test('an owner-only project is never queued for review', async () => {
    // The whole point of the access check. A page one authenticated person can
    // load is not a page a stranger can be phished on.
    const {db, calls} = fakeDb(projectRow({access_mode: 'network'}))
    await service(db).updateAccess(principal as any, 'demo', 'owner')
    assert.deepEqual(reviewJobs(calls), [])
})

test('setting network on a project already at network queues nothing', async () => {
    const {db, calls} = fakeDb(projectRow({access_mode: 'network'}))
    await service(db).updateAccess(principal as any, 'demo', 'network')
    assert.deepEqual(reviewJobs(calls), [])
})

test('a project with nothing deployed is not queued', async () => {
    // There is no page yet. The deploy that creates one enqueues its own review.
    const {db, calls} = fakeDb(projectRow({access_mode: 'owner', current_version_id: null}))
    await service(db).updateAccess(principal as any, 'demo', 'network')
    assert.deepEqual(reviewJobs(calls), [])
})

test('a review that cannot be queued does not fail the access change', async () => {
    // Making a site public is a user action; a background review is not part of
    // it, and must never be able to turn it into an error.
    const {db} = fakeDb(projectRow({access_mode: 'owner'}), {failJobInsert: true})
    const summary = await service(db).updateAccess(principal as any, 'demo', 'network')
    assert.equal(summary.slug, 'demo')
})
