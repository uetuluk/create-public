import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Pool} from 'pg'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {Script} from 'node:vm'
import {Hono} from 'hono'
import {adminRoutes} from '../routes/admin'
import {AdminService, AdminWriteService} from './admin'
import {roleAtLeast, TokenService, type PlatformRole} from './authn'
import {apiErrorHandler} from './middleware'

/**
 * `/v1/admin` was read-only by construction: the router exposed no mutating
 * verb, so no amount of getting the role check wrong could change anything.
 * Adding PATCH removes that guarantee and replaces it with a check, and these
 * tests are what stands in for the property that used to be structural.
 *
 * The three that matter: an operator can read but not write, the tier is read
 * from the database rather than from the caller's token, and the superadmin
 * tier cannot be handed out or taken away through the surface it controls.
 */

const tokens = new TokenService({
    issuer: 'https://sites.example.test',
    resource: 'https://sites.example.test/mcp',
    sessionSecret: 'test-session-secret-that-is-long-enough',
})

/**
 * The router under the same error handler the deployed app installs, so a
 * refusal here carries the status and JSON body a real caller would see. A bare
 * router turns every Zod rejection into a 500 and a plain-text HTTPException
 * body, which would have this file asserting on its own harness.
 */
function mount(routes: Hono): Hono {
    const app = new Hono()
    app.onError(apiErrorHandler)
    app.route('/', routes)
    return app
}

const ACTOR = '11111111-1111-4111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'

type Captured = {text: string; values: unknown[]}

/**
 * @param claimed the role the session cookie was minted with
 * @param actual  the role the account holds in the control database now
 */
function harness(claimed: PlatformRole, actual: PlatformRole, target: Record<string, unknown> = {}) {
    const calls: Captured[] = []
    const answer = async (text: string, values: unknown[] = []) => {
        calls.push({text, values})
        if (/SELECT platform_role FROM accounts/.test(text)) return {rows: [{platform_role: actual}], rowCount: 1}
        if (/SELECT email, platform_role, project_quota FROM accounts/.test(text)) {
            return {rows: [{
                email: 'target@example.edu', platform_role: 'user' as PlatformRole, project_quota: 3, ...target,
            }], rowCount: 1}
        }
        if (/UPDATE accounts SET platform_role/.test(text)) {
            return {rows: [{platform_role: values[1], project_quota: values[2]}], rowCount: 1}
        }
        if (/FROM projects p\s+LEFT JOIN project_runtime/.test(text)) {
            return {rows: [{
                id: 'project-1', current_version_id: 'version-1', runtime_memory_mb: 256,
                runtime_cpu: '0.25', database_bytes_max: '536870912', object_bytes_max: '1610612736',
                version_limit: 5, runtime_state: 'running',
            }], rowCount: 1}
        }
        return {rows: [{id: 'job-1', status: 'queued'}], rowCount: 1}
    }
    const pool = {query: answer, connect: async () => ({query: answer, release() {}})} as unknown as Pool
    const app = mount(adminRoutes({
        pool,
        admin: new AdminService(pool, 'sites.example.test'),
        writes: new AdminWriteService(pool),
        authenticator: {} as never,
        tokens,
    }))
    const cookie = `__Host-ritsdev_session=${tokens.signSession({
        accountId: ACTOR, email: 'me@example.edu', displayName: 'Me', role: claimed,
    })}`
    const patch = (path: string, body: unknown) => app.request(path, {
        method: 'PATCH',
        headers: {cookie, 'content-type': 'application/json'},
        body: JSON.stringify(body),
    })
    return {calls, patch, wrote: () => calls.some(c => /^\s*UPDATE (accounts|projects)/m.test(c.text))}
}

test('the role ladder is ordered, and every check asks "at least"', () => {
    assert.equal(roleAtLeast('superadmin', 'operator'), true, 'a superadmin can do anything an operator can')
    assert.equal(roleAtLeast('operator', 'operator'), true)
    assert.equal(roleAtLeast('operator', 'superadmin'), false)
    assert.equal(roleAtLeast('user', 'operator'), false)
})

