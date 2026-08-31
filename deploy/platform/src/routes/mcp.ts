import {createHash} from 'node:crypto'
import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {bodyLimit} from 'hono/body-limit'
import {z} from 'zod'
import {requireScopes, type Authenticator, type Principal, type Scope, type TokenService} from '../lib/authn'
import type {ProjectService} from '../lib/projects'
import {readSkillResource, skillResources} from '../lib/skill-resources'

type ToolDefinition = {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    scope: Scope
    run: (principal: Principal, input: any) => Promise<unknown>
}

export function mcpRoutes(deps: {
    projects: ProjectService
    authenticator: Authenticator
    tokens: TokenService
    repoRoot?: string
    publicBaseUrl: string
}) {
    // The host is what a client sees itself connected to, so it names the
    // installation rather than any one deployment of it.
    const publicHost = new URL(deps.publicBaseUrl).host
    const resources = skillResources(deps.repoRoot, deps.publicBaseUrl)
    const tools = createTools(deps.projects, deps.repoRoot, deps.publicBaseUrl)
    const schemaVersion = toolSchemaVersion(tools)
    const app = new Hono()
    app.use('*', bodyLimit({maxSize: 1024 * 1024}))

    app.get('/', c => c.json({
        jsonrpc: '2.0',
        error: {code: -32000, message: 'Use POST for Streamable HTTP MCP'},
        id: null,
    }, 405))
    app.delete('/', c => c.body(null, 405))
    app.post('/', async c => {
        const auth = c.req.header('authorization')
        if (!auth?.startsWith('Bearer ')) {
            c.header('WWW-Authenticate', `Bearer resource_metadata="${deps.tokens.issuer}/.well-known/oauth-protected-resource"`)
            throw new HTTPException(401, {message: 'missing bearer token'})
        }
        let principal: Principal
        try {
            principal = await deps.authenticator.bearer(auth.slice(7).trim())
        } catch {
            throw new HTTPException(401, {message: 'invalid bearer token'})
        }
        const request = await c.req.json<{
            jsonrpc?: string
            id?: string | number | null
            method?: string
            params?: any
        }>()
        c.header('MCP-Protocol-Version', '2025-06-18')
        if (request.method === 'notifications/initialized') return c.body(null, 202)
        if (request.method === 'initialize') {
            return c.json({
                jsonrpc: '2.0',
                id: request.id ?? null,
                result: {
                    protocolVersion: '2025-06-18',
                    // Resources are advertised only when the skills tree is
                    // actually mounted and readable: announcing a capability
                    // that then returns nothing is worse than not having it.
                    capabilities: {
                        tools: {listChanged: false},
                        ...(resources.length ? {resources: {subscribe: false, listChanged: false}} : {}),
                    },
                    serverInfo: {name: publicHost, version: '1.0.0'},
                    // The tool schema id is here and in get_skill on purpose.
                    // A client that cached tools/list at connect time keeps
                    // serving the model an old schema after a deploy, and the
                    // only symptom is an argument that appears to be ignored.
                    // Two ids that differ say which side is stale in one call.
                    instructions: `Create, version, deploy, inspect, and manage sites private to this platform's network.`
                        + ` Tool schema ${schemaVersion}. If an argument you passed appears to have been ignored,`
                        + ` call get_skill and compare its toolSchemaVersion with this one: if they differ, this`
                        + ` connection is holding a stale tool schema and must be reconnected.`,
                },
            })
        }
        if (request.method === 'ping') return c.json({jsonrpc: '2.0', id: request.id ?? null, result: {}})
        if (request.method === 'resources/list') {
            return c.json({jsonrpc: '2.0', id: request.id ?? null, result: {resources}})
        }
        // Some clients probe for templates before listing; answering with an
        // empty set is friendlier than method-not-found.
        if (request.method === 'resources/templates/list') {
            return c.json({jsonrpc: '2.0', id: request.id ?? null, result: {resourceTemplates: []}})
        }
        if (request.method === 'resources/read') {
            const uri = request.params?.uri
            const resource = typeof uri === 'string'
                ? readSkillResource(deps.repoRoot, deps.publicBaseUrl, uri)
                : null
            if (!resource) return rpcError(c, request.id, -32602, `unknown resource: ${uri}`)
            return c.json({
                jsonrpc: '2.0',
                id: request.id ?? null,
                result: {contents: [resource]},
            })
        }
        if (request.method === 'tools/list') {
            return c.json({
                jsonrpc: '2.0',
                id: request.id ?? null,
                result: {tools: tools.map(({run, scope, ...definition}) => definition)},
            })
        }
        if (request.method === 'tools/call') {
            const name = request.params?.name
            const tool = tools.find(candidate => candidate.name === name)
            if (!tool) return rpcError(c, request.id, -32602, `unknown tool: ${name}`)
            const args = request.params?.arguments ?? {}
            const unknown = unknownArguments(tool, args)
            if (unknown.length) {
                return c.json({
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    result: {
                        content: [{type: 'text', text: unknownArgumentMessage(tool, unknown, schemaVersion)}],
                        isError: true,
                    },
                })
            }
            try {
                requireScopes(principal, tool.scope)
                const output = await tool.run(principal, args)
                const rendered = renderToolResult(name, output)
                return c.json({
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    result: {
                        content: rendered.content,
                        structuredContent: rendered.structuredContent,
                        isError: false,
                    },
                })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return c.json({
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    result: {content: [{type: 'text', text: message}], isError: true},
                })
            }
        }
        return rpcError(c, request.id, -32601, 'method not found')
    })
    return app
}

