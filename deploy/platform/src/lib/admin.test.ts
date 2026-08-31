import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'
import type {Pool} from 'pg'
import {parseDockerStats} from '../executor'
import {adminRoutes} from '../routes/admin'
import {AdminService, AdminWriteService, parseOperatorEmails, syncOperators} from './admin'
import {TokenService} from './authn'

const tokens = new TokenService({
    issuer: 'https://sites.example.test',
    resource: 'https://sites.example.test/mcp',
    sessionSecret: 'test-session-secret-that-is-long-enough',
})

function sessionFor(role: 'user' | 'operator', accountId = '11111111-1111-4111-8111-111111111111') {
    return tokens.signSession({accountId, email: 'someone@example.edu', displayName: 'Someone', role})
}

/** A pool that answers each query from a matcher, and records what it ran. */
let lastValues: unknown[] = []

function stubPool(answer: (sql: string, params?: unknown[]) => unknown[]): Pool & {queries: string[]} {
    const queries: string[] = []
    const pool = {
        queries,
        async query(sql: string, params?: unknown[]) {
            queries.push(sql)
            if (params) lastValues = params
            const rows = answer(sql, params)
            return {rows, rowCount: rows.length}
        },
    }
    return pool as unknown as Pool & {queries: string[]}
}

function adminApp(role: 'user' | 'operator', rows: (sql: string) => unknown[] = () => []) {
    const pool = stubPool((sql, params) => {
        if (sql.includes('platform_role FROM accounts')) return [{platform_role: role}]
        return rows(sql)
    })
    return {
        pool,
        app: adminRoutes({
            pool,
            admin: new AdminService(pool, 'sites.example.test'),
            writes: new AdminWriteService(pool),
            authenticator: {} as never,
            tokens,
        }),
    }
}

function request(path: string, role: 'user' | 'operator', rows?: (sql: string) => unknown[]) {
    const {app, pool} = adminApp(role, rows)
    return {
        pool,
        response: app.request(path, {headers: {cookie: `__Host-ritsdev_session=${sessionFor(role)}`}}),
    }
}

test('a non-operator session cannot read any operator endpoint', async () => {
    for (const path of ['/overview', '/accounts', '/projects', '/jobs', '/audit']) {
        const {response} = request(path, 'user')
        assert.equal((await response).status, 403, `${path} must refuse a plain user`)
    }
})

test('operator access is decided by the account, not by the session claim', async () => {
    // A session minted while the holder was an operator keeps saying so for up
    // to twelve hours. The role has to be re-read, or a demotion does nothing
    // until the cookie expires.
    const {app, pool} = adminApp('user')
    const staleOperatorCookie = `__Host-ritsdev_session=${sessionFor('operator')}`
    const response = await app.request('/accounts', {headers: {cookie: staleOperatorCookie}})

    assert.equal(response.status, 403)
    assert.equal(
        pool.queries.some(sql => sql.includes('platform_role FROM accounts')), true,
        'the account role must be read from the database',
    )
})

test('an unauthenticated request is refused before any query runs', async () => {
    const {app, pool} = adminApp('operator')
    const response = await app.request('/overview')

    assert.equal(response.status, 401)
    assert.deepEqual(pool.queries, [])
})

test('the operator API is read-only', async () => {
    const {app} = adminApp('operator')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const path of ['/accounts', '/projects', '/jobs', '/audit', '/overview']) {
            const response = await app.request(path, {
                method,
                headers: {cookie: `__Host-ritsdev_session=${sessionFor('operator')}`},
            })
            assert.equal(response.status, 404, `${method} ${path} must not be routed`)
        }
    }
})

test('an operator sees every account, with no credential material', async () => {
    const {response} = request('/accounts', 'operator', sql => sql.includes('FROM accounts a') ? [{
        id: 'a1', email: 'owner@example.edu', display_name: 'Owner', platform_role: 'user',
        project_quota: 3, created_at: new Date('2026-01-01T00:00:00Z'),
        last_login_at: new Date('2026-08-01T00:00:00Z'),
        projects: '2', deleting_projects: '0', active_tokens: '1',
        token_last_used_at: null, postgres_bytes: '1024', object_bytes: '2048',
    }] : [])

    const body = await (await response).json() as {accounts: Array<Record<string, unknown>>}
    assert.equal(body.accounts.length, 1)
    assert.deepEqual(body.accounts[0], {
        id: 'a1',
        email: 'owner@example.edu',
        name: 'Owner',
        role: 'user',
        quota: 3,
        quotaColumn: 3,
        projects: 2,
        projectsPendingDeletion: 0,
        activeTokens: 1,
        usage: {postgresBytes: 1024, objectBytes: 2048},
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-08-01T00:00:00.000Z',
        tokenLastUsedAt: null,
    })
    assert.doesNotMatch(JSON.stringify(body), /token_hash|secret|password/i)
})

