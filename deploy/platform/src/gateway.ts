import {serve} from '@hono/node-server'
import {getConnInfo} from '@hono/node-server/conninfo'
import {Hono} from 'hono'
import {getCookie, setCookie} from 'hono/cookie'
import {logger} from 'hono/logger'
import {secureHeaders} from 'hono/secure-headers'
import jwt from 'jsonwebtoken'
import {timingSafeEqual} from 'node:crypto'
import {readFile, stat} from 'node:fs/promises'
import {isIP} from 'node:net'
import {networkAllowed, parseCidrList} from './lib/network-cidr'
// Re-exported so existing callers and tests keep importing them from here,
// while the control plane can take them without pulling in this module — see
// lib/network-cidr.ts for why that distinction matters.
export {networkAllowed, parseCidrList}
import {extname, resolve} from 'node:path'
import {Pool} from 'pg'
import {
    analyticsKey,
    API_REQUEST_RECORD_SQL,
    countableVisit,
    shouldRecord,
    visitDay,
    visitorHash,
    VISIT_RECORD_SQL,
} from './lib/analytics'
import {runtimeBudget} from './lib/budgets'
import {deploymentFromEnv} from './lib/deployment'
import {sha256} from './lib/crypto'
import {SecretBox} from './lib/crypto'
import type {SiteManifest} from './lib/manifest'
import {PLATFORM_DB} from './lib/schema'

type Site = {
    projectId: string
    ownerId: string
    slug: string
    access: 'owner' | 'network' | 'showcase'
    versionId: string
    artifactPath: string
    manifest: SiteManifest
    preview: boolean
    hostname: string
}

const SITE_COOKIE = '__Host-ritsdev_site'
const RENDER_AUDIENCE_PATH = '/internal/render'
export const RUNTIME_PROXY_HEADER = 'x-ritsdev-runtime-token'