test('an operator may read the admin API but not write to it', async () => {
    const {patch, wrote} = harness('operator', 'operator')

    const response = await patch(`/accounts/${TARGET}`, {projectQuota: 40})

    assert.equal(response.status, 403)
    assert.match((await response.json() as any).message, /superadmin access is required/)
    assert.equal(wrote(), false, 'a refused write must not have touched a row')
})

test('a session minted as superadmin is refused once the account is demoted', async () => {
    // The cookie says superadmin and lasts twelve hours. The database is what
    // decides. Without this the only way to take the write surface away from
    // somebody would be to wait out their session.
    const {patch, wrote} = harness('superadmin', 'operator')

    assert.equal((await patch(`/accounts/${TARGET}`, {projectQuota: 40})).status, 403)
    assert.equal(wrote(), false)
})

test('a superadmin sets a quota, and the audit record carries the previous value', async () => {
    const {calls, patch} = harness('superadmin', 'superadmin')

    const response = await patch(`/accounts/${TARGET}`, {projectQuota: 40})

    assert.equal(response.status, 200)
    assert.equal((await response.json() as any).account.quotaColumn, 40)
    const update = calls.find(c => /UPDATE accounts SET platform_role/.test(c.text))!
    assert.equal(update.values[2], 40)
    const audit = calls.find(c => /INSERT INTO audit_events/.test(c.text))!
    assert.equal(audit.values[2], 'admin.account_updated')
    // "the quota is 40" cannot be undone by hand. "40, and it was 3" can.
    assert.deepEqual(JSON.parse(audit.values[3] as string).projectQuota, {from: 3, to: 40})
})

test('the account read is locked, so two concurrent patches cannot interleave', async () => {
    const {calls, patch} = harness('superadmin', 'superadmin')
    await patch(`/accounts/${TARGET}`, {projectQuota: 40})

    const read = calls.find(c => /SELECT email, platform_role, project_quota FROM accounts/.test(c.text))!
    assert.match(read.text, /FOR UPDATE/)
    assert.equal(calls.some(c => /BEGIN/.test(c.text)), true)
    assert.equal(calls.some(c => /COMMIT/.test(c.text)), true)
})

test('nobody can mint a superadmin through the API', async () => {
    const {patch, wrote} = harness('superadmin', 'superadmin')

    const response = await patch(`/accounts/${TARGET}`, {role: 'superadmin'})

    assert.equal(response.status, 403)
    assert.match((await response.json() as any).message, /PLATFORM_SUPERADMIN_EMAILS/)
    assert.equal(wrote(), false)
})

test('nobody can demote a superadmin through the API, themselves included', async () => {
    // Both arms of the same rule. If the tier that rewrites every account could
    // also rewrite who holds the tier, the environment would stop being the
    // answer to "who can do this" — and one bad PATCH could lock the platform
    // out of its own admin surface with no way back short of SQL.
    const peer = harness('superadmin', 'superadmin', {platform_role: 'superadmin'})
    const peerResponse = await peer.patch(`/accounts/${TARGET}`, {role: 'user'})
    assert.equal(peerResponse.status, 403)
    assert.match((await peerResponse.json() as any).message, /PLATFORM_SUPERADMIN_EMAILS/)
    assert.equal(peer.wrote(), false)

    const self = harness('superadmin', 'superadmin', {platform_role: 'superadmin'})
    const selfResponse = await self.patch(`/accounts/${ACTOR}`, {role: 'user'})
    assert.equal(selfResponse.status, 403)
    assert.match((await selfResponse.json() as any).message, /cannot change your own role/)
    assert.equal(self.wrote(), false)
})

test('a superadmin\'s quota can still be changed; only their role is pinned', async () => {
    const {patch} = harness('superadmin', 'superadmin', {platform_role: 'superadmin'})

    const response = await patch(`/accounts/${TARGET}`, {projectQuota: 60})

    assert.equal(response.status, 200)
    assert.equal((await response.json() as any).account.quotaColumn, 60)
})

