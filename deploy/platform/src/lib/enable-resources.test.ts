import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Pool} from 'pg'
import type {Principal} from './authn'
import {SecretBox} from './crypto'
import {LlmService} from './llm'
import {ProjectService} from './projects'

/**
 * `enable_project_resources` could add PostgreSQL and object storage but not
 * the LLM binding, so a project that discovered it needed a model had to be
 * deleted and rebuilt under a new slug — the same gap the first user reported
 * for PostgreSQL, left open for the third resource.
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

type Captured = {text: string; values: unknown[]}

function projectRow(overrides: Record<string, unknown> = {}) {
    return {
        id: PROJECT_ID,
        owner_id: PRINCIPAL.accountId,
        slug: 'demo',
        access_mode: 'owner',
        status: 'ready',
        current_version_id: null,
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
        created_at: new Date('2026-08-04T00:00:00Z'),
        ...overrides,
    }
}

/** A pool whose SELECTs answer with one project row and whose writes are recorded. */
function fakePool(row: Record<string, unknown>, failOn?: RegExp) {
    const calls: Captured[] = []
    const answer = async (text: string, values: unknown[] = []) => {
        calls.push({text, values})
        if (failOn?.test(text)) throw new Error('database refused the write')
        if (/FROM projects p LEFT JOIN/.test(text)) return {rows: [row], rowCount: 1}
        return {rows: [{id: 'job-1', status: 'queued'}], rowCount: 1}
    }
    const pool = {
        query: answer,
        connect: async () => ({query: answer, release() {}}),
    }
    return {pool: pool as unknown as Pool, calls}
}

/** An LLM service that mints without touching the network, and records revocations. */
function fakeLlm() {
    const revoked: string[] = []
    const impl = (async (url: any, init: any) => {
        const path = String(url)
        if (path.endsWith('/key/delete')) {
            revoked.push(JSON.parse(init.body).key_aliases[0])
            return new Response('{}', {status: 200})
        }
        return new Response(JSON.stringify({key: 'sk-project', expires: '2027-01-01T00:00:00Z'}), {status: 200})
    }) as unknown as typeof fetch
    return {revoked, service: new LlmService({adminKey: 'sk-admin', adminUrl: 'https://llm.test', fetchImpl: impl})}
}

function service(pool: Pool, llm: LlmService | null) {
    return new ProjectService(pool, 'sites.example.test', 'UTC', '/tmp/sources', new SecretBox('test-secret'), llm)
}

test('the LLM binding can be added to a project that already exists', async () => {
    const {pool, calls} = fakePool(projectRow())
    const {service: llm} = fakeLlm()
    await service(pool, llm).enableResources(PRINCIPAL, 'demo', {llm: true})

    const update = calls.find(call => /SET postgres_enabled = postgres_enabled OR/.test(call.text))
    assert.ok(update, 'the project row must be updated')
    assert.match(update.text, /llm_enabled = llm_enabled OR \$4/)
    assert.deepEqual(update.values, [PROJECT_ID, false, false, true])

    // The minted key is stored encrypted, next to its alias and expiry, or the
    // executor has a binding it cannot inject.
    const stored = calls.find(call => /SET llm_key_enc = \$2/.test(call.text))
    assert.ok(stored, 'the minted key must be persisted')
    assert.equal(new SecretBox('test-secret').decrypt(stored.values[1] as string), 'sk-project')
    assert.equal(stored.values[2], `ritsdev-${PROJECT_ID}`)

    // Provisioning is re-run so the rest of the resource row is refreshed the
    // same way adding PostgreSQL does.
    assert.ok(calls.some(call => /provision_project/.test(String(call.values[0] ?? ''))
        || /INSERT INTO jobs/.test(call.text)))
})

test('a project that already holds the binding is not re-minted', async () => {
    // Minting clears the alias first, so re-running it would revoke the key the
    // live runtime is using.
    const {pool, calls} = fakePool(projectRow({llm_enabled: true}))
    const {service: llm, revoked} = fakeLlm()
    await service(pool, llm).enableResources(PRINCIPAL, 'demo', {llm: true, storage: true})

    assert.deepEqual(revoked, [], 'an existing key must not be revoked')
    assert.equal(calls.some(call => /SET llm_key_enc = \$2/.test(call.text)), false)
})

test('the limits stored on the project are what the key is minted with', async () => {
    const {pool} = fakePool(projectRow({llm_rpm_max: 7, llm_tpm_max: 1234}))
    const minted: any[] = []
    const impl = (async (url: any, init: any) => {
        if (String(url).endsWith('/key/generate')) minted.push(JSON.parse(init.body))
        return new Response(JSON.stringify({key: 'sk-project'}), {status: 200})
    }) as unknown as typeof fetch
    await service(pool, new LlmService({adminKey: 'sk-admin', adminUrl: 'https://llm.test', fetchImpl: impl}))
        .enableResources(PRINCIPAL, 'demo', {llm: true})

    assert.equal(minted[0].rpm_limit, 7, 'a project an operator raised keeps its limits')
    assert.equal(minted[0].tpm_limit, 1234)
})

test('a deployment with no LLM admin credential refuses with 503 rather than 500', async () => {
    const {pool} = fakePool(projectRow())
    await assert.rejects(
        () => service(pool, null).enableResources(PRINCIPAL, 'demo', {llm: true}),
        (error: any) => error.status === 503 && /not configured/.test(error.message),
    )
})

test('adding postgres still works on a deployment with no LLM service', async () => {
    const {pool, calls} = fakePool(projectRow())
    await service(pool, null).enableResources(PRINCIPAL, 'demo', {postgres: true})
    const update = calls.find(call => /SET postgres_enabled = postgres_enabled OR/.test(call.text))
    assert.deepEqual(update?.values, [PROJECT_ID, true, false, false])
})

test('llm: false is a removal, and removals are refused like the other two', async () => {
    const {pool} = fakePool(projectRow())
    const {service: llm} = fakeLlm()
    await assert.rejects(
        () => service(pool, llm).enableResources(PRINCIPAL, 'demo', {llm: false}),
        (error: any) => error.status === 400 && /cannot be removed/.test(error.message),
    )
})

test('a request naming no resource at all is refused, and names all three', async () => {
    const {pool} = fakePool(projectRow())
    await assert.rejects(
        () => service(pool, null).enableResources(PRINCIPAL, 'demo', {}),
        (error: any) => error.status === 400 && /llm: true/.test(error.message),
    )
})

test('a key minted for a transaction that then fails is revoked, not left live', async () => {
    const {pool} = fakePool(projectRow(), /INSERT INTO project_resources/)
    const {service: llm, revoked} = fakeLlm()
    await assert.rejects(() => service(pool, llm).enableResources(PRINCIPAL, 'demo', {llm: true}))
    // One revocation clears the alias before minting; the second is the rollback.
    assert.deepEqual(revoked, [`ritsdev-${PROJECT_ID}`, `ritsdev-${PROJECT_ID}`])
})
