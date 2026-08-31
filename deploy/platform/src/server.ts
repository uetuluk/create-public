import {serve} from '@hono/node-server'
import {Hono} from 'hono'
import {cors} from 'hono/cors'
import {HTTPException} from 'hono/http-exception'
import {logger} from 'hono/logger'
import {secureHeaders} from 'hono/secure-headers'
import {readFile} from 'node:fs/promises'
import {Pool} from 'pg'
import {AdminService, AdminWriteService, syncOperators} from './lib/admin'
import {apiErrorHandler} from './lib/middleware'
import {Authenticator, TokenService} from './lib/authn'
import {clientIp} from './lib/client-ip'
import {SecretBox} from './lib/crypto'
import {LlmService} from './lib/llm'
import {MonitorService} from './lib/monitor'
import {parseOperatorProjectQuota, parseProjectQuotaDefault, ProjectService, SHOWCASE_EMBED_HOST_LABEL, parseMaxAccessMode} from './lib/projects'
import {Counters} from './lib/prometheus'
import {applySchema, ensureDatabase, PLATFORM_DB} from './lib/schema'
import {ShowcaseDescriptionModel} from './lib/showcase-description'
import {SiteReviewModel} from './lib/site-reviewer'
import {adminPageRoutes, adminRoutes} from './routes/admin'
import {authRoutes} from './routes/auth'
import {dashboardRoutes} from './routes/dashboard'
import {internalRoutes} from './routes/internal'
import {mcpRoutes} from './routes/mcp'
import {metricsRoutes} from './routes/metrics'
import {meRoutes} from './routes/me'
import {oauthMetadata, oauthRoutes} from './routes/oauth'
import {opsRoutes} from './routes/ops'
import {authPolicyFromEnv, signInHint} from './lib/allowed-domains'
import {deploymentFromEnv} from './lib/deployment'
import {projectRoutes} from './routes/projects'
import {showcaseRoutes} from './routes/showcase'
import {SHOWCASE_EMBED_PATH, showcaseEmbedRoutes} from './routes/showcase-embed'
import {staticRoutes} from './routes/static'
import {tokenRoutes} from './routes/tokens'

export interface PlatformServerOptions {
    adminDatabaseUrl?: string
    sessionSecret?: string
    gatewayDomain?: string
    publicBaseUrl?: string
    sourceRoot?: string
    showcaseRoot?: string
    port?: number
    hostname?: string
    env?: NodeJS.ProcessEnv
}

export interface StartedPlatform {
    port: number
    close(): Promise<void>
}

const counters = new Counters()

