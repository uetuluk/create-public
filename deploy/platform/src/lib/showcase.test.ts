import assert from 'node:assert/strict'
import {mkdtemp, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import type {Pool} from 'pg'
import type {Principal} from './authn'
import {SecretBox} from './crypto'
import {
    ACCESS_RANK,
    isNetworkReachable,
    MAX_SHOWCASE_DESCRIPTION,
    ProjectService,
    accessModeSchema,
} from './projects'

/**
 * The showcase tier puts one project on every other user's home page, so what
 * is asserted here is mostly about what does *not* happen: a listing with no
 * words from its owner, a model's draft reaching the gallery, an image that is
 * not an image, and a project losing network reachability because a third
 * access mode was added above it.
 */

const PRINCIPAL: Principal = {
    accountId: 'account-1',
    email: 'someone@example.edu',
    displayName: 'Someone',
    role: 'user',
    scopes: ['sites:read', 'sites:write'],
    tokenKind: 'pat',
}

const PROJECT_ID = '11111111-2222-3333-4444-555555555555'

function projectRow(overrides: Record<string, unknown> = {}) {
    return {
        id: PROJECT_ID,
        owner_id: PRINCIPAL.accountId,
        slug: 'demo',
        access_mode: 'network',
        status: 'ready',
        current_version_id: 'version-1',
        runtime_memory_mb: 256,
        runtime_cpu: '0.25',
        database_bytes_max: '1',
        object_bytes_max: '1',
        version_limit: 5,
        postgres_enabled: true,
        storage_enabled: true,
        llm_enabled: false,
        llm_rpm_max: 60,
        llm_tpm_max: 200_000,
        created_at: new Date('2026-08-19T00:00:00Z'),
        showcase_description: 'Book a slot in the fabrication lab.',
        showcase_shot_source: null,
        showcase_shot_at: null,
        showcase_draft: null,
        showcase_draft_at: null,
        ...overrides,
    }
}

type Captured = {text: string; values: unknown[]}

function fakePool(row: Record<string, unknown>, showcaseRows: Record<string, unknown>[] = []) {
    const calls: Captured[] = []
    const answer = async (text: string, values: unknown[] = []) => {
        calls.push({text, values})
        if (/JOIN accounts a ON a\.id = p\.owner_id/.test(text)) {
            return {rows: showcaseRows, rowCount: showcaseRows.length}
        }
        if (/FROM projects p LEFT JOIN/.test(text)) return {rows: [row], rowCount: 1}
        // Mirrors what the CTE really does: hands back the path the row held
        // *before* it was cleared. A fake that answered null here would have
        // hidden the RETURNING bug this shape exists to avoid.
        if (/WITH previous AS/.test(text)) {
            return {rows: [{showcase_shot_path: row.showcase_shot_path ?? null}], rowCount: 1}
        }
        if (/SELECT showcase_shot_path/.test(text)) return {rows: [row], rowCount: 1}
        return {rows: [{id: 'job-1', status: 'queued'}], rowCount: 1}
    }
    const pool = {query: answer, connect: async () => ({query: answer, release() {}})}
    return {pool: pool as unknown as Pool, calls}
}

async function service(pool: Pool) {
    const root = await mkdtemp(join(tmpdir(), 'showcase-'))
    return {
        root,
        projects: new ProjectService(pool, 'sites.example.test', 'UTC', join(root, 'sources'),
            new SecretBox('test-secret'), null, root),
    }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

test('the three access modes form a ladder, and everything above owner is reachable', () => {
    assert.deepEqual(accessModeSchema.options, ['owner', 'network', 'showcase'])
    assert.equal(isNetworkReachable('owner'), false)
    assert.equal(isNetworkReachable('network'), true)
    // The regression that would matter: a showcase site must still be served to
    // the network. Testing the helper rather than the literal is the point —
    // every reachability check goes through it.
    assert.equal(isNetworkReachable('showcase'), true)
    assert.ok(ACCESS_RANK.showcase > ACCESS_RANK.network)
    assert.ok(ACCESS_RANK.network > ACCESS_RANK.owner)
})

test('a project cannot enter the gallery with no description', async () => {
    const {pool, calls} = fakePool(projectRow({showcase_description: '   '}))
    const {projects} = await service(pool)
    await assert.rejects(
        () => projects.updateAccess(PRINCIPAL, 'demo', 'showcase'),
        (error: any) => error.status === 409 && /description/.test(error.message),
    )
    // Refused before the write, so a project is never briefly listed unlabelled.
    assert.equal(calls.filter(c => /SET access_mode/.test(c.text)).length, 0)
})

test('entering the gallery queues a review and a capture; leaving it drops the image', async () => {
    const {pool, calls} = fakePool(projectRow({access_mode: 'network'}))
    const {projects} = await service(pool)
    await projects.updateAccess(PRINCIPAL, 'demo', 'showcase')
    const kinds = calls.flatMap(c => c.values).filter(v => typeof v === 'string')
    assert.ok(kinds.includes('capture_showcase'), 'a capture is queued')
    // network -> showcase widens exposure, so the page is reviewed again.
    assert.ok(kinds.includes('review_site'), 'a review is queued')

    const leaving = fakePool(projectRow({access_mode: 'showcase'}))
    const left = await service(leaving.pool)
    await left.projects.updateAccess(PRINCIPAL, 'demo', 'network')
    const clear = leaving.calls.find(c => /showcase_shot_path = NULL/.test(c.text))
    assert.ok(clear, 'the listing image is released when the project stops being listed')
    // PostgreSQL's RETURNING yields the *new* row, so reading the path back
    // from the same UPDATE that nulls it returns null and deletes nothing —
    // the database looks right while every delisted project leaks its
    // screenshot for good. The pre-update snapshot has to come from a CTE.
    assert.match(clear.text, /WITH previous AS/)
    assert.doesNotMatch(clear.text, /SET showcase_shot_path = NULL[\s\S]*RETURNING showcase_shot_path/)
    assert.ok(
        !leaving.calls.flatMap(c => c.values).includes('capture_showcase'),
        'stepping down does not spend a heavy render',
    )
})

test('a description is trimmed, collapsed, and bounded', async () => {
    const {pool, calls} = fakePool(projectRow())
    const {projects} = await service(pool)
    await projects.setShowcaseListing(PRINCIPAL, 'demo', '  Books   lab\n slots.  ')
    const write = calls.find(c => /SET showcase_description/.test(c.text))
    assert.equal(write?.values[0], 'Books lab slots.')

    await assert.rejects(() => projects.setShowcaseListing(PRINCIPAL, 'demo', '   '), /required/)
    await assert.rejects(
        () => projects.setShowcaseListing(PRINCIPAL, 'demo', 'x'.repeat(MAX_SHOWCASE_DESCRIPTION + 1)),
        (error: any) => error.status === 400,
    )
})

/**
 * There is deliberately no path from a drafted description to a published one.
 * If a `useDraft` argument ever appears on this method, the model's words reach
 * other people's screens without anyone having chosen them.
 */
test('publishing a description takes text and nothing else', () => {
    assert.equal(ProjectService.prototype.setShowcaseListing.length, 3, 'principal, slug, description')
})

test('an uploaded screenshot must actually be a PNG, and is recorded as uploaded', async () => {
    const {pool, calls} = fakePool(projectRow())
    const {root, projects} = await service(pool)
    await projects.setShowcaseScreenshot(PRINCIPAL, 'demo', PNG)
    const written = await readFile(join(root, `${PROJECT_ID}.png`))
    assert.deepEqual(written, PNG)
    const write = calls.find(c => /showcase_shot_source = 'uploaded'/.test(c.text))
    assert.ok(write, 'the source is recorded so a later capture does not overwrite it')

    // The declared content type is the caller's; the magic bytes are not.
    await assert.rejects(
        () => projects.setShowcaseScreenshot(PRINCIPAL, 'demo', Buffer.from('<svg onload=alert(1)>')),
        (error: any) => error.status === 400 && /not a PNG/.test(error.message),
    )
    await assert.rejects(
        () => projects.setShowcaseScreenshot(PRINCIPAL, 'demo', Buffer.alloc(0)),
        (error: any) => error.status === 400,
    )
})

test('base64 that does not round-trip is refused rather than decoded to other bytes', async () => {
    const {pool} = fakePool(projectRow())
    const {projects} = await service(pool)
    await assert.rejects(
        () => projects.setShowcaseScreenshotBase64(PRINCIPAL, 'demo', 'not base64!!'),
        (error: any) => error.status === 400,
    )
    await projects.setShowcaseScreenshotBase64(PRINCIPAL, 'demo', PNG.toString('base64'))
})

test('the gallery hides urgent verdicts, undeployed projects and unlabelled ones', async () => {
    const {pool, calls} = fakePool(projectRow(), [])
    const {projects} = await service(pool)
    await projects.listShowcase()
    const sql = calls.find(c => /JOIN accounts a/.test(c.text))!.text
    assert.match(sql, /access_mode = 'showcase'/)
    assert.match(sql, /current_version_id IS NOT NULL/)
    assert.match(sql, /showcase_description <> ''/)
    // Unreviewed is not suspect: a project with no review row is still listed.
    assert.match(sql, /COALESCE\(r\.level, 'review'\) <> 'urgent'/)
    // What is NOT selected is the boundary, so this reads the select list
    // rather than the whole statement: p.id legitimately appears in the join
    // predicate below, and it is being *returned* that would matter.
    const selected = sql.slice(0, sql.indexOf('FROM projects p'))
    assert.doesNotMatch(selected, /email/)
    assert.doesNotMatch(selected, /p\.id|owner_id/)
    assert.doesNotMatch(selected, /showcase_draft/)
    assert.doesNotMatch(selected, /status|access_mode/)
    // Page loads are published; the distinct-visitor count never is. On a
    // campus this size that figure comes close to naming the people behind it.
    assert.match(sql, /sum\(views\)/)
    assert.doesNotMatch(sql, /visitor/)
})

test('a gallery entry carries the owner text, never the draft', async () => {
    const {pool} = fakePool(projectRow(), [{
        slug: 'demo',
        showcase_description: 'Book a slot in the fabrication lab.',
        showcase_shot_at: new Date('2026-08-19T00:00:00Z'),
        display_name: 'Ada L',
    }])
    const {projects} = await service(pool)
    const [entry] = await projects.listShowcase()
    assert.deepEqual(entry, {
        slug: 'demo',
        url: 'https://demo.sites.example.test',
        description: 'Book a slot in the fabrication lab.',
        ownerName: 'Ada L',
        screenshotUrl: '/v1/showcase/demo/screenshot.png',
        capturedAt: '2026-08-19T00:00:00.000Z',
        // This row has no visit rows behind it at all, which is what a project
        // that has just been listed looks like. Without the fallback in the
        // mapper this is NaN, which serialises to null and renders on the card
        // as "null views".
        views: 0,
    })
    assert.ok(!('draft' in entry), 'the draft has no route into the gallery')
})

/**
 * The image route has no ownership check — every signed-in account may see the
 * gallery — so the lookup itself is the scope. A URL kept from a project that
 * has since left the showcase must stop resolving.
 */
test('a screenshot is served only for a project that is actually listed', async () => {
    const {pool, calls} = fakePool(projectRow())
    const {projects} = await service(pool)
    await projects.showcaseScreenshot('demo').catch(() => undefined)
    const sql = calls.find(c => /SELECT showcase_shot_path/.test(c.text))!.text
    assert.match(sql, /access_mode = 'showcase'/)
    assert.match(sql, /status = 'ready'/)
    // And the slug is validated before it reaches the query.
    await assert.rejects(() => projects.showcaseScreenshot('../../etc/passwd'))
})

test('a row whose file has gone answers 404 rather than throwing', async () => {
    const {pool} = fakePool(projectRow({
        showcase_shot_path: '/nonexistent/missing.png',
        showcase_shot_at: new Date(),
    }))
    const {projects} = await service(pool)
    await assert.rejects(
        () => projects.showcaseScreenshot('demo'),
        (error: any) => error.status === 404,
    )
})