test('an operator row shows the floor it creates against, and the column it holds', async () => {
    // The accounts table is where an operator goes to answer "does this account
    // have room". Printing the column for an operator answers a different
    // question than the one being asked, and answers it as "5 / 3".
    const {response} = request('/accounts', 'operator', sql => sql.includes('FROM accounts a') ? [{
        id: 'a2', email: 'lead@example.edu', display_name: 'Lead', platform_role: 'operator',
        project_quota: 3, created_at: new Date('2026-01-01T00:00:00Z'),
        last_login_at: new Date('2026-08-01T00:00:00Z'),
        projects: '5', deleting_projects: '1', active_tokens: '1',
        token_last_used_at: null, postgres_bytes: '0', object_bytes: '0',
    }] : [])

    const body = await (await response).json() as {accounts: Array<Record<string, unknown>>}
    assert.equal(body.accounts[0].quota, 25, 'an operator creates against the floor')
    // Still reported, because the column is what identifies an account somebody
    // raised by hand — the audit in docs/operations.md reads it.
    assert.equal(body.accounts[0].quotaColumn, 3)
})

test('project rows carry live memory next to the quota that bounds it', async () => {
    const {response} = request('/projects', 'operator', sql => sql.includes('FROM projects p') ? [{
        id: 'p1', slug: 'demo', status: 'ready', access_mode: 'network',
        owner_email: 'owner@example.edu', owner_name: 'Owner',
        postgres_enabled: true, storage_enabled: false, current_version_id: 'v1',
        database_bytes_max: '536870912', object_bytes_max: '1610612736',
        runtime_memory_mb: 256, runtime_cpu: '0.25',
        postgres_bytes: '1000', object_bytes: '0', measured_at: new Date('2026-08-03T10:00:00Z'),
        runtime_state: 'running', runtime_last_seen_at: new Date('2026-08-03T10:01:00Z'),
        runtime_error: null, has_functions: true,
        memory_bytes: '52428800', memory_limit_bytes: '268435456', cpu_percent: '1.50',
        sampled_at: new Date('2026-08-03T10:02:00Z'),
        versions: '4', failed_versions: '1',
        last_deployed_at: new Date('2026-08-02T09:00:00Z'),
        created_at: new Date('2026-07-01T00:00:00Z'), deleted_at: null, purge_after: null,
    }] : [])

    const body = await (await response).json() as {projects: Array<any>}
    const project = body.projects[0]
    assert.equal(project.url, 'https://demo.sites.example.test')
    assert.equal(project.owner.email, 'owner@example.edu')
    assert.deepEqual(project.runtime, {
        state: 'running',
        functions: true,
        lastSeenAt: '2026-08-03T10:01:00.000Z',
        error: null,
        memoryBytes: 52428800,
        memoryLimitBytes: 268435456,
        cpuPercent: 1.5,
        sampledAt: '2026-08-03T10:02:00.000Z',
    })
    assert.equal(project.quota.runtimeMemoryMiB, 256)
    assert.deepEqual(project.versions, {total: 4, failed: 1})
})

test('a project with no sample reports null rather than a stale or zero reading', async () => {
    const {response} = request('/projects', 'operator', sql => sql.includes('FROM projects p') ? [{
        id: 'p2', slug: 'idle', status: 'ready', access_mode: 'owner',
        owner_email: 'owner@example.edu', owner_name: 'Owner',
        postgres_enabled: false, storage_enabled: false, current_version_id: null,
        database_bytes_max: '1', object_bytes_max: '1', runtime_memory_mb: 256, runtime_cpu: '0.25',
        postgres_bytes: null, object_bytes: null, measured_at: null,
        runtime_state: null, runtime_last_seen_at: null, runtime_error: null, has_functions: null,
        memory_bytes: null, memory_limit_bytes: null, cpu_percent: null, sampled_at: null,
        versions: '0', failed_versions: '0', last_deployed_at: null,
        created_at: new Date('2026-07-01T00:00:00Z'), deleted_at: null, purge_after: null,
    }] : [])

    const project = (await (await response).json() as {projects: Array<any>}).projects[0]
    assert.equal(project.runtime.state, 'stopped')
    assert.equal(project.runtime.memoryBytes, null)
    assert.equal(project.runtime.cpuPercent, null)
    assert.equal(project.deployed, false)
    // No current version means the LEFT JOIN produces no manifest at all, which
    // must read as "cannot have functions" rather than leaking null to the view.
    assert.equal(project.runtime.functions, false)
})

