import assert from 'node:assert/strict'
import {test} from 'node:test'
import {HTTPException} from 'hono/http-exception'
import type {Authenticator, Principal, TokenService} from './authn'
import {accessModeSchema, type ProjectService} from './projects'
import {createTools, mcpRoutes} from '../routes/mcp'

/**
 * The MCP tool surface is the contract, not an accident of the REST routes:
 * the managed LLM binding shipped, was deployed, and was gated live while
 * `create_project` and `enable_project_resources` still offered only
 * `postgres` and `storage`. MCP is the primary client, so a resource missing
 * from these schemas does not exist as far as most callers are concerned.
 */

const PRINCIPAL: Principal = {
    accountId: '11111111-1111-4111-8111-111111111111',
    email: 'someone@example.edu',
    displayName: 'Someone',
    role: 'user',
    scopes: ['sites:read', 'sites:write'],
    tokenKind: 'pat',
}

type Schema = {properties: Record<string, {type?: string; default?: unknown; description?: string}>}

function schemaOf(name: string): Schema {
    const tool = createTools({} as ProjectService, undefined, 'https://sites.example.test')
        .find(candidate => candidate.name === name)
    assert.ok(tool, `${name} is not exposed over MCP`)
    return tool.inputSchema as unknown as Schema
}

function descriptionOf(name: string): string {
    const tool = createTools({} as ProjectService, undefined, 'https://sites.example.test')
        .find(candidate => candidate.name === name)
    assert.ok(tool, `${name} is not exposed over MCP`)
    return tool.description
}

/** An MCP app whose ProjectService is whatever the test needs it to be. */
function mcpApp(projects: Partial<ProjectService>) {
    return mcpRoutes({
        projects: projects as ProjectService,
        authenticator: {bearer: async () => PRINCIPAL} as unknown as Authenticator,
        tokens: {issuer: 'https://sites.example.test'} as TokenService,
        publicBaseUrl: 'https://sites.example.test',
    })
}

