import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Pool} from 'pg'
import type {Principal} from './authn'
import {SecretBox} from './crypto'
import {ProjectService} from './projects'

/**
 * Deleting a project schedules a purge seven days out, and `restore_project`
 * cancels it inside that window. An operator cleaning up after their own work —
 * a capacity gate, a reproduction, a drill — does not want the window, and
 * re-creating the same slug is blocked until the purge runs.
 *
 * `immediate` closes the window. These tests pin the two things that make that
 * safe rather than merely convenient: who is allowed to ask, and whether the
 * job the executor is holding seven days out actually moves. A flag that is
 * accepted and then quietly leaves the old job in place looks exactly like
 * success and purges a week late.
 */

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111'
const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222'

const principal = (accountId: string, role: 'user' | 'operator'): Principal => ({
    accountId,
    email: 'operator@example.edu',
    displayName: 'Operator',
    role,
    scopes: ['sites:read', 'sites:write'],
    tokenKind: 'pat',
})

type Captured = {text: string; values: unknown[]}

function fakePool(options: {
    role: 'user' | 'operator'
    ownerId?: string
    status?: string
    purgeAfter?: Date | null
}) {
    const calls: Captured[] = []
    const answer = async (text: string, values: unknown[] = []) => {
        calls.push({text, values})
        if (/SELECT platform_role FROM accounts/.test(text)) {
            return {rows: [{platform_role: options.role}], rowCount: 1}
        }
        if (/FROM projects p LEFT JOIN/.test(text)) {
            return {rows: [{
                id: 'project-1', owner_id: options.ownerId ?? OPERATOR_ID, slug: 'gate', access_mode: 'owner',
                status: options.status ?? 'ready', current_version_id: null,
                runtime_memory_mb: 256, runtime_cpu: '0.25',
                database_bytes_max: '1', object_bytes_max: '1', version_limit: 5,
                postgres_enabled: true, storage_enabled: true, llm_enabled: false,
                llm_rpm_max: 60, llm_tpm_max: 200_000,
                created_at: new Date('2026-08-04T00:00:00Z'),
                deleted_at: options.purgeAfter ? new Date('2026-08-20T00:00:00Z') : null,
                purge_after: options.purgeAfter ?? null,
            }], rowCount: 1}
        }
        if (/UPDATE projects/.test(text)) {
            return {rows: [{
                deleted_at: new Date('2026-08-24T00:00:00Z'),
                purge_after: new Date('2026-08-24T00:00:00Z'),
            }], rowCount: 1}
        }
        return {rows: [{id: 'job-1', status: 'queued'}], rowCount: 1}
    }
    const pool = {query: answer, connect: async () => ({query: answer, release() {}})}
    return {pool: pool as unknown as Pool, calls}
}

const service = (pool: Pool) =>
    new ProjectService(pool, 'sites.example.test', 'UTC', '/tmp/sources', new SecretBox('test-secret'), null)

const enqueueOf = (calls: Captured[]) => calls.find(call => /INSERT INTO jobs/.test(call.text))

test('a plain delete still opens the seven-day window', async () => {
    const {pool, calls} = fakePool({role: 'operator'})

    const result = await service(pool).delete(principal(OPERATOR_ID, 'operator'), 'gate', 'gate')

    assert.equal(result.immediate, false)
    const update = calls.find(call => /UPDATE projects/.test(call.text))!
    assert.equal(update.values.includes('7 days'), true)
    // The seven-day job must stay ON CONFLICT DO NOTHING: re-deleting a project
    // already pending must not reset a purge somebody is counting days on.
    assert.match(enqueueOf(calls)!.text, /ON CONFLICT \(idempotency_key\) DO NOTHING/)
})

test('a user cannot skip the window, and the project is untouched', async () => {
    const {pool, calls} = fakePool({role: 'user'})

    await assert.rejects(
        () => service(pool).delete(principal(OPERATOR_ID, 'user'), 'gate', 'gate', true),
        (error: any) => {
            assert.equal(error.status, 403)
            assert.match(error.message, /operator access is required/)
            return true
        },
    )
    assert.equal(calls.some(call => /UPDATE projects/.test(call.text)), false)
    assert.equal(calls.some(call => /INSERT INTO jobs/.test(call.text)), false)
})