export async function startPlatform(opts: PlatformServerOptions = {}): Promise<StartedPlatform> {
    const env = opts.env ?? process.env
    const adminUrl = opts.adminDatabaseUrl ?? required(env, 'PLATFORM_ADMIN_DATABASE_URL')
    const sessionSecret = opts.sessionSecret ?? env.PLATFORM_SESSION_SECRET ?? env.PLATFORM_JWT_SECRET ?? required(env, 'PLATFORM_SESSION_SECRET')
    const encryptionSecret = required(env, 'SECRET_ENCRYPTION_KEY')
    validateIndependentSecrets(sessionSecret, encryptionSecret)
    const deployment = deploymentFromEnv(env, {gatewayDomain: opts.gatewayDomain, publicBaseUrl: opts.publicBaseUrl})
    const {domain, publicBaseUrl} = deployment
    const sourceRoot = opts.sourceRoot ?? env.SOURCE_ROOT ?? '/data/sources'
    const showcaseRoot = opts.showcaseRoot ?? env.SHOWCASE_ROOT ?? '/data/showcase'
    const port = opts.port ?? Number(env.PORT || 3000)
    // Read before anything connects: an unusable value should stop the start,
    // not the first registration after it.
    // Read before anything connects, like the quotas below: an installation
    // whose login admits nobody should fail to start, not fail per request.
    const authPolicy = authPolicyFromEnv(env)
    const maxAccessMode = parseMaxAccessMode(env.MAX_ACCESS_MODE)
    const defaultProjectQuota = parseProjectQuotaDefault(env.DEFAULT_PROJECT_QUOTA)
    const operatorProjectQuota = parseOperatorProjectQuota(env.OPERATOR_PROJECT_QUOTA)

    const adminPool = new Pool({connectionString: adminUrl})
    await ensureDatabase(adminPool)
    await adminPool.end()
    const pool = new Pool({connectionString: swapDatabase(adminUrl, PLATFORM_DB), max: 20})
    await applySchema(pool)
    const roles = await syncOperators(pool, env.PLATFORM_OPERATOR_EMAILS, env.PLATFORM_SUPERADMIN_EMAILS)
    if (roles.operators.length) console.log(`[auth] operator role granted to ${roles.operators.join(', ')}`)
    if (roles.superadmins.length) console.log(`[auth] superadmin role granted to ${roles.superadmins.join(', ')}`)
    // A deploy re-asserts these lists, so a role granted through /v1/admin on a
    // host that also names the tier in its environment does not survive the next
    // restart. Said once at start, where it can be acted on, rather than only in
    // the response to whoever made the change.
    if (roles.operators.length) {
        console.warn('[auth] PLATFORM_OPERATOR_EMAILS is set: operator grants made through /v1/admin'
            + ' are reverted on every start. Unset it to manage the operator tier through the API.')
    }

    const privateKeyPem = await readConfiguredSecret(env, 'OAUTH_PRIVATE_KEY_PEM', 'OAUTH_PRIVATE_KEY_FILE')
    const publicKeyPem = await readConfiguredSecret(env, 'OAUTH_PUBLIC_KEY_PEM', 'OAUTH_PUBLIC_KEY_FILE')
    if ((!privateKeyPem || !publicKeyPem) && env.ALLOW_EPHEMERAL_OAUTH_KEYS !== '1') {
        throw new Error('persistent OAUTH_PRIVATE_KEY_FILE and OAUTH_PUBLIC_KEY_FILE are required')
    }
    if (Boolean(privateKeyPem) !== Boolean(publicKeyPem)) {
        throw new Error('both OAuth private and public signing keys are required')
    }
    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together')
    }
    const tokens = new TokenService({
        issuer: publicBaseUrl,
        resource: `${publicBaseUrl}/mcp`,
        sessionSecret,
        privateKeyPem,
        publicKeyPem,
    })
    const authenticator = new Authenticator(pool, tokens)
    // Null when the deployment has no LLM_ADMIN_KEY: the platform still starts,
    // it just cannot offer the binding, and asking for it returns 503.
    const llm = LlmService.fromEnv(env, domain)
    const projects = new ProjectService(pool, domain, deployment.analyticsTimeZone, sourceRoot, new SecretBox(encryptionSecret), llm, showcaseRoot, operatorProjectQuota, maxAccessMode)
    // Same binding, its own key: site review is platform work, not any tenant's,
    // and it must never run on the credential that mints tenant keys.
    const siteReviewer = llm ? new SiteReviewModel(llm) : null
    if (!siteReviewer) {
        console.warn('[site-review] no LLM binding on this deployment; reviews will record the static verdict only')
    }
    // Its own key again, and for the same reason. A drafted description is
    // suggestion text for one owner; it must not be able to spend, or be
    // spent by, the credential a security review runs on.
    const showcaseDescriber = llm ? new ShowcaseDescriptionModel(llm) : null
    const admin = new AdminService(pool, domain, operatorProjectQuota)
    const adminWrites = new AdminWriteService(pool)
    const app = new Hono()

    app.use(clientIp({
        trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS ?? '',
        trustedCloudflareProxyCidrs: env.TRUSTED_CLOUDFLARE_PROXY_CIDRS,
    }))
    app.use(logger())
    const showcaseOrigin = `https://${SHOWCASE_EMBED_HOST_LABEL}.${domain}`
    app.use(secureHeaders({
        contentSecurityPolicy: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'https:', 'data:'],
            // The logged-out gallery is framed from the LAN-only host. Without
            // this it falls back to default-src and the frame is blocked, which
            // looks exactly like being off the network — the one failure mode
            // this feature must not have by accident.
            frameSrc: ["'self'", showcaseOrigin],
            // Set here rather than on the embed route so there is one policy
            // rather than two that can disagree. It keeps the gallery framed by
            // the dashboard alone, and stops every other page being framed at
            // all, which nothing here ever wanted.
            frameAncestors: [publicBaseUrl],
        },
        // Off, deliberately, and this is load-bearing. secureHeaders defaults
        // it to SAMEORIGIN, which has no way to name an allowed origin —
        // ALLOW-FROM is dead in every current browser — so it blocked the
        // dashboard from framing the gallery on showcase.<domain> even though
        // frame-ancestors above permits exactly that. The page loaded, returned
        // 200, and simply never appeared.
        //
        // frame-ancestors is the same control expressed precisely, and it is
        // set on every response here. What is given up is clickjacking
        // protection on browsers too old to implement CSP level 2, which is no
        // browser this platform is reachable from.
        xFrameOptions: false,
    }))
    app.use('/mcp/*', cors({
        origin: '*',
        allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'MCP-Session-Id'],
        exposeHeaders: ['MCP-Protocol-Version', 'MCP-Session-Id', 'WWW-Authenticate'],
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }))
    app.onError(apiErrorHandler)

    app.get('/healthz', async c => {
        await pool.query('SELECT 1')
        return c.json({ok: true, service: 'control-plane'})
    })
    app.route('/auth', authRoutes({
        pool,
        tokens,
        authPolicy,
        publicBaseUrl,
        googleClientId: env.GOOGLE_CLIENT_ID,
        googleClientSecret: env.GOOGLE_CLIENT_SECRET,
        devBypass: env.AUTH_DEV_BYPASS === '1',
        defaultProjectQuota,
    }))
    app.route('/oauth', oauthRoutes({pool, tokens, publicBaseUrl}))
    app.route('/.well-known', oauthMetadata({pool, tokens, publicBaseUrl}))
    app.route('/v1/projects', projectRoutes({projects, authenticator, tokens}))
    app.route('/v1/showcase', showcaseRoutes({projects, authenticator, tokens}))
    // Only mounted where the edge can actually reach it. Without EDGE_PROXY_SECRET
    // and NETWORK_CIDRS there is no way to tell an on-network visitor from
    // anyone else, and a surface that cannot make that distinction must not
    // exist rather than fall open.
    if (env.EDGE_PROXY_SECRET && env.NETWORK_CIDRS) {
        app.route(SHOWCASE_EMBED_PATH, showcaseEmbedRoutes({
            projects,
            edgeProxySecret: env.EDGE_PROXY_SECRET,
            networkCidrs: env.NETWORK_CIDRS,
            embedHost: `${SHOWCASE_EMBED_HOST_LABEL}.${domain}`,
        }))
    } else {
        console.warn('[showcase] no EDGE_PROXY_SECRET/NETWORK_CIDRS; the logged-out gallery is not served')
    }
    app.route('/v1/tokens', tokenRoutes({pool, authenticator, tokens}))
    app.route('/v1/me', meRoutes({authenticator, tokens}))
    app.route('/v1/ops', opsRoutes({pool, authenticator, tokens}))
    app.route('/internal', internalRoutes({
        sessionSecret, publicBaseUrl, reviewer: siteReviewer, describer: showcaseDescriber,
    }))
    app.route('/v1/admin', adminRoutes({
        pool, admin, writes: adminWrites, authenticator, tokens,
        operatorEmailsPinned: roles.operators.length > 0,
    }))
    app.route('/mcp', mcpRoutes({
        projects,
        authenticator,
        tokens,
        repoRoot: env.PLATFORM_REPO_ROOT,
        publicBaseUrl,
    }))
    app.route('/admin', adminPageRoutes({publicHost: new URL(publicBaseUrl).host}))
    app.route('/', dashboardRoutes({showcaseOrigin, publicBaseUrl, signInHint: signInHint(authPolicy)}))
    if (env.PLATFORM_REPO_ROOT) app.route('/', staticRoutes({repoRoot: env.PLATFORM_REPO_ROOT, publicBaseUrl}))

    const server = serve({fetch: app.fetch, port, hostname: opts.hostname ?? '0.0.0.0'})

    // Metrics live on their own listener, on a port no ingress names. See
    // routes/metrics.ts: the tunnel bypasses Caddy, so a path rule there cannot
    // keep anything private.
    const metricsToken = env.METRICS_TOKEN
    let metricsServer: ReturnType<typeof serve> | null = null
    if (env.MONITOR_METRICS_ENABLED !== '0') {
        if (!metricsToken && env.ALLOW_UNAUTHENTICATED_METRICS !== '1') {
            console.warn('[platform] METRICS_TOKEN is unset; the metrics listener will not start. ' +
                'Set it, or ALLOW_UNAUTHENTICATED_METRICS=1 to accept an unauthenticated private listener.')
        } else {
            const metricsPort = Number(env.METRICS_PORT ?? 9090)
            metricsServer = serve({
                fetch: metricsRoutes({
                    pool,
                    counters,
                    token: metricsToken,
                    allowedCidrs: (env.METRICS_ALLOWED_CIDRS ?? '').split(',').map(v => v.trim()).filter(Boolean),
                    snapshotPath: env.EXECUTOR_METRICS_FILE ?? '/data/metrics/executor.json',
                    dataRoot: env.DATA_ROOT ?? '/data',
                    perProject: env.METRICS_PER_PROJECT !== '0',
                }).fetch,
                port: metricsPort,
                hostname: opts.hostname ?? '0.0.0.0',
            })
            console.log(`[platform] metrics listening on ${metricsPort}`)
        }
    }

    // Evaluated here rather than in the executor: if it ran there, "the
    // executor is down" would be the one alert that could never fire.
    let monitor: MonitorService | null = null
    if (env.MONITOR_ENABLED !== '0') {
        monitor = new MonitorService({pool, env})
        monitor.start()
    }

    return {
        port,
        close: async () => {
            monitor?.stop()
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
            if (metricsServer) {
                await new Promise<void>(resolve => metricsServer!.close(() => resolve()))
            }
            await pool.end().catch(() => undefined)
        },
    }
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

async function readConfiguredSecret(env: NodeJS.ProcessEnv, valueKey: string, fileKey: string): Promise<string | undefined> {
    if (env[valueKey]) return env[valueKey]
    const path = env[fileKey]
    return path ? await readFile(path, 'utf8') : undefined
}

function validateIndependentSecrets(sessionSecret: string, encryptionSecret: string): void {
    if (Buffer.byteLength(sessionSecret) < 32 || Buffer.byteLength(encryptionSecret) < 32) {
        throw new Error('platform session and encryption secrets must each be at least 32 bytes')
    }
    if (sessionSecret === encryptionSecret) {
        throw new Error('SECRET_ENCRYPTION_KEY must be independent from PLATFORM_SESSION_SECRET')
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startPlatform().catch(error => {
        console.error(error)
        process.exit(1)
    })
}