async function callTool(projects: Partial<ProjectService>, name: string, args: Record<string, unknown>) {
    const response = await mcpApp(projects).request('/', {
        method: 'POST',
        headers: {authorization: 'Bearer token', 'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
    })
    assert.equal(response.status, 200)
    return (await response.json() as {result: {content: Array<{text: string}>; structuredContent?: any; isError?: boolean}}).result
}

test('create_project offers the LLM binding, and offers it off by default', () => {
    const properties = schemaOf('create_project').properties
    assert.equal(properties.postgres.default, true)
    assert.equal(properties.storage.default, true)
    // Minting a key on a shared proxy is not something a caller should get by
    // omitting a field, which is exactly what `true` here would mean.
    assert.equal(properties.llm.type, 'boolean')
    assert.equal(properties.llm.default, false, 'the LLM binding must be opt-in')
})

test('enable_project_resources can turn on the LLM binding after creation', () => {
    const properties = schemaOf('enable_project_resources').properties
    assert.equal(properties.llm.type, 'boolean')
    // No default: an absent flag means "leave it alone", not "add it".
    assert.equal(properties.llm.default, undefined)
    assert.match(descriptionOf('enable_project_resources'), /LLM/,
        'a description naming only PostgreSQL and storage hides the third resource')
})

test('create_project passes llm through to the service rather than dropping it', async () => {
    const seen: unknown[] = []
    const result = await callTool({
        create: async (_p, input) => {
            seen.push(input)
            return {slug: 'demo', resources: {postgres: true, storage: true, llm: true}} as any
        },
    }, 'create_project', {slug: 'demo', llm: true})

    assert.deepEqual(seen, [{slug: 'demo', llm: true}])
    assert.equal(result.isError, false)
    assert.equal(result.structuredContent.resources.llm, true)
})

test('enable_project_resources passes llm through to the service', async () => {
    const seen: unknown[] = []
    const result = await callTool({
        enableResources: async (_p, slug, input) => {
            seen.push({slug, input})
            return {slug, resources: {postgres: true, storage: true, llm: true}} as any
        },
    }, 'enable_project_resources', {slug: 'demo', llm: true})

    assert.deepEqual(seen, [{slug: 'demo', input: {slug: 'demo', llm: true}}])
    assert.equal(result.structuredContent.resources.llm, true)
})

test('get_project reports whether the binding is on', async () => {
    const result = await callTool({
        get: async () => ({slug: 'demo', resources: {postgres: true, storage: true, llm: false}}) as any,
    }, 'get_project', {slug: 'demo'})

    assert.equal(result.structuredContent.resources.llm, false)
    assert.match(result.content[0].text, /"llm": false/)
})

test('a deployment with no LLM admin key refuses clearly instead of crashing', async () => {
    // LlmService.fromEnv returns null without LLM_ADMIN_KEY, and the service
    // then answers 503. Over MCP that has to arrive as a tool error carrying
    // the reason, not as a dropped connection or an empty result.
    const refuses = async () => {
        throw new HTTPException(503, {message: 'the managed LLM binding is not configured on this deployment'})
    }
    for (const [name, args] of [
        ['create_project', {slug: 'demo', llm: true}],
        ['enable_project_resources', {slug: 'demo', llm: true}],
    ] as const) {
        const result = await callTool({create: refuses, enableResources: refuses} as any, name, args)
        assert.equal(result.isError, true, `${name} must report the refusal`)
        assert.match(result.content[0].text, /managed LLM binding is not configured/)
    }
})

/**
 * The same drift, one axis over. The access modes are declared in three places
 * — the zod enum in the service, the REST route body, and the MCP tool schema —
 * and a tier that exists in two of them is a tier most callers cannot reach.
 * This is exactly how `llm` shipped without an MCP argument.
 */
test('every access mode the service accepts is offered over MCP', () => {
    const declared = accessModeSchema.options
    const offered = (schemaOf('update_project_access').properties.access as {enum?: string[]}).enum
    assert.deepEqual(offered, [...declared])
})

/**
 * Deliberately narrower than the service. A project that does not exist yet has
 * nothing to show and no description to show it under, so the gallery is
 * reached by update_project_access once there is a deployed version — which is
 * also the single place the description requirement is enforced.
 */
test('create_project does not offer showcase, because a new project has nothing to list', () => {
    const offered = (schemaOf('create_project').properties.access as {enum?: string[]}).enum
    assert.deepEqual(offered, ['owner', 'network'])
})

/**
 * The structural containment of the drafted description, asserted rather than
 * described. `get_showcase_draft` reads and `set_showcase_listing` writes, and
 * the writer takes text. If a `useDraft`-shaped argument ever appears here, a
 * model's words about a page reach every other user's home page without anyone
 * having chosen them.
 */
test('no single tool both drafts a description and publishes it', () => {
    const publish = schemaOf('set_showcase_listing').properties
    assert.ok(publish.description, 'the publishing tool takes the text itself')
    assert.deepEqual(Object.keys(publish).sort(), ['description', 'slug'])
    // And the tool that produces a draft cannot write anything.
    const draft = createTools({} as ProjectService, undefined, 'https://sites.example.test')
        .find(t => t.name === 'get_showcase_draft')!
    assert.equal(draft.scope, 'sites:read')
})

/**
 * The tool descriptions are the only instruction an agent gets before it acts,
 * and these two carry the one rule that is not enforceable in code: a person
 * decides what other people are told about their project.
 */
test('the showcase tools tell an agent to ask its human', () => {
    assert.match(descriptionOf('get_showcase_draft'), /SUGGESTION, NOT A LISTING/)
    assert.match(descriptionOf('get_showcase_draft'), /person you are working for/)
    assert.match(descriptionOf('set_showcase_listing'), /without asking them first/)
    // And update_project_access says what listing actually does, since that is
    // the call that makes a project visible to people who were not looking.
    assert.match(descriptionOf('update_project_access'), /gallery/)
})