export async function startGateway(env: NodeJS.ProcessEnv = process.env) {
    const adminUrl = required(env, 'PLATFORM_ADMIN_DATABASE_URL')
    const {domain, publicBaseUrl, analyticsTimeZone} = deploymentFromEnv(env)
    const sessionSecret = env.PLATFORM_SESSION_SECRET ?? env.PLATFORM_JWT_SECRET ?? required(env, 'PLATFORM_SESSION_SECRET')
    const edgeProxySecret = required(env, 'EDGE_PROXY_SECRET')
    const encryptionSecret = required(env, 'SECRET_ENCRYPTION_KEY')
    if ([sessionSecret, edgeProxySecret, encryptionSecret].some(value => Buffer.byteLength(value) < 32)) {
        throw new Error('gateway session, encryption, and edge proxy secrets must each be at least 32 bytes')
    }
    if (new Set([sessionSecret, edgeProxySecret, encryptionSecret]).size !== 3) {
        throw new Error('gateway session, encryption, and edge proxy secrets must be independent')
    }
    const allowedNetworks = parseCidrList(required(env, 'NETWORK_CIDRS'), 'NETWORK_CIDRS')
    // The gateway joins every per-project bridge so it can proxy functions,
    // which also makes it directly dialable by every tenant runtime. Same-bridge
    // traffic never traverses the host DOCKER-USER policy, so the gateway has to
    // refuse runtime-pool peers itself.
    const runtimePool = parseCidrList(
        env.RUNTIME_NETWORK_POOL ?? '192.168.68.0/22',
        'RUNTIME_NETWORK_POOL',
    )
    const secretBox = new SecretBox(encryptionSecret)
    // Derived once, under its own label, so the value written into the visitor
    // table is never the content-encryption key SecretBox uses. See
    // lib/analytics.ts.
    const visitorKey = analyticsKey(encryptionSecret)
    const pool = new Pool({connectionString: swapDatabase(adminUrl, PLATFORM_DB), max: 20})
    const app = new Hono()

    app.use(logger())
    app.use(secureHeaders({crossOriginResourcePolicy: false}))
    app.use(async (c, next) => {
        const peer = normalizeAddress(getConnInfo(c).remote.address ?? '')
        if (peer && networkAllowed(runtimePool, peer)) {
            return c.text('Forbidden.', 403)
        }
        await next()
    })

    app.get('/healthz', c => c.json({ok: true, service: 'site-gateway'}))
    app.all('*', async c => {
        const internalRender = renderClaims(c.req.raw.headers, sessionSecret, publicBaseUrl)
        const edgeAuthorized = safeEqual(c.req.header('x-ritsdev-edge-token'), edgeProxySecret)
        if (!internalRender && !edgeAuthorized) return c.text('Requests must pass through the site edge.', 403)
        const host = internalRender?.host ?? (c.req.header('host') ?? '').toLowerCase().split(':')[0]
        const site = await resolveSite(pool, host, domain)
        if (!site) return c.text('Site or deployed version not found.', 404)
        const renderAuthorized = internalRender?.project === site.projectId
            && internalRender.version === site.versionId
        const networkAuthorized = edgeAuthorized
            && networkAllowed(allowedNetworks, clientAddress(c.req.header('x-forwarded-for')))

        if (c.req.path === '/__auth/callback') {
            const ticket = c.req.query('ticket')
            if (!ticket) return c.text('Missing login ticket.', 400)
            const consumed = await pool.query<{account_id: string; return_path: string; owner_id: string}>(
                `UPDATE site_login_tickets t
                 SET consumed_at = now()
                 FROM projects p
                 WHERE t.ticket_hash = $1 AND t.project_id = $2
                   AND t.project_id = p.id AND t.consumed_at IS NULL AND t.expires_at > now()
                 RETURNING t.account_id, t.return_path, p.owner_id`,
                [sha256(ticket), site.projectId],
            )
            const row = consumed.rows[0]
            if (!row || row.account_id !== row.owner_id) return c.text('Invalid or expired login ticket.', 403)
            const token = jwt.sign({typ: 'site', project: site.projectId}, sessionSecret, {
                algorithm: 'HS256',
                issuer: publicBaseUrl,
                audience: `site:${site.projectId}`,
                subject: row.account_id,
                expiresIn: '8h',
            })
            setCookie(c, SITE_COOKIE, token, {
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
                path: '/',
                maxAge: 8 * 60 * 60,
            })
            return c.redirect(row.return_path)
        }

        const ownerOnly = requiresOwnerSession(site)
        // Asked once and reused below, rather than once here and again for the
        // visit counter. It is cheap for the requests that carry no cookie,
        // which on a network or showcase site is all of them, but the verify
        // itself is not free and there is no reason to do it twice.
        const ownerSession = validSiteSession(c, sessionSecret, publicBaseUrl, site)
        if (ownerOnly && !renderAuthorized && !ownerSession) {
            const returnPath = `${c.req.path}${new URL(c.req.url).search}`
            return c.redirect(`${publicBaseUrl}/auth/site?host=${encodeURIComponent(host)}&return=${encodeURIComponent(returnPath)}`)
        }
        if (!ownerOnly && !renderAuthorized && !networkAuthorized) {
            return c.text('This site is only available from the configured network.', 403)
        }
        // Built after the access decision above, so a request that was refused
        // never reaches it.
        //
        // `ownerSession` is worth being honest about: the site cookie is only
        // ever minted for an owner-only site, so an owner browsing their own
        // network or showcase site carries nothing to recognise them by and is
        // counted like any other visitor. This filters the case it can.
        const visits = visitRecorder(pool, analyticsTimeZone, visitorKey, c, site, {
            internalRender: Boolean(internalRender),
            ownerSession,
        })
        if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
            return await proxyFunction(c, pool, secretBox, site, visits)
        }
        return await serveStatic(c, site, visits)
    })

    const port = Number(env.GATEWAY_PORT ?? 3001)
    const server = serve({fetch: app.fetch, port, hostname: '0.0.0.0'})
    return {
        port,
        close: async () => {
            await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
            await pool.end()
        },
    }
}