test('the role is re-read from the database, never taken from the token', async () => {
    // A token carries the role it was issued with for up to twelve hours. An
    // account demoted this morning must not still be able to purge without a
    // recovery window this afternoon, so the claim is not what is consulted.
    const {pool, calls} = fakePool({role: 'user'})

    await assert.rejects(
        () => service(pool).delete(principal(OPERATOR_ID, 'operator'), 'gate', 'gate', true),
        (error: any) => error.status === 403,
    )
    assert.equal(calls.some(call => /SELECT platform_role FROM accounts/.test(call.text)), true)
})

test('an operator cannot purge somebody else\'s project without the window', async () => {
    // `ownedProject` lets an operator reach any project, so ownership is a
    // separate check here. The window is the owner's recourse; taking it from
    // another person is not the same act as cleaning up after yourself.
    const {pool, calls} = fakePool({role: 'operator', ownerId: SOMEONE_ELSE})

    await assert.rejects(
        () => service(pool).delete(principal(OPERATOR_ID, 'operator'), 'gate', 'gate', true),
        (error: any) => {
            assert.equal(error.status, 403)
            assert.match(error.message, /limited to projects you own/)
            return true
        },
    )
    assert.equal(calls.some(call => /UPDATE projects/.test(call.text)), false)
})

test('an operator purging their own project sets purge_after to now and queues the job now', async () => {
    const {pool, calls} = fakePool({role: 'operator'})

    const result = await service(pool).delete(principal(OPERATOR_ID, 'operator'), 'gate', 'gate', true)

    assert.equal(result.immediate, true)
    const update = calls.find(call => /UPDATE projects/.test(call.text))!
    // The executor refuses a purge whose `purge_after` is still in the future,
    // so moving the clock is what actually authorises the work.
    assert.equal(update.values.includes('0 seconds'), true)
    const job = enqueueOf(calls)!
    assert.match(job.text, /ON CONFLICT \(idempotency_key\) DO UPDATE/)
    assert.deepEqual(job.values[4], ['queued', 'succeeded', 'failed'])
})

test('the audit record is written before the job that deletes the project row', async () => {
    const {pool, calls} = fakePool({role: 'operator'})

    await service(pool).delete(principal(OPERATOR_ID, 'operator'), 'gate', 'gate', true)

    const audit = calls.findIndex(call => /INSERT INTO audit_events/.test(call.text))
    const job = calls.findIndex(call => /INSERT INTO jobs/.test(call.text))
    assert.notEqual(audit, -1)
    // audit_events.project_id is a real foreign key and the purge deletes the
    // project within a poll interval. Written second, the one deletion nobody
    // can undo is the one whose record loses a race to a constraint violation.
    assert.equal(audit < job, true, 'the audit event must be recorded before the purge is queued')
    const metadata = JSON.parse(calls[audit].values[3] as string)
    assert.equal(metadata.immediate, true, 'the record says the window was skipped, not just that a delete happened')
})

test('a project already pending deletion has its purge pulled forward, job and all', async () => {
    // The common shape: delete, then decide the week of waiting is not wanted.
    // The seven-day job is already queued under this project's idempotency key,
    // so a plain enqueue would do nothing at all and the purge would still run
    // next week.
    const {pool, calls} = fakePool({
        role: 'operator',
        status: 'deleting',
        purgeAfter: new Date('2026-08-27T00:00:00Z'),
    })

    const result = await service(pool).delete(principal(OPERATOR_ID, 'operator'), 'gate', 'gate', true)

    assert.equal(result.immediate, true)
    const update = calls.find(call => /UPDATE projects/.test(call.text))!
    assert.match(update.text, /purge_after = now\(\)/)
    assert.match(update.text, /status = 'deleting'/)
    const job = enqueueOf(calls)!
    assert.match(job.text, /run_after     = CASE WHEN jobs\.status = ANY\(\$5\) THEN now\(\)/)
    assert.deepEqual(job.values[4], ['queued', 'succeeded', 'failed'])
})

test('asking twice without the flag re-enqueues the same purge, unchanged', async () => {
    const {pool, calls} = fakePool({
        role: 'operator',
        status: 'deleting',
        purgeAfter: new Date('2026-08-27T00:00:00Z'),
    })

    const result = await service(pool).delete(principal(OPERATOR_ID, 'operator'), 'gate', 'gate')

    assert.equal(result.immediate, false)
    assert.equal(result.purgeAfter, '2026-08-27T00:00:00.000Z')
    assert.equal(calls.some(call => /UPDATE projects/.test(call.text)), false)
    assert.match(enqueueOf(calls)!.text, /DO NOTHING/)
})