test('a static-only project reports that no runtime can exist for it', async () => {
    // The operator view rendered such a project as an amber `stopped` badge,
    // which reads as an outage next to a site that is serving perfectly. The
    // distinction has to survive the API, not just the rendering.
    const {response} = request('/projects', 'operator', sql => sql.includes('FROM projects p') ? [{
        id: 'p3', slug: 'brochure', status: 'ready', access_mode: 'network',
        owner_email: 'owner@example.edu', owner_name: 'Owner',
        postgres_enabled: false, storage_enabled: false, current_version_id: 'v9',
        database_bytes_max: '1', object_bytes_max: '1', runtime_memory_mb: 256, runtime_cpu: '0.25',
        postgres_bytes: null, object_bytes: null, measured_at: null,
        runtime_state: 'stopped', runtime_last_seen_at: null, runtime_error: null, has_functions: false,
        memory_bytes: null, memory_limit_bytes: null, cpu_percent: null, sampled_at: null,
        versions: '1', failed_versions: '0', last_deployed_at: new Date('2026-08-10T07:57:00Z'),
        created_at: new Date('2026-07-01T00:00:00Z'), deleted_at: null, purge_after: null,
    }] : [])

    const project = (await (await response).json() as {projects: Array<any>}).projects[0]
    assert.equal(project.deployed, true)
    assert.equal(project.runtime.functions, false)
    assert.equal(project.runtime.state, 'stopped')
})