async function resolveSite(pool: Pool, host: string, domain: string): Promise<Site | null> {
    if (!host.endsWith(`.${domain}`)) return null
    const label = host.slice(0, -(domain.length + 1))
    const previewMatch = /^([a-z][a-z0-9-]{2,39})--v-([a-f0-9]{10})$/.exec(label)
    const slug = previewMatch?.[1] ?? label
    if (!/^[a-z][a-z0-9-]{2,39}$/.test(slug)) return null
    const result = previewMatch
        ? await pool.query<SiteRow>(
            `SELECT p.id AS project_id, p.owner_id, p.slug, p.access_mode,
                    v.id AS version_id, v.artifact_path, v.manifest
             FROM projects p JOIN versions v ON v.project_id = p.id
             WHERE p.slug = $1 AND replace(v.id::text, '-', '') LIKE $2
               AND v.status = 'ready' AND p.status <> 'deleted'`,
            [slug, `${previewMatch[2]}%`],
        )
        : await pool.query<SiteRow>(
            `SELECT p.id AS project_id, p.owner_id, p.slug, p.access_mode,
                    v.id AS version_id, v.artifact_path, v.manifest
             FROM projects p JOIN versions v ON v.id = p.current_version_id
             WHERE p.slug = $1 AND p.status <> 'deleted'`,
            [slug],
        )
    if (result.rowCount !== 1) return null
    const row = result.rows[0]
    return {
        projectId: row.project_id,
        ownerId: row.owner_id,
        slug: row.slug,
        access: row.access_mode,
        versionId: row.version_id,
        artifactPath: row.artifact_path,
        manifest: row.manifest,
        preview: Boolean(previewMatch),
        hostname: host,
    }
}

type SiteRow = {
    project_id: string
    owner_id: string
    slug: string
    access_mode: 'owner' | 'network' | 'showcase'
    version_id: string
    artifact_path: string
    manifest: SiteManifest
}

function validSiteSession(c: import('hono').Context, secret: string, issuer: string, site: Site): boolean {
    const token = getCookie(c, SITE_COOKIE)
    if (!token) return false
    try {
        const claims = jwt.verify(token, secret, {
            algorithms: ['HS256'],
            issuer,
            audience: `site:${site.projectId}`,
        }) as jwt.JwtPayload
        return claims.typ === 'site' && claims.project === site.projectId && claims.sub === site.ownerId
    } catch {
        return false
    }
}

function renderClaims(headers: Headers, secret: string, issuer: string): {
    host: string
    project: string
    version: string
} | null {
    const token = headers.get('x-ritsdev-render-token')
    const host = headers.get('x-ritsdev-render-host')?.toLowerCase().split(':')[0]
    if (!token || !host) return null
    try {
        const claims = jwt.verify(token, secret, {
            algorithms: ['HS256'],
            issuer,
            audience: `${issuer}${RENDER_AUDIENCE_PATH}`,
        }) as jwt.JwtPayload
        if (claims.typ !== 'render' || claims.host !== host
            || typeof claims.project !== 'string' || typeof claims.version !== 'string') {
            return null
        }
        return {host, project: claims.project, version: claims.version}
    } catch {
        return null
    }
}

async function serveStatic(c: import('hono').Context, site: Site, visits: VisitRecorder): Promise<Response> {
    if (!site.manifest.build) return c.text('This project has no static frontend.', 404)
    const root = resolve(site.artifactPath, 'static')
    let requested: string
    try {
        requested = decodeURIComponent(c.req.path)
    } catch {
        return c.text('Malformed URL path.', 400)
    }
    let path = safeStaticPath(root, requested === '/' ? '/index.html' : requested)
    if (!path) return c.text('Not found.', 404)
    if (!await isFile(path) && site.manifest.build.spa) path = safeStaticPath(root, '/index.html')
    if (!path || !await isFile(path)) return c.text('Not found.', 404)
    const body = await readFile(path)
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const html = type.startsWith('text/html')
    // Counted here, where the content type is known, and deliberately not
    // awaited: the bytes and the timing of this response are both unchanged.
    visits.page(type, 200)
    return new Response(body, {
        headers: {
            'content-type': type,
            'cache-control': html ? 'no-cache' : 'public, max-age=3600',
            'x-ritsdev-version': site.versionId,
        },
    })
}

