import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Pool} from 'pg'
import {authRoutes} from '../routes/auth'
import {TokenService} from './authn'
import type {Principal} from './authn'
import {SecretBox} from './crypto'
import {
    DEFAULT_PROJECT_QUOTA,
    effectiveProjectQuota,
    OPERATOR_PROJECT_QUOTA,
    parseOperatorProjectQuota,
    parseProjectQuotaDefault,
    ProjectService,
} from './projects'

const TEST_AUTH_POLICY = {domains: ['example.edu'], allowAnyDomain: false}

/**
 * #66: the skill said three projects per account, and an account holding ten
 * created two more. The quota is enforced — on the single creation path both
 * MCP and REST use — but it is a per-account column, so "three" is only what a
 * new account is given. These tests pin the parts that decide whether a
 * documented number and an enforced number can drift apart again: the limit
 * read is the account's own, a project awaiting purge still counts, and a login
 * never rewrites the quota of an account that already exists.
 */

const PRINCIPAL: Principal = {
    accountId: '11111111-1111-4111-8111-111111111111',
    email: 'someone@example.edu',
    displayName: 'Someone',
    role: 'user',
    scopes: ['sites:read', 'sites:write'],
    tokenKind: 'pat',
}

type Captured = {text: string; values: unknown[]}

/** A pool that answers the quota and count queries with the numbers given. */
function fakePool(quota: number, used: number, role: 'user' | 'operator' = 'user') {
    const calls: Captured[] = []
    const answer = async (text: string, values: unknown[] = []) => {
        calls.push({text, values})
        if (/SELECT project_quota, platform_role FROM accounts/.test(text)) {
            return {rows: [{project_quota: quota, platform_role: role}], rowCount: 1}
        }
        // The immediate-purge gate and nothing else in this file reads the role
        // on its own; answering it keeps an unrelated call from falling through
        // to the catch-all row below.
        if (/SELECT platform_role FROM accounts/.test(text)) return {rows: [{platform_role: role}], rowCount: 1}
        if (/COUNT\(\*\)/.test(text)) return {rows: [{count: String(used)}], rowCount: 1}
        if (/FROM projects p LEFT JOIN/.test(text)) {
            return {rows: [{
                id: 'project-1', owner_id: PRINCIPAL.accountId, slug: 'demo', access_mode: 'owner',
                status: 'ready', current_version_id: null, runtime_memory_mb: 256, runtime_cpu: '0.25',
                database_bytes_max: '1', object_bytes_max: '1', version_limit: 5,
                postgres_enabled: true, storage_enabled: true, llm_enabled: false,
                llm_rpm_max: 60, llm_tpm_max: 200_000, created_at: new Date('2026-08-04T00:00:00Z'),
            }], rowCount: 1}
        }
        return {rows: [{id: 'job-1'}], rowCount: 1}
    }
    const pool = {query: answer, connect: async () => ({query: answer, release() {}})}
    return {pool: pool as unknown as Pool, calls}
}

const service = (pool: Pool, operatorQuota = OPERATOR_PROJECT_QUOTA) =>
    new ProjectService(
        pool, 'sites.example.test', 'UTC', '/tmp/sources', new SecretBox('test-secret'), null,
        '/tmp/showcase', operatorQuota,
    )