/** Exported for tests: the tool surface is the contract MCP clients see. */
export function createTools(projects: ProjectService, repoRoot: string | undefined, publicBaseUrl: string): ToolDefinition[] {
    /**
     * Deliberately does not declare `additionalProperties: false`. Hosts that
     * validate against a cached schema strip undeclared arguments before the
     * request is sent, so adding a parameter — `llm` in #61 — reached the
     * server as an argument that was never there, and looked exactly like the
     * server ignoring it. Leaving unknown properties allowed means a parameter
     * added later arrives here even from a client whose cached schema predates
     * it, and `unknownArguments` below refuses what this server really does not
     * know instead of dropping it silently.
     */
    const object = (properties: Record<string, unknown>, required: string[] = []) => ({
        type: 'object', properties, required,
    })
    const string = (description?: string) => ({type: 'string', ...(description ? {description} : {})})
    const slug = string('Project slug, 3-40 lowercase characters, digits, or hyphens.')
    const definitions: ToolDefinition[] = [
        // Duplicates the resource surface on purpose: many MCP hosts consume
        // tools only, and the skill is where every trap in this platform is
        // written down.
        tool('get_skill', 'Read the platform skill: how to build, deploy, and operate a site here, and the traps that catch first-time authors. Read this before creating your first project. The reply also carries "toolSchemaVersion" and "toolParameters", the tool surface this server is serving right now: compare them with the schema your client cached when an argument you passed appears to have been ignored.', object({
            resource: {
                type: 'string',
                enum: ['create-ritsdev', 'site-contract'],
                default: 'create-ritsdev',
                description: '"create-ritsdev" is the workflow and traps; "site-contract" is the manifest and runtime reference.',
            },
        }), 'sites:read', async (_p, i) => {
            const found = readSkillResource(repoRoot, publicBaseUrl, i.resource ?? 'create-ritsdev')
            if (!found) throw new Error('the skill documents are not available in this deployment')
            // A client holding a stale schema can still call this tool, since
            // its arguments have not changed. It is therefore the one place
            // that can tell such a client what the server actually accepts.
            return {
                uri: found.uri,
                text: found.text,
                toolSchemaVersion: toolSchemaVersion(definitions),
                toolParameters: Object.fromEntries(definitions.map(d => [d.name, declaredArguments(d)])),
            }
        }),
        tool('list_projects', 'List projects owned by the current user.', object({}), 'sites:read',
            (p) => projects.list(p)),
        tool('get_project', 'Get project state, quotas, usage, provisioning state, and production URL. "resources" reports which managed bindings the project holds — postgres, storage, and llm — and "quota" carries the LLM request and token per-minute limits.', object({slug}, ['slug']), 'sites:read',
            (p, i) => projects.get(p, z.string().parse(i.slug))),
        tool('create_project', 'Create and asynchronously provision a project.', object({
            slug,
            access: {type: 'string', enum: ['owner', 'network'], default: 'owner'},
            postgres: {type: 'boolean', default: true},
            storage: {type: 'boolean', default: true},
            // Opt-in, unlike the other two: this mints a real credential on a
            // shared inference proxy, so a project takes a share of it only
            // when it says it needs one.
            llm: {
                type: 'boolean',
                default: false,
                description: 'Set true to mint a project-scoped key for the managed LLM binding. The runtime then receives LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL, and the manifest must declare resources.llm to build.',
            },
        }, ['slug']), 'sites:write', (p, i) => projects.create(p, i)),
        tool('update_project_access', 'Set who can visit this site. "owner" is the owner alone after signing in. "network" is anyone on the private network who already has the URL. "showcase" is "network" plus a card in the gallery on every signed-in user\'s dashboard — so it advertises the project to people who were not looking for it. Setting "showcase" requires a deployed version and a description: call set_showcase_listing first, or this returns 409.', object({
            slug,
            access: {
                type: 'string',
                enum: ['owner', 'network', 'showcase'],
                description: '"owner", "network", or "showcase". These are a ladder: each one is reachable by everyone the one before it was, plus more.',
            },
        }, ['slug', 'access']), 'sites:write', (p, i) => projects.updateAccess(p, i.slug, i.access)),
        tool('list_showcase', 'Browse the gallery: projects whose owners have chosen to advertise them to everyone on the platform. Returns each project\'s slug, URL, the description its owner wrote, and the owner\'s name. Deployed sites resolve only on the private network, so a URL here is not fetchable from outside it.', object({
            limit: {type: 'integer', minimum: 1, maximum: 200, default: 60},
        }), 'sites:read', (_p, i) => projects.listShowcase(i.limit ?? 60)),
        tool('get_showcase_draft', 'Read a suggested description for a project, written by a model that looked at the deployed page. THIS IS A SUGGESTION, NOT A LISTING. Show it to the person you are working for, ask them whether it is right, and pass whatever they say to set_showcase_listing — their words, not this text. It is generated from the project\'s own page, so it can be wrong or overstated, and it never publishes itself. Also returns the current published description and when the screenshot was last captured.', object({
            slug,
        }, ['slug']), 'sites:read', async (p, i) => (await projects.get(p, i.slug)).showcase),
        tool('set_showcase_listing', 'Set the one line shown under this project\'s screenshot in the gallery, on every signed-in user\'s dashboard. Pass the description the project\'s owner gave you. Do not pass get_showcase_draft\'s text without asking them first: it was written by a model reading a page, and this is the step where a person decides what other people are told about their project. Maximum 200 characters.', object({
            slug,
            description: string('One sentence, at most 200 characters, saying what this app is for.'),
        }, ['slug', 'description']), 'sites:write', (p, i) => projects.setShowcaseListing(p, i.slug, i.description)),
        tool('set_showcase_screenshot', 'Replace the gallery screenshot with your own PNG, as base64. The platform captures one automatically when a project is listed and after every deploy; this is for when that picture is not the one the owner wants. An uploaded image is never overwritten by a later automatic capture. At most 512 KiB decoded — larger images do not fit one MCP request; use PUT /v1/projects/:slug/showcase/screenshot for up to 2 MiB.', object({
            slug,
            dataBase64: string('The PNG file, base64-encoded. At most 512 KiB once decoded.'),
        }, ['slug', 'dataBase64']), 'sites:write', (p, i) => projects.setShowcaseScreenshotBase64(p, i.slug, i.dataBase64)),
        tool('enable_project_resources', 'Add PostgreSQL, object storage, or the managed LLM binding to an existing project. Resources cannot be removed. Provisioning is asynchronous; poll get_project until resources.provisionState is "ready" before deploying a version with migrations. A running runtime keeps the environment it started with, so rebuild and redeploy after adding a resource.', object({
            slug,
            postgres: {type: 'boolean', description: 'Set true to add a PostgreSQL database.'},
            storage: {type: 'boolean', description: 'Set true to add an object storage bucket.'},
            llm: {type: 'boolean', description: 'Set true to add the managed LLM binding, minting a project-scoped key. The manifest must then declare resources.llm, so this needs a rebuild, not only a redeploy.'},
        }, ['slug']), 'sites:write', (p, i) => projects.enableResources(p, i.slug, i)),
        tool('set_project_secrets', 'Create, replace, or delete write-only runtime secrets. Use null to delete a secret. Declaring a secret is also what adds its name to the function runtime\'s Deno --allow-env allowlist.', object({
            slug, secrets: {type: 'object', additionalProperties: {type: ['string', 'null']}},
        }, ['slug', 'secrets']), 'sites:write', (p, i) => projects.setSecrets(p, i.slug, i.secrets)),
        tool('begin_source_upload', 'Begin a chunked gzip-compressed tar source upload.', object({
            slug, sha256: string('Lowercase SHA-256 of the complete archive.'), sizeBytes: {type: 'integer', minimum: 1, maximum: 26214400},
        }, ['slug', 'sha256', 'sizeBytes']), 'sites:write', (p, i) => projects.beginUpload(p, i.slug, i.sha256, i.sizeBytes)),
        tool('upload_source_chunk', 'Upload a base64 source chunk. Send chunks in order; re-send an earlier chunkIndex to replace a chunk that arrived corrupted, without restarting the upload.', object({
            uploadId: string(),
            chunkIndex: {type: 'integer', minimum: 0},
            dataBase64: string(),
            sha256: string('Lowercase SHA-256 of this chunk\'s decoded bytes. Strongly recommended: it catches a bad chunk on arrival instead of after the whole archive is sent.'),
        }, ['uploadId', 'chunkIndex', 'dataBase64']), 'sites:write',
        (p, i) => projects.uploadChunk(p, i.uploadId, i.chunkIndex, i.dataBase64, i.sha256)),
        tool('complete_source_upload', 'Verify and finalize a chunked source upload. On a mismatch the chunks are kept: call get_source_upload, then re-send only the chunk that differs.', object({
            uploadId: string(),
        }, ['uploadId']), 'sites:write', (p, i) => projects.completeUpload(p, i.uploadId)),
        tool('get_source_upload', 'Inspect an in-progress upload: expected digest and size, bytes received, and the index, length, and sha256 of every stored chunk. Use it to find which chunk to re-send after a failed completion.', object({
            uploadId: string(),
        }, ['uploadId']), 'sites:read', (p, i) => projects.getUpload(p, i.uploadId)),
        tool('abort_source_upload', 'Discard an in-progress upload and its chunks.', object({
            uploadId: string(),
        }, ['uploadId']), 'sites:write', (p, i) => projects.abortUpload(p, i.uploadId)),
        tool('create_version', 'Build an immutable version from an uploaded source revision.', object({
            slug, sourceRevisionId: string(), idempotencyKey: string(),
        }, ['slug', 'sourceRevisionId']), 'deployments:write',
        (p, i) => projects.createVersion(p, i.slug, i.sourceRevisionId, i.idempotencyKey)),
        tool('list_versions', 'List retained versions for a project.', object({slug}, ['slug']), 'sites:read',
            (p, i) => projects.listVersions(p, i.slug)),
        tool('get_version', 'Get build state and preview URL for a version.', object({
            slug, versionId: string(),
        }, ['slug', 'versionId']), 'sites:read', (p, i) => projects.getVersion(p, i.slug, i.versionId)),
        tool('deploy_version', 'Atomically promote a ready version to production; deploying an older version rolls back code.', object({
            slug, versionId: string(), idempotencyKey: string(),
        }, ['slug', 'versionId']), 'deployments:write',
        (p, i) => projects.deploy(p, i.slug, i.versionId, i.idempotencyKey)),
        tool('get_deployment', 'Get queued, deploying, active, or failed deployment state.', object({
            slug, deploymentId: string(),
        }, ['slug', 'deploymentId']), 'sites:read',
        (p, i) => projects.getDeployment(p, i.slug, i.deploymentId)),
        tool('get_logs', 'Read recent build, deployment, and runtime logs.', object({
            slug, limit: {type: 'integer', minimum: 1, maximum: 1000, default: 200},
        }, ['slug']), 'logs:read', (p, i) => projects.logs(p, i.slug, i.limit)),
        tool('get_analytics', 'Read how many people have visited a deployed site. Returns total page loads, distinct visitors, and API requests over the window, plus a per-day series. Two caveats worth passing on before quoting the numbers: only a navigation is counted, so a single-page app that routes on the client reports the load that started the session and not the screens after it; and an owner\'s own visits to their own network or showcase site are counted like anyone else\'s, because on those tiers the browser carries no platform cookie to tell them apart.', object({
            slug, days: {type: 'integer', minimum: 1, maximum: 30, default: 30},
        }, ['slug']), 'sites:read', (p, i) => projects.analytics(p, i.slug, i.days)),
        tool('render_version', 'Render an owner-only private preview and return a PNG plus browser diagnostics. The runtime is woken first, so a cold start does not fail the render. A {"status":"queued"} reply means it is still running: call again with the same arguments to collect the result. A {"status":"failed"} reply carries the page console output and errors.', object({
            slug, versionId: string(),
        }, ['slug', 'versionId']), 'sites:read', (p, i) => projects.renderVersion(p, i.slug, i.versionId)),
        tool('probe_version', 'Make one HTTP request to a version\'s private host and return the status, headers, and body. Deployed sites are reachable only on the internal network, so this is how you test /api endpoints. The runtime is woken first. You supply a path, never a host: the target is always the version you name.', object({
            slug,
            versionId: string(),
            path: string('Request path, starting with "/". Example: /api/tasks'),
            method: {type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET'},
            headers: {type: 'object', additionalProperties: {type: 'string'}, description: 'Extra request headers. Platform-controlled headers are refused.'},
            body: string('Request body, for methods that take one.'),
        }, ['slug', 'versionId', 'path']), 'sites:read',
        (p, i) => projects.probeVersion(p, i.slug, i.versionId, i)),
        tool('export_database', 'Export the project database. include="schema" returns the schema SQL inline, with no rows in it, and is what you want to inspect the database. include="all" returns a download URL for the full gzipped dump and never the data itself. Fetch the URL with the same bearer token; it carries no capability of its own.', object({
            slug,
            include: {type: 'string', enum: ['schema', 'all'], default: 'schema'},
        }, ['slug']), 'database:read', (p, i) => projects.exportDatabase(p, i.slug, i.include ?? 'schema')),
        tool('delete_project', 'Schedule a seven-day recoverable project deletion. Operators may set immediate to purge a project they own at once, with no recovery window.', object({
            slug,
            confirmation: string('Must exactly equal slug.'),
            immediate: {
                type: 'boolean',
                default: false,
                description: 'Purge now instead of after seven days. Operators only, on their own projects, and not recoverable.',
            },
        }, ['slug', 'confirmation']), 'sites:write', (p, i) => projects.delete(p, i.slug, i.confirmation, i.immediate === true)),
        tool('restore_project', 'Cancel a scheduled deletion during its seven-day recovery window.', object({
            slug,
        }, ['slug']), 'sites:write', (p, i) => projects.restore(p, i.slug)),
    ]
    return definitions
}

/** The argument names a tool declares, in the order the schema lists them. */
export function declaredArguments(tool: Pick<ToolDefinition, 'inputSchema'>): string[] {
    const properties = (tool.inputSchema as {properties?: Record<string, unknown>}).properties
    return properties ? Object.keys(properties) : []
}

/**
 * Argument names the tool does not declare. Keys beginning with `_` are left
 * alone: `_meta` and friends belong to the protocol, not to the tool.
 */
export function unknownArguments(tool: Pick<ToolDefinition, 'inputSchema'>, args: unknown): string[] {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return []
    const declared = new Set(declaredArguments(tool))
    return Object.keys(args).filter(key => !key.startsWith('_') && !declared.has(key))
}

function unknownArgumentMessage(tool: ToolDefinition, unknown: string[], schemaVersion: string): string {
    return `${tool.name} does not accept ${unknown.map(key => `"${key}"`).join(', ')}.`
        + ` It accepts: ${declaredArguments(tool).join(', ') || 'no arguments'} (tool schema ${schemaVersion}).`
        + ` Unknown arguments are refused rather than ignored, so nothing was done.`
        + ` If an argument you sent is missing from that list and you expected it to be there, your client is`
        + ` working from a tool schema it cached before this server changed: reconnect and call get_skill,`
        + ` which reports the schema being served now.`
}

/**
 * A fingerprint of the whole tool surface. It changes whenever a tool's name,
 * description, or arguments change — which is exactly when a client that cached
 * `tools/list` at connect time starts working from a schema this server no
 * longer serves. Derived rather than hand-maintained, so it cannot be forgotten
 * in the commit that changes a signature.
 */
export function toolSchemaVersion(tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>>): string {
    const surface = tools.map(({name, description, inputSchema}) => ({name, description, inputSchema}))
    return createHash('sha256').update(JSON.stringify(surface)).digest('hex').slice(0, 12)
}

function renderToolResult(name: unknown, output: unknown): {
    content: Array<Record<string, unknown>>
    structuredContent: unknown
} {
    if (name === 'render_version' && output && typeof output === 'object') {
        const {screenshotBase64, mimeType, ...metadata} = output as Record<string, unknown>
        if (typeof screenshotBase64 === 'string') {
            return {
                content: [
                    {type: 'image', data: screenshotBase64, mimeType: typeof mimeType === 'string' ? mimeType : 'image/png'},
                    {type: 'text', text: JSON.stringify(metadata, null, 2)},
                ],
                structuredContent: metadata,
            }
        }
    }
    return {
        content: [{type: 'text', text: JSON.stringify(output, null, 2)}],
        structuredContent: structuredContentFor(name, output),
    }
}

/** Tools whose handler returns a bare array, and the key to nest it under. */
const ARRAY_RESULT_KEYS: Record<string, string> = {
    list_projects: 'projects',
    list_showcase: 'projects',
    get_logs: 'logs',
}

/**
 * `structuredContent` must be a JSON object. Returning the handler's value
 * directly sent an array for the two tools that list things, which a client
 * validating the response rejects outright — `list_projects` failed for every
 * caller, empty result or not. Nest arrays under a named key and omit the field
 * entirely for anything else that is not an object, since it is optional.
 */
export function structuredContentFor(name: unknown, output: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(output)) {
        return {[(typeof name === 'string' && ARRAY_RESULT_KEYS[name]) || 'items']: output}
    }
    if (output && typeof output === 'object') return output as Record<string, unknown>
    return undefined
}

function tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    scope: Scope,
    run: ToolDefinition['run'],
): ToolDefinition {
    return {name, description, inputSchema, scope, run}
}

function rpcError(c: import('hono').Context, id: unknown, code: number, message: string) {
    return c.json({jsonrpc: '2.0', id: id ?? null, error: {code, message}})
}