type RuntimeRow = {
    state: string
    endpoint: string | null
    proxy_secret_enc: string | null
    error_message?: string | null
}

const RUNTIME_STATE_SQL =
    `SELECT state, endpoint, proxy_secret_enc, error_message
     FROM project_runtime WHERE project_id = $1 AND version_id = $2`

async function readRuntime(pool: Pool, site: Site): Promise<RuntimeRow | undefined> {
    const result = await pool.query<RuntimeRow>(RUNTIME_STATE_SQL, [site.projectId, site.versionId])
    return result.rows[0]
}

async function proxyFunction(
    c: import('hono').Context,
    pool: Pool,
    secretBox: SecretBox,
    site: Site,
    visits: VisitRecorder,
): Promise<Response> {
    if (!site.manifest.functions) return c.text('This project has no functions.', 404)
    let runtime = await readRuntime(pool, site)
    if (runtime?.state !== 'running' || !runtime.endpoint) {
        runtime = await wakeRuntime(pool, site)
        if (runtime?.state === 'failed') return coldStartFailure(c, site, runtime)
    }
    const incoming = new URL(c.req.url)
    const path = `${incoming.pathname}${incoming.search}`
    // A request body can only be read once, so only a bodyless request can be
    // replayed against a runtime healed mid-request. Everything else still
    // corrects the row; it just reports this failure and leaves the cold start
    // to the next request.
    const replayable = ['GET', 'HEAD'].includes(c.req.method)
    // Runs at most twice: the only `continue` below is guarded on the first pass.
    for (let attempt = 0; ; attempt++) {
        const endpoint = runtime?.endpoint
        const proxySecret = runtime?.proxy_secret_enc
        if (!endpoint || !proxySecret) return c.text('Function cold start timed out.', 504)
        const target = new URL(path, endpoint)
        try {
            const headers = prepareRuntimeProxyHeaders(c.req.raw.headers, {
                hostname: site.hostname,
                projectId: site.projectId,
                proxySecret: secretBox.decrypt(proxySecret),
            })
            const response = await fetch(target, {
                method: c.req.method,
                headers,
                body: replayable ? undefined : c.req.raw.body,
                redirect: 'manual',
                duplex: 'half',
                signal: AbortSignal.timeout(60_000),
            } as RequestInit)
            // Only a hop that reached the runtime counts as traffic. Marking
            // before the fetch meant a request to a runtime whose container was
            // gone reset the very clock the idle sweep keys off, so the row
            // stayed `running` for ever and visiting the site was what kept it
            // from ever cold-starting again.
            await pool.query(
                `UPDATE project_runtime SET last_seen_at = now() WHERE project_id = $1 AND version_id = $2`,
                [site.projectId, site.versionId],
            )
            // Same rule as the line above: only a hop that reached the runtime
            // counts. A request that never got there is not traffic the project
            // served.
            visits.api()
            const outgoing = new Headers(response.headers)
            outgoing.delete('connection')
            outgoing.delete('transfer-encoding')
            outgoing.set('x-ritsdev-version', site.versionId)
            return new Response(response.body, {status: response.status, headers: outgoing})
        } catch (error) {
            if (isUpstreamUnreachable(error)) {
                // The row claimed `running` and nothing answered, so the row is
                // what is wrong. Clearing it is the only thing that lets a cold
                // start happen at all.
                await markRuntimeGone(pool, site)
                if (attempt === 0 && replayable) {
                    runtime = await wakeRuntime(pool, site)
                    if (runtime?.state === 'failed') return coldStartFailure(c, site, runtime)
                    if (runtime?.state === 'running' && runtime.endpoint) continue
                }
            }
            // The internal runtime host and port must not reach the client, so the
            // detail stays in the gateway log where an operator can read it.
            logRuntimeFailure(site, `proxy ${c.req.method} ${target.host}${target.pathname}`, describeError(error))
            return c.text('Function proxy error.', 502)
        }
    }
}