test('a create at the account quota is refused, and nothing is written', async () => {
    const {pool, calls} = fakePool(3, 3)

    await assert.rejects(
        () => service(pool).create(PRINCIPAL, {slug: 'four'}),
        (error: any) => {
            assert.equal(error.status, 403)
            // The limit is per account, so the caller cannot infer it from the
            // documentation; the only place it learns the number is here.
            assert.match(error.message, /project quota exceeded \(3 projects/)
            assert.match(error.message, /awaiting purge still counts/)
            return true
        },
    )
    assert.equal(calls.some(call => /INSERT INTO projects/.test(call.text)), false)
    assert.equal(calls.some(call => /ROLLBACK/.test(call.text)), true)
})

test('the limit that binds is the account\'s own, not the documented default', async () => {
    // This is what #66 actually saw: ten projects and room for more. It is not
    // a missing check, it is an account whose quota was raised.
    const {pool, calls} = fakePool(12, 10)

    await service(pool).create(PRINCIPAL, {slug: 'eleven'})

    assert.equal(calls.some(call => /INSERT INTO projects/.test(call.text)), true)
    assert.equal(calls.some(call => /COMMIT/.test(call.text)), true)
})

test('the quota row is locked and counts everything short of deleted', async () => {
    const {pool, calls} = fakePool(3, 0)
    await service(pool).create(PRINCIPAL, {slug: 'first'})

    const quotaRead = calls.find(call => /SELECT project_quota, platform_role FROM accounts/.test(call.text))!
    // Without FOR UPDATE two concurrent creates both read the same count and
    // both pass, which is one project over the limit for every race.
    assert.match(quotaRead.text, /FOR UPDATE/)

    const count = calls.find(call => /COUNT\(\*\)/.test(call.text))!
    // A project in `deleting` holds its slug, database, and bucket for seven
    // days, so it holds quota too. Documented, because it surprises people who
    // delete a project and immediately try to replace it.
    assert.match(count.text, /status <> 'deleted'/)
    assert.doesNotMatch(count.text, /status <> 'deleting'/)
})

test('the default for new accounts is configurable, and refuses a value the database would', () => {
    assert.equal(parseProjectQuotaDefault(undefined), DEFAULT_PROJECT_QUOTA)
    assert.equal(parseProjectQuotaDefault(''), DEFAULT_PROJECT_QUOTA)
    assert.equal(DEFAULT_PROJECT_QUOTA, 3, 'the constant mirrors the schema default; change both together')
    assert.equal(parseProjectQuotaDefault('8'), 8)
    // accounts.project_quota is CHECK (project_quota > 0) and INT. Anything the
    // column would reject must stop the process at start, not break the first
    // registration after it.
    for (const bad of ['0', '-1', '2.5', 'twelve']) {
        assert.throws(() => parseProjectQuotaDefault(bad), /DEFAULT_PROJECT_QUOTA must be a positive integer/, bad)
    }
    assert.equal(parseOperatorProjectQuota(undefined), OPERATOR_PROJECT_QUOTA)
    assert.equal(parseOperatorProjectQuota('40'), 40)
    for (const bad of ['0', '-1', '2.5', 'twelve']) {
        assert.throws(() => parseOperatorProjectQuota(bad), /OPERATOR_PROJECT_QUOTA must be a positive integer/, bad)
    }
})

test('the operator floor is a floor, not a cap, and only operators stand on it', () => {
    // A user is their column, whatever the floor is.
    assert.equal(effectiveProjectQuota({project_quota: 3, platform_role: 'user'}, 25), 3)
    assert.equal(effectiveProjectQuota({project_quota: 40, platform_role: 'user'}, 25), 40)
    // An operator gets the floor when their column is below it.
    assert.equal(effectiveProjectQuota({project_quota: 3, platform_role: 'operator'}, 25), 25)
    // ...and keeps a hand-raised column that is already above it. If this were
    // min(), promoting somebody would silently take projects' worth of room
    // away from an account an operator had deliberately raised.
    assert.equal(effectiveProjectQuota({project_quota: 40, platform_role: 'operator'}, 25), 40)
})

test('an operator creates against the floor, and a user with the same column does not', async () => {
    // Same column, same usage, different role: the only input that differs is
    // the one read from the account row inside the create transaction.
    const operator = fakePool(DEFAULT_PROJECT_QUOTA, 5, 'operator')
    await service(operator.pool).create(PRINCIPAL, {slug: 'sixth'})
    assert.equal(operator.calls.some(call => /INSERT INTO projects/.test(call.text)), true)

    const user = fakePool(DEFAULT_PROJECT_QUOTA, 5, 'user')
    await assert.rejects(
        () => service(user.pool).create(PRINCIPAL, {slug: 'sixth'}),
        (error: any) => {
            assert.equal(error.status, 403)
            assert.match(error.message, /project quota exceeded \(3 projects/)
            return true
        },
    )
})

test('the floor an operator creates against is the configured one, and it is named when it binds', async () => {
    const {pool} = fakePool(DEFAULT_PROJECT_QUOTA, 4, 'operator')
    await assert.rejects(
        () => service(pool, 4).create(PRINCIPAL, {slug: 'fifth'}),
        (error: any) => {
            assert.equal(error.status, 403)
            // The message must name the limit that actually bound, not the
            // column: an operator told "3 projects" while holding four would
            // have no way to work out what happened.
            assert.match(error.message, /project quota exceeded \(4 projects/)
            return true
        },
    )
})

test('a sign-in gives a new account the configured quota and leaves an existing one alone', async () => {
    const calls: Captured[] = []
    const pool = {
        query: async (text: string, values: unknown[] = []) => {
            calls.push({text, values})
            return {rows: [{
                id: PRINCIPAL.accountId, email: PRINCIPAL.email,
                display_name: PRINCIPAL.displayName, platform_role: 'user',
            }], rowCount: 1}
        },
    } as unknown as Pool

    const app = authRoutes({
        authPolicy: TEST_AUTH_POLICY,
        pool,
        tokens: new TokenService({
            issuer: 'https://sites.example.test',
            resource: 'https://sites.example.test/mcp',
            sessionSecret: 'test-session-secret-that-is-long-enough',
        }),
        publicBaseUrl: 'https://sites.example.test',
        devBypass: true,
        defaultProjectQuota: 5,
    })
    const response = await app.request('/dev', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({email: 'someone@example.edu'}),
    })
    assert.equal(response.status, 200, await response.text().catch(() => ''))

    const insert = calls.find(call => /INSERT INTO accounts/.test(call.text))!
    assert.equal(insert.values.includes(5), true, 'a new account is created with the configured quota')
    // The operator's account already holds more projects than the default
    // allows. If the conflict branch wrote the default back, their next login
    // would take the quota away.
    const conflict = insert.text.slice(insert.text.indexOf('ON CONFLICT'))
    assert.doesNotMatch(conflict, /project_quota/,
        'a login must not rewrite the quota of an account that already exists')
})