test('the operator view never calls a functionless or idle runtime a fault', () => {
    // state() paints every value it does not recognise amber, and `stopped` is
    // the normal resting state of a healthy function as well as the permanent
    // state of a project that has none.
    const page = readFileSync(join(import.meta.dirname, '..', 'routes', 'admin.ts'), 'utf8')
    const badge = page.slice(page.indexOf('function runtimeBadge'), page.indexOf('function renderOverview'))
    assert.match(badge, /!p\.deployed/)
    assert.match(badge, /!p\.runtime\.functions/)
    assert.match(badge, /'stopped'/)
    // The project table has to use it rather than the shared state() helper.
    assert.match(page, /runtimeBadge\(p\)/)
    assert.doesNotMatch(page, /state\(p\.runtime\.state\)\+'<div/)
})

test('list limits are clamped so a query parameter cannot ask for the whole table', async () => {
    for (const [query, expected] of [['?limit=5', 5], ['?limit=100000', 200], ['?limit=0', 1], ['?limit=nonsense', 50]] as const) {
        let seen: unknown
        const pool = stubPool((sql, params) => {
            if (sql.includes('platform_role FROM accounts')) return [{platform_role: 'operator'}]
            seen = params?.[0]
            return []
        })
        const app = adminRoutes({
            pool,
            admin: new AdminService(pool, 'sites.example.test'),
            writes: new AdminWriteService(pool),
            authenticator: {} as never,
            tokens,
        })
        await app.request(`/jobs${query}`, {headers: {cookie: `__Host-ritsdev_session=${sessionFor('operator')}`}})
        assert.equal(seen, expected, `limit${query} must clamp to ${expected}`)
    }
})

test('operator emails are parsed forgivingly and applied declaratively', () => {
    assert.deepEqual(parseOperatorEmails('A@example.edu, b@example.edu; c@example.edu'), ['a@example.edu', 'b@example.edu', 'c@example.edu'])
    assert.deepEqual(parseOperatorEmails(' a@example.edu \n a@example.edu '), ['a@example.edu'])
    // Entries that cannot be an address are dropped rather than promoting nobody.
    assert.deepEqual(parseOperatorEmails('not-an-email, real@example.edu'), ['real@example.edu'])
    assert.deepEqual(parseOperatorEmails(undefined), [])
    assert.deepEqual(parseOperatorEmails(''), [])
})

test('unset lists leave existing roles untouched', async () => {
    const pool = stubPool(() => [])
    assert.deepEqual(await syncOperators(pool, undefined), {operators: [], superadmins: []})
    assert.deepEqual(await syncOperators(pool, '   ', '  '), {operators: [], superadmins: []})
    assert.deepEqual(pool.queries, [], 'no role may be changed when neither variable is set')
})

test('a configured operator list both promotes and demotes, in one statement', async () => {
    const pool = stubPool(() => [])
    const applied = await syncOperators(pool, 'lead@example.edu')

    assert.deepEqual(applied, {operators: ['lead@example.edu'], superadmins: []})
    // One statement, not two. Two passes have an order, and either order has a
    // wrong half: demote-then-promote leaves a gap, promote-then-demote strips
    // the role it just granted.
    assert.equal(pool.queries.length, 1)
    assert.match(pool.queries[0], /WHEN lower\(email\) = ANY\(\$1\) THEN 'operator'/)
    // Removing someone from the list must actually take the role away, or the
    // variable would only ever grow the operator set.
    assert.match(pool.queries[0], /ELSE 'user'/)
})

test('an account on both lists gets the higher role, and is not fought over', async () => {
    const pool = stubPool(() => [])
    const applied = await syncOperators(pool, 'lead@example.edu, both@example.edu', 'both@example.edu')

    // `both@example.edu` must not appear in the operator list as well: the promote
    // arm and the demote arm read the same two arrays, and an address in both
    // would have one arm undoing the other on every start.
    assert.deepEqual(applied, {operators: ['lead@example.edu'], superadmins: ['both@example.edu']})
    assert.deepEqual(pool.queries[0].includes("THEN 'superadmin'"), true)
})

test('naming only superadmins does not demote operators granted through the API', async () => {
    // The write surface can grant `operator`. A host that pins its superadmins
    // in the environment but manages operators through the API must not have
    // every one of those grants wiped on the next restart.
    const pool = stubPool(() => [])
    const applied = await syncOperators(pool, undefined, 'boss@example.edu')

    assert.deepEqual(applied, {operators: [], superadmins: ['boss@example.edu']})
    assert.equal(pool.queries.length, 1)
    // $3 arms the demotion clause. With no operator list there is nothing to
    // demote *against*, so it must be off rather than matching everyone.
    assert.equal(lastValues[2], false, 'the demotion arm is off when no operator list is given')
})

test('docker stats lines become byte counts', () => {
    const output = [
        JSON.stringify({Name: 'rits-site-aaa-bbb', MemUsage: '52.43MiB / 256MiB', CPUPerc: '1.23%', PIDs: '9'}),
        JSON.stringify({Name: 'rits-site-ccc-ddd', MemUsage: '1.5GiB / 2GiB', CPUPerc: '0.00%', PIDs: '17'}),
    ].join('\n')

    assert.deepEqual(parseDockerStats(output), [
        {name: 'rits-site-aaa-bbb', memoryBytes: 54976840, memoryLimitBytes: 268435456, cpuPercent: 1.23, pids: 9},
        {name: 'rits-site-ccc-ddd', memoryBytes: 1610612736, memoryLimitBytes: 2147483648, cpuPercent: 0, pids: 17},
    ])
})

test('unusable docker stats output is skipped, not fatal', () => {
    // A container can exit between listing the runtimes and sampling them, and
    // `docker stats` then emits a blank or partial record. Losing one sample is
    // acceptable; losing the whole housekeeping pass is not.
    assert.deepEqual(parseDockerStats(''), [])
    assert.deepEqual(parseDockerStats(null), [])
    assert.deepEqual(parseDockerStats('not json\n{"Name":"x"}\n'), [])
    assert.deepEqual(parseDockerStats(JSON.stringify({Name: 'x', MemUsage: '-- / --', CPUPerc: '--'})), [])
    assert.deepEqual(
        parseDockerStats(JSON.stringify({Name: 'x', MemUsage: '10MiB / 20MiB', CPUPerc: '--'})),
        [{name: 'x', memoryBytes: 10485760, memoryLimitBytes: 20971520, cpuPercent: 0, pids: 0}],
        'an unreadable CPU figure must not discard a good memory figure',
    )
})