function coldStartFailure(c: import('hono').Context, site: Site, runtime: RuntimeRow): Response {
    logRuntimeFailure(site, 'cold start failed', runtime.error_message)
    return c.text('Function failed to start.', 502)
}

/**
 * Queues a cold start and waits for the executor to finish it.
 *
 * Returns whatever the row settled on: `running` with an endpoint on success,
 * `failed` when the start failed, and whatever the last poll saw when the budget
 * ran out — which the caller reports as a timeout.
 */
async function wakeRuntime(pool: Pool, site: Site): Promise<RuntimeRow | undefined> {
    // A `failed` row outlives the attempt that set it: only startRuntime clears
    // it, and the poll below treats `failed` as terminal. Left in place, the
    // first poll reads the *previous* attempt's verdict a few hundred
    // milliseconds after this enqueue — long before the executor has claimed the
    // job — so every later visit returned 502 at once instead of waiting for the
    // start it had just asked for. Clearing before the enqueue rather than after
    // means anything read as `failed` below can only be this attempt's.
    await pool.query(
        `UPDATE project_runtime SET state = 'stopped'
         WHERE project_id = $1 AND version_id = $2 AND state = 'failed'`,
        [site.projectId, site.versionId],
    )
    await enqueueRuntimeStart(pool, site.projectId, site.versionId)
    // Must outlast the executor's own health wait, or a start that uses its
    // full budget is reported here as a timeout while it is still working.
    // budgets.ts asserts that relationship.
    const budget = runtimeBudget()
    const deadline = Date.now() + budget.gatewayColdStartMs
    let runtime = await readRuntime(pool, site)
    while (Date.now() < deadline) {
        await sleep(budget.gatewayPollMs)
        runtime = await readRuntime(pool, site)
        if (runtime?.state === 'running' && runtime.endpoint) return runtime
        if (runtime?.state === 'failed') return runtime
    }
    return runtime
}

/**
 * Records that the runtime this row describes is not there any more.
 *
 * `project_runtime` holds what the platform believes about Docker, and nothing
 * reconciles it: runtimes run with `--restart no`, so a host reboot, a daemon
 * restart, or an OOM kill leaves the row reading `running` with an endpoint that
 * resolves to nothing. The wake gate keys off `state`, so such a row is a
 * permanent trap — the cold-start path is never entered and every request 502s.
 *
 * The `state = 'running'` guard keeps this from clobbering a start that a
 * concurrent executor has already moved on to `starting`.
 */
async function markRuntimeGone(pool: Pool, site: Site): Promise<void> {
    await pool.query(
        `UPDATE project_runtime SET state = 'stopped', endpoint = NULL, proxy_secret_enc = NULL
         WHERE project_id = $1 AND version_id = $2 AND state = 'running'`,
        [site.projectId, site.versionId],
    )
}

/**
 * True when the runtime was never reached at all, rather than reached and
 * unhappy.
 *
 * Only this class of failure justifies distrusting `project_runtime`. A read
 * timeout, an HTTP error, or anything the function itself raised means a
 * container answered, and the row is right.
 */
/**
 * Whether a request for this site must carry the owner's own site session.
 *
 * Extracted so it can be asserted, because it is the single decision that
 * decides who may load a deployed page and it grew a third input when the
 * showcase tier was added. Written as "not owner" rather than as a list of the
 * modes that are network-reachable: a tier added above `showcase` later
 * inherits the right answer, where a list would silently make every site under
 * it either owner-only or, worse, exempt from the network check below it.
 *
 * Previews are always owner-only regardless of the project's access mode. A
 * version that has not been deployed is not something its author has published
 * to anyone.
 */
export function requiresOwnerSession(site: {preview: boolean; access: string}): boolean {
    return site.preview || site.access === 'owner'
}

export function isUpstreamUnreachable(error: unknown): boolean {
    // Undici reports the actionable code on a cause several levels down, which
    // is the same chain describeError walks.
    for (let node: unknown = error, depth = 0; node && depth < 5; depth++) {
        const next = node as {code?: string; cause?: unknown}
        if (next.code && UNREACHABLE_CODES.has(next.code)) return true
        node = next.cause
    }
    return false
}