test('granting operator warns when the environment will revert it', async () => {
    const calls: Captured[] = []
    const answer = async (text: string, values: unknown[] = []) => {
        calls.push({text, values})
        if (/SELECT platform_role FROM accounts/.test(text)) return {rows: [{platform_role: 'superadmin'}], rowCount: 1}
        if (/SELECT email, platform_role, project_quota FROM accounts/.test(text)) {
            return {rows: [{email: 't@example.edu', platform_role: 'user', project_quota: 3}], rowCount: 1}
        }
        if (/UPDATE accounts SET platform_role/.test(text)) {
            return {rows: [{platform_role: values[1], project_quota: values[2]}], rowCount: 1}
        }
        return {rows: [], rowCount: 0}
    }
    const pool = {query: answer, connect: async () => ({query: answer, release() {}})} as unknown as Pool
    const app = mount(adminRoutes({
        pool,
        admin: new AdminService(pool, 'sites.example.test'),
        writes: new AdminWriteService(pool),
        authenticator: {} as never,
        tokens,
        operatorEmailsPinned: true,
    }))
    const response = await app.request(`/accounts/${TARGET}`, {
        method: 'PATCH',
        headers: {
            cookie: `__Host-ritsdev_session=${tokens.signSession({
                accountId: ACTOR, email: 'me@example.edu', displayName: 'Me', role: 'superadmin',
            })}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({role: 'operator'}),
    })

    // The change is real, and it is also going to be undone by the next
    // restart. Saying only the first half is how somebody loses an afternoon.
    assert.equal(response.status, 200)
    assert.match((await response.json() as any).warning, /reverted on the next restart/)
})

test('changing runtime limits recycles a running container', async () => {
    // --memory and --cpus are set when the container is created, so a live
    // runtime keeps the old numbers until it is recreated, and the idle sweep
    // cannot recycle one that keeps getting traffic.
    const {calls, patch} = harness('superadmin', 'superadmin')

    const response = await patch('/projects/gate', {runtimeMemoryMiB: 512})

    assert.equal(response.status, 200)
    const body = await response.json() as any
    assert.equal(body.project.runtimeMemoryMiB, 512)
    assert.equal(body.project.runtimeRecycled, true)
    const job = calls.find(c => /INSERT INTO jobs/.test(c.text))!
    assert.equal(job.values[0], 'stop_runtime')
    assert.match(String(job.values[3]), /^stop:limits:/)
})

test('changing only storage limits leaves the runtime alone', async () => {
    // These are compared against measured usage by housekeeping, which reads
    // the column every pass. Restarting a container to apply them would be an
    // outage in exchange for nothing.
    const {calls, patch} = harness('superadmin', 'superadmin')

    const response = await patch('/projects/gate', {postgresBytes: 2 * 1024 * 1024 * 1024})

    assert.equal(response.status, 200)
    assert.equal((await response.json() as any).project.runtimeRecycled, false)
    assert.equal(calls.some(c => /INSERT INTO jobs/.test(c.text)), false)
})

test('a limit the column or the host could not hold is refused before any write', async () => {
    const {patch, wrote} = harness('superadmin', 'superadmin')

    for (const body of [
        {runtimeCpu: 100},           // NUMERIC(4,2) tops out at 99.99
        {runtimeMemoryMiB: 8},       // Deno cannot start in 8 MiB
        {versions: 0},               // version_limit must retain something
        {projectQuota: 0},           // CHECK (project_quota > 0)
        {projectQuota: 2.5},         // the column is INT
    ]) {
        const path = 'projectQuota' in body ? `/accounts/${TARGET}` : '/projects/gate'
        const response = await patch(path, body)
        assert.equal(response.status, 400, JSON.stringify(body))
    }
    assert.equal(wrote(), false)
})

test('an unknown field is refused rather than silently ignored', async () => {
    // .strict(): a typo'd `runtimeMemoryMB` that returned 200 would read as a
    // limit that had been applied and had not.
    const {patch} = harness('superadmin', 'superadmin')
    assert.equal((await patch('/projects/gate', {runtimeMemoryMB: 512})).status, 400)
    assert.equal((await patch(`/accounts/${TARGET}`, {quota: 40})).status, 400)
})

/** The page's client script, lifted out of the template literal it is served in. */
function pageScript(): string {
    const source = readFileSync(join(import.meta.dirname, '..', 'routes', 'admin.ts'), 'utf8')
    const page = source.slice(source.indexOf('const ADMIN_PAGE = `'), source.lastIndexOf('`'))
    return page.slice(page.indexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'))
}

test('the admin page script is syntactically valid', () => {
    // It is a string in a TypeScript file, so tsc never looks inside it. A typo
    // here is not a compile error, it is a blank page for whoever opens /admin
    // next, and nothing else in the suite would notice.
    const script = pageScript()
    assert.doesNotThrow(() => new Script(script), 'the /admin page script must parse')
    assert.equal(script.length > 1000, true, 'the extraction found the script, not an empty slice')
})

test('the page admits superadmins and offers editing only to them', () => {
    const script = pageScript()
    // The old gate was `me.role!=='operator'`, which locks out the tier above
    // it. The page carries the same rank ladder the server does rather than a
    // longer list of role names.
    assert.match(script, /const RANK=\{user:0,operator:1,superadmin:2\}/)
    assert.match(script, /if\(!atLeast\(ME\.role,'operator'\)\)/)
    assert.match(script, /canWrite=\(\)=>Boolean\(ME\)&&atLeast\(ME\.role,'superadmin'\)/)
    // Auto-refresh must stand down mid-edit: a redraw would replace the inputs
    // being typed into, and the save reads its values back off that row.
    assert.match(script, /if\(EDITING\|\|BUSY\)return/)
})

test('no privilege is gated on equalling operator rather than reaching it', () => {
    // The bug this prevents is quiet and one-directional: `role === 'operator'`
    // reads fine, passes review, and takes a privilege *away* from the tier
    // above it. Three places had it — ownedProject, both /v1/ops routes, and
    // the dashboard's admin link — and each would have left a superadmin with
    // strictly less access than an operator.
    const root = join(import.meta.dirname, '..')
    const files = [
        'lib/projects.ts', 'lib/admin.ts', 'lib/authn.ts', 'lib/middleware.ts',
        'routes/ops.ts', 'routes/admin.ts', 'routes/projects.ts', 'routes/dashboard.ts',
    ]
    for (const file of files) {
        const source = readFileSync(join(root, file), 'utf8')
        for (const [index, line] of source.split('\n').entries()) {
            // The admin page's role badge is a display switch, not a gate: it
            // renders superadmin on its own branch above this one.
            if (line.includes("return '<span class=\"badge warn\">operator")) continue
            assert.doesNotMatch(
                line,
                /role\s*[!=]==\s*'operator'/,
                `${file}:${index + 1} gates on equalling operator; use roleAtLeast so superadmin is not excluded`,
            )
        }
    }
})

test('every knob the control plane reads is actually passed to the container', () => {
    // DEFAULT_PROJECT_QUOTA was documented as a tunable for months and was
    // never in compose.yaml, so setting it in deploy/.env did nothing at all.
    // A variable the code reads and the compose file does not forward is not a
    // broken feature you can see — it is a setting that silently has no effect.
    const compose = readFileSync(join(import.meta.dirname, '..', '..', '..', 'compose.yaml'), 'utf8')
    for (const name of [
        'PLATFORM_OPERATOR_EMAILS',
        'PLATFORM_SUPERADMIN_EMAILS',
        'DEFAULT_PROJECT_QUOTA',
        'OPERATOR_PROJECT_QUOTA',
    ]) {
        assert.match(
            compose,
            new RegExp('^\\s*' + name + ':\\s*\\$\\{' + name, 'm'),
            `${name} is read by the control plane but not forwarded in deploy/compose.yaml`,
        )
    }
})
