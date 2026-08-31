import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import type {Authenticator, Principal, TokenService} from './authn'
import type {ProjectService} from './projects'
import {createTools, declaredArguments, mcpRoutes, toolSchemaVersion, unknownArguments} from '../routes/mcp'

/**
 * #61 added `llm` to two tools. A client that was already connected kept the
 * schema it had cached, whose `additionalProperties: false` made it strip the
 * new argument before sending anything, so the server answered 200 with
 * `llm: false` — byte-identical to the server bug that had just been fixed.
 *
 * The server cannot see an argument that never arrives. What it can do is stop
 * telling clients to strip, refuse what it genuinely does not know instead of
 * ignoring it, and publish the schema it is serving where a stale client can
 * still read it.
 */

const PRINCIPAL: Principal = {
    accountId: '11111111-1111-4111-8111-111111111111',
    email: 'someone@example.edu',
    displayName: 'Someone',
    role: 'user',
    scopes: ['sites:read', 'sites:write'],
    tokenKind: 'pat',
}

/** A repository mount holding just the two skill documents get_skill serves. */
async function skillRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ritsdev-mcp-schema-'))
    await mkdir(join(root, 'skills', 'create-ritsdev', 'references'), {recursive: true})
    await writeFile(join(root, 'skills', 'create-ritsdev', 'SKILL.md'), '# skill')
    await writeFile(join(root, 'skills', 'create-ritsdev', 'references', 'site-contract.md'), '# contract')
    return root
}

function tools(repoRoot?: string) {
    return createTools({} as ProjectService, repoRoot, 'https://sites.example.test')
}

function mcpApp(projects: Partial<ProjectService>, repoRoot?: string) {
    return mcpRoutes({
        projects: projects as ProjectService,
        authenticator: {bearer: async () => PRINCIPAL} as unknown as Authenticator,
        tokens: {issuer: 'https://sites.example.test'} as TokenService,
        repoRoot,
        publicBaseUrl: 'https://sites.example.test',
    })
}

async function rpc(projects: Partial<ProjectService>, method: string, params?: unknown, repoRoot?: string) {
    const response = await mcpApp(projects, repoRoot).request('/', {
        method: 'POST',
        headers: {authorization: 'Bearer token', 'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    })
    assert.equal(response.status, 200)
    return (await response.json()) as any
}

const callTool = (projects: Partial<ProjectService>, name: string, args: Record<string, unknown>, repoRoot?: string) =>
    rpc(projects, 'tools/call', {name, arguments: args}, repoRoot).then(body => body.result)

test('no tool tells clients to strip arguments it does not list', () => {
    for (const definition of tools()) {
        assert.equal(
            (definition.inputSchema as Record<string, unknown>).additionalProperties, undefined,
            `${definition.name} declares additionalProperties; a client that honours it drops any argument `
            + 'added after the client cached this schema, and the drop is invisible on both sides',
        )
    }
})

test('an argument this server does not know is refused, not ignored', async () => {
    let called = false
    const result = await callTool(
        {create: async () => { called = true; return {} as any }},
        'create_project',
        {slug: 'demo', llmm: true},
    )

    assert.equal(result.isError, true)
    assert.equal(called, false, 'a refused call must not reach the service')
    const text = result.content[0].text as string
    assert.match(text, /"llmm"/, 'the message must name the argument that was refused')
    assert.match(text, /slug, access, postgres, storage, llm/, 'and the arguments that would have worked')
    assert.match(text, /tool schema [0-9a-f]{12}/, 'and the schema those came from')
    assert.match(text, /reconnect/i, 'and what to do when the client is the stale side')
})

test('protocol metadata inside arguments is not mistaken for a typo', () => {
    const createProject = tools().find(t => t.name === 'create_project')!
    assert.deepEqual(unknownArguments(createProject, {slug: 'demo', _meta: {progressToken: 1}}), [])
    assert.deepEqual(unknownArguments(createProject, {slug: 'demo', llm: true}), [])
    assert.deepEqual(unknownArguments(createProject, {slug: 'demo', postgress: true}), ['postgress'])
})

test('declared arguments still reach the service untouched', async () => {
    const seen: unknown[] = []
    const result = await callTool({
        create: async (_p, input) => {
            seen.push(input)
            return {slug: 'demo', resources: {postgres: true, storage: true, llm: true}} as any
        },
    }, 'create_project', {slug: 'demo', llm: true})

    assert.equal(result.isError, false)
    assert.deepEqual(seen, [{slug: 'demo', llm: true}])
})

test('the schema fingerprint changes exactly when the surface does', () => {
    const surface = [{name: 'a', description: 'does a', inputSchema: {type: 'object', properties: {slug: {}}}}]
    const same = [{name: 'a', description: 'does a', inputSchema: {type: 'object', properties: {slug: {}}}}]
    const withNewArgument = [
        {name: 'a', description: 'does a', inputSchema: {type: 'object', properties: {slug: {}, llm: {}}}},
    ]

    assert.equal(toolSchemaVersion(surface), toolSchemaVersion(same))
    assert.notEqual(toolSchemaVersion(surface), toolSchemaVersion(withNewArgument))
    assert.match(toolSchemaVersion(surface), /^[0-9a-f]{12}$/)
})

test('get_skill reports the schema being served, which a stale client can still read', async () => {
    // get_skill's own arguments have not changed since the first release, so a
    // client working from an old schema can call it. That is what makes it the
    // one place worth publishing the current surface.
    const root = await skillRepo()
    try {
        const result = await callTool({}, 'get_skill', {resource: 'create-ritsdev'}, root)

        assert.equal(result.isError, false, result.content[0].text)
        const skill = result.structuredContent
        assert.equal(skill.text, '# skill')
        assert.match(skill.toolSchemaVersion, /^[0-9a-f]{12}$/)
        assert.deepEqual(skill.toolParameters.create_project, ['slug', 'access', 'postgres', 'storage', 'llm'])
        assert.ok(skill.toolParameters.enable_project_resources.includes('llm'))
        assert.equal(
            skill.toolParameters.create_project.join(),
            declaredArguments(tools(root).find(t => t.name === 'create_project')!).join(),
        )
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})

test('initialize and get_skill agree on the schema id, so a client can compare its own', async () => {
    const root = await skillRepo()
    try {
        const initialize = await rpc({}, 'initialize', undefined, root)
        const skill = await callTool({}, 'get_skill', {}, root)
        const version = skill.structuredContent.toolSchemaVersion

        assert.match(initialize.result.instructions, new RegExp(`Tool schema ${version}`))
        assert.match(initialize.result.instructions, /stale tool schema/)
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})