const UNREACHABLE_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    // Docker DNS answers with this for a container name that no longer exists.
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
])

function logRuntimeFailure(site: Site, stage: string, detail: string | null | undefined): void {
    console.error(`[gateway] runtime ${stage} project=${site.projectId} version=${site.versionId}: ${detail || 'no detail'}`)
}

export function describeError(error: unknown): string {
    const parts: string[] = []
    const top = error as {name?: string; message?: string; code?: string; cause?: unknown}
    parts.push(`${top?.name ?? 'Error'}: ${top?.message ?? String(error)}`)
    if (top?.code) parts.push(`code=${top.code}`)
    // Undici reports the actionable failure (ECONNREFUSED, EAI_AGAIN, invalid
    // header names, UND_ERR_*) on the cause rather than the thrown error.
    for (let cause = top?.cause, depth = 0; cause && depth < 4; depth++) {
        const next = cause as {name?: string; message?: string; code?: string; cause?: unknown}
        parts.push(`cause=${next.name ?? 'Error'}: ${next.message ?? String(cause)}${next.code ? ` (${next.code})` : ''}`)
        cause = next.cause
    }
    return parts.join(' | ')
}

type RuntimeJobStore = {
    query(text: string, values?: unknown[]): Promise<unknown>
}

/**
 * Queues a cold start under one stable key, reviving a terminal job in place.
 *
 * `attempts` has to be reset with the rest. The key is reused for the whole life
 * of a version, the claim increments `attempts` on every wake, and the executor
 * only retries a `start_runtime` while `attempts < 2` — so without this reset a
 * project lost its retries entirely from its third cold start onwards, and one
 * transient Docker failure became permanent. `enqueueRerunnable` in
 * lib/projects.ts resets the same set of columns for the same reason.
 */
export async function enqueueRuntimeStart(
    pool: RuntimeJobStore,
    projectId: string,
    versionId: string,
): Promise<void> {
    const idempotencyKey = `start:${projectId}:${versionId}`
    await pool.query(
        `INSERT INTO jobs (kind, project_id, version_id, idempotency_key)
         VALUES ('start_runtime',$1,$2,$3)
         ON CONFLICT (idempotency_key) DO UPDATE
         SET status = 'queued', run_after = now(), attempts = 0,
             locked_at = NULL, locked_by = NULL,
             finished_at = NULL, error_message = NULL
         WHERE jobs.status IN ('succeeded', 'failed')`,
        [projectId, versionId, idempotencyKey],
    )
}

// Connection-scoped headers must not be forwarded to the runtime. Beyond the
// RFC 9110 requirement, Node's fetch client rejects the whole request when it
// sees transfer-encoding, keep-alive, upgrade, or expect.
const HOP_BY_HOP_HEADERS = [
    'connection',
    'keep-alive',
    'proxy-connection',
    'proxy-authenticate',
    'proxy-authorization',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer',
    'expect',
]

export function prepareRuntimeProxyHeaders(
    incoming: Headers,
    runtime: {hostname: string; projectId: string; proxySecret: string},
): Headers {
    const headers = new Headers(incoming)
    for (const named of (headers.get('connection') ?? '').split(',')) {
        const name = named.trim().toLowerCase()
        if (name) headers.delete(name)
    }
    for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)
    headers.delete('host')
    headers.delete('content-length')
    headers.delete('x-ritsdev-render-host')
    headers.delete('x-ritsdev-render-token')
    headers.delete('x-ritsdev-edge-token')
    headers.delete(RUNTIME_PROXY_HEADER)
    headers.set('x-forwarded-host', runtime.hostname)
    headers.set('x-ritsdev-project', runtime.projectId)
    headers.set(RUNTIME_PROXY_HEADER, runtime.proxySecret)
    const cookie = headers.get('cookie')
    if (cookie) {
        const filtered = cookie.split(';').filter(value => !value.trim().startsWith(`${SITE_COOKIE}=`)).join('; ')
        if (filtered) headers.set('cookie', filtered)
        else headers.delete('cookie')
    }
    return headers
}

/**
 * Records a visit without making the response wait for it.
 *
 * Everything here is fire-and-forget on purpose. The requirement this feature
 * was built under is that nothing changes on the HTML side, and awaiting a
 * control-database round trip on every page load would honour the letter of
 * that while breaking its spirit — the bytes identical, the page slower. So the
 * write is never awaited, never throws into the request path, and is skipped
 * outright whenever a connection is already being queued for.
 *
 * A tenant cannot inflate its own numbers through this. The gateway refuses any
 * peer inside `RUNTIME_NETWORK_POOL` before routing, so a runtime cannot loop
 * back through it to call itself. That check is the only reason these counts
 * mean anything.
 */
type VisitRecorder = {
    /** A static response, with the content type that decides whether it counts. */
    page(contentType: string, status: number): void
    /** A function call that reached the runtime. */
    api(): void
}

function visitRecorder(
    pool: Pool,
    analyticsTimeZone: string,
    visitorKey: Buffer,
    c: import('hono').Context,
    site: Site,
    excluded: {internalRender: boolean; ownerSession: boolean},
): VisitRecorder {
    const signals = {
        method: c.req.method,
        secFetchDest: c.req.header('sec-fetch-dest'),
        secPurpose: c.req.header('sec-purpose'),
        purpose: c.req.header('purpose'),
        xMoz: c.req.header('x-moz'),
        accept: c.req.header('accept'),
        preview: site.preview,
        internalRender: excluded.internalRender,
        ownerSession: excluded.ownerSession,
    }
    const write = (sql: string): void => {
        if (!shouldRecord(pool)) return
        const address = clientAddress(c.req.header('x-forwarded-for'))
        const hash = visitorHash(visitorKey, site.projectId, address, c.req.header('user-agent') ?? '')
        // The view counter is a read-modify-write and so is not idempotent;
        // it is never retried, because losing a count is better than inventing
        // one.
        void pool.query(sql, [site.projectId, visitDay(new Date(), analyticsTimeZone), hash]).catch(reportVisitFailure)
    }
    return {
        page: (contentType, status) => {
            if (countableVisit({...signals, contentType, status})) write(VISIT_RECORD_SQL)
        },
        api: () => {
            if (signals.preview || signals.internalRender || signals.ownerSession) return
            write(API_REQUEST_RECORD_SQL)
        },
    }
}

/**
 * Analytics must never be able to fill the log either. A control database that
 * has gone away would otherwise produce one line per request, on the process
 * whose stdout is capped at 10 MB.
 */
let lastVisitFailureAt = 0

function reportVisitFailure(error: unknown): void {
    const now = Date.now()
    if (now - lastVisitFailureAt < 60_000) return
    lastVisitFailureAt = now
    console.error(`[gateway] could not record a site visit: ${describeError(error)}`)
}

function safeStaticPath(root: string, requestPath: string): string | null {
    const target = resolve(root, `.${requestPath}`)
    return target.startsWith(root + '/') ? target : null
}

async function isFile(path: string): Promise<boolean> {
    try { return (await stat(path)).isFile() } catch { return false }
}

function swapDatabase(url: string, database: string): string {
    const parsed = new URL(url)
    parsed.pathname = `/${database}`
    return parsed.toString()
}

function required(env: NodeJS.ProcessEnv, key: string): string {
    const value = env[key]
    if (!value) throw new Error(`missing required env: ${key}`)
    return value
}

function safeEqual(value: string | undefined, expected: string): boolean {
    if (!value) return false
    const left = Buffer.from(value)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
}



function normalizeAddress(raw: string): string {
    let address = raw.trim()
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
    if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7)
    return address
}

function clientAddress(forwarded: string | undefined): string {
    return normalizeAddress(forwarded?.split(',')[0] ?? '')
}



function sleep(ms: number): Promise<void> {
    return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
    '.wasm': 'application/wasm',
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startGateway().catch(error => {
        console.error(error)
        process.exit(1)
    })
}
