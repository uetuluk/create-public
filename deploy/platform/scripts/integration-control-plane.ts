import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {request as httpRequest} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import jwt from 'jsonwebtoken'
import {Pool} from 'pg'
import {Executor} from '../src/executor'
import {startGateway} from '../src/gateway'
import {startPlatform} from '../src/server'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')

const sourceRoot = await mkdtemp(join(tmpdir(), 'ritsdev-integration-'))
const port = Number(process.env.TEST_PORT ?? 43123)
const testSecret = (purpose: string) => createHash('sha256').update(`integration-only:${purpose}`).digest('hex')
const env = {
    ...process.env,
    AUTH_DEV_BYPASS: '1',
    ALLOW_EPHEMERAL_OAUTH_KEYS: '1',
    PLATFORM_ADMIN_DATABASE_URL: databaseUrl,
    PLATFORM_SESSION_SECRET: testSecret('session'),
    SECRET_ENCRYPTION_KEY: testSecret('encryption'),
    EDGE_PROXY_SECRET: testSecret('edge-proxy'),
    NETWORK_CIDRS: '127.0.0.0/8',
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    GATEWAY_DOMAIN: 'sites.example.test',
    SOURCE_ROOT: sourceRoot,
}

const server = await startPlatform({
    adminDatabaseUrl: databaseUrl,
    sessionSecret: env.PLATFORM_SESSION_SECRET,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    gatewayDomain: env.GATEWAY_DOMAIN,
    sourceRoot,
    port,
    hostname: '127.0.0.1',
    env,
})

try {
    const login = await fetch(`${env.PUBLIC_BASE_URL}/auth/dev`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({email: 'integration@example.edu', name: 'Integration User'}),
    })
    assert.equal(login.status, 200)
    const {access_token: token} = await login.json() as {access_token: string}
    const auth = {authorization: `Bearer ${token}`}
    const sessionCookie = login.headers.get('set-cookie')
    assert(sessionCookie)

    const me = await fetch(`${env.PUBLIC_BASE_URL}/v1/me`, {headers: auth})
    assert.equal(me.status, 200)
    assert.equal((await me.json() as {email: string}).email, 'integration@example.edu')

    const created = await fetch(`${env.PUBLIC_BASE_URL}/v1/projects`, {
        method: 'POST',
        headers: {...auth, 'content-type': 'application/json'},
        body: JSON.stringify({slug: 'integration-site', access: 'owner', postgres: true, storage: false}),
    })
    assert.equal(created.status, 202)
    assert.equal((await created.json() as {status: string}).status, 'provisioning')

    const executor = new Executor(env)
    assert.equal(await executor.runOnce(), true)
    await executor.close()

    const project = await fetch(`${env.PUBLIC_BASE_URL}/v1/projects/integration-site`, {headers: auth})
    const projectBody = await project.json() as {status: string; url: string}
    assert.equal(projectBody.status, 'ready')
    assert.equal(projectBody.url, 'https://integration-site.sites.example.test')

    const mcpInitialize = await fetch(`${env.PUBLIC_BASE_URL}/mcp`, {
        method: 'POST',
        headers: {...auth, 'content-type': 'application/json'},
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '1'}},
        }),
    })
    assert.equal(mcpInitialize.status, 200)
    assert.equal((await mcpInitialize.json() as any).result.serverInfo.name, 'sites.example.test')

    const mcpTools = await fetch(`${env.PUBLIC_BASE_URL}/mcp`, {
        method: 'POST',
        headers: {...auth, 'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}),
    })
    const toolNames = ((await mcpTools.json() as any).result.tools as Array<{name: string}>).map(tool => tool.name)
    assert(toolNames.includes('create_project'))
    assert(toolNames.includes('get_deployment'))
    assert(toolNames.includes('render_version'))

    const registration = await fetch(`${env.PUBLIC_BASE_URL}/oauth/register`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            client_name: 'Integration MCP client',
            redirect_uris: ['http://127.0.0.1/callback'],
            token_endpoint_auth_method: 'none',
        }),
    })
    assert.equal(registration.status, 201)
    const {client_id: clientId} = await registration.json() as {client_id: string}
    const verifier = 'integration-verifier-0123456789-abcdefghijklmnopqrstuvwxyz'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorizeUrl = new URL(`${env.PUBLIC_BASE_URL}/oauth/authorize`)
    authorizeUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: `${env.PUBLIC_BASE_URL}/mcp`,
        scope: 'sites:read',
    }).toString()
    const authorization = await fetch(authorizeUrl, {
        redirect: 'manual',
        headers: {cookie: sessionCookie},
    })
    assert.equal(authorization.status, 200)
    const consentHtml = await authorization.text()
    assert.match(consentHtml, /Authorize Integration MCP client/)
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(consentHtml)?.[1]
    assert(consentToken)
    const forgedConsent = await fetch(`${env.PUBLIC_BASE_URL}/oauth/authorize`, {
        method: 'POST',
        headers: {cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({consent_token: `${consentToken}forged`, decision: 'approve'}),
        redirect: 'manual',
    })
    assert.equal(forgedConsent.status, 400)
    const approval = await fetch(`${env.PUBLIC_BASE_URL}/oauth/authorize`, {
        method: 'POST',
        headers: {cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({consent_token: consentToken, decision: 'approve'}),
        redirect: 'manual',
    })
    assert.equal(approval.status, 302)
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')
    assert(code)

    const wrongCodeExchange = await oauthToken(env.PUBLIC_BASE_URL, {
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1/callback',
        code,
        code_verifier: `${verifier}wrong`,
    })
    assert.equal(wrongCodeExchange.status, 400)
    const codeExchange = await oauthToken(env.PUBLIC_BASE_URL, {
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1/callback',
        code,
        code_verifier: verifier,
    })
    assert.equal(codeExchange.status, 200)
    const oauthTokens = await codeExchange.json() as {access_token: string; refresh_token: string}
    assert(oauthTokens.access_token)
    assert(oauthTokens.refresh_token)
    const delegatedPat = await fetch(`${env.PUBLIC_BASE_URL}/v1/tokens`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${oauthTokens.access_token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({name: 'should-not-exist', scopes: ['sites:write']}),
    })
    assert.equal(delegatedPat.status, 403)

    const wrongRefreshExchange = await oauthToken(env.PUBLIC_BASE_URL, {
        grant_type: 'refresh_token',
        client_id: 'wrong-client',
        refresh_token: oauthTokens.refresh_token,
    })
    assert.equal(wrongRefreshExchange.status, 400)
    const refreshExchange = await oauthToken(env.PUBLIC_BASE_URL, {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: oauthTokens.refresh_token,
    })
    assert.equal(refreshExchange.status, 200)

    const admin = new Pool({connectionString: databaseUrl})
    try {
        const platform = new URL(databaseUrl)
        platform.pathname = '/_platform'
        const platformPool = new Pool({connectionString: platform.toString()})
        const migration = await platformPool.query(`SELECT name FROM schema_migrations WHERE version = 1`)
        assert.equal(migration.rows[0].name, 'sites-v2-audited-baseline')
        const row = await platformPool.query<{id: string; owner_id: string; database_name: string}>(
            `SELECT id, owner_id, database_name FROM projects WHERE slug = 'integration-site'`,
        )
        assert.match(row.rows[0].database_name, /^site_[a-f0-9]{32}$/)
        const database = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [row.rows[0].database_name])
        assert.equal(database.rowCount, 1)

        const artifactPath = join(sourceRoot, 'ready-artifact')
        await mkdir(join(artifactPath, 'static'), {recursive: true})
        await writeFile(join(artifactPath, 'static', 'index.html'), '<!doctype html><title>Integration preview</title>')
        const archivePath = join(sourceRoot, 'source.tar.gz')
        await writeFile(archivePath, 'fixture')
        const source = await platformPool.query<{id: string}>(
            `INSERT INTO source_revisions
             (project_id, sha256, archive_path, size_bytes, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [row.rows[0].id, 'a'.repeat(64), archivePath, 7, row.rows[0].owner_id],
        )
        const version = await platformPool.query<{id: string}>(
            `INSERT INTO versions
             (project_id, source_revision_id, status, manifest, artifact_path, artifact_bytes, created_by, finished_at)
             VALUES ($1,$2,'ready',$3,$4,$5,$6,now()) RETURNING id`,
            [
                row.rows[0].id,
                source.rows[0].id,
                JSON.stringify({
                    schemaVersion: 1,
                    build: {command: 'true', output: 'dist', spa: true},
                    resources: {postgres: false, storage: false},
                }),
                artifactPath,
                58,
                row.rows[0].owner_id,
            ],
        )

        const deploy = await fetch(`${env.PUBLIC_BASE_URL}/v1/projects/integration-site/deployments`, {
            method: 'POST',
            headers: {...auth, 'content-type': 'application/json', 'idempotency-key': 'integration-deploy'},
            body: JSON.stringify({versionId: version.rows[0].id}),
        })
        assert.equal(deploy.status, 201)
        const queuedDeployment = await deploy.json() as {id: string}
        const duplicateDeploy = await fetch(`${env.PUBLIC_BASE_URL}/v1/projects/integration-site/deployments`, {
            method: 'POST',
            headers: {...auth, 'content-type': 'application/json', 'idempotency-key': 'integration-deploy'},
            body: JSON.stringify({versionId: version.rows[0].id}),
        })
        assert.equal((await duplicateDeploy.json() as {id: string}).id, queuedDeployment.id)

        const deploymentExecutor = new Executor(env)
        assert.equal(await deploymentExecutor.runOnce(), true)
        await deploymentExecutor.close()
        const activeDeployment = await fetch(
            `${env.PUBLIC_BASE_URL}/v1/projects/integration-site/deployments/${queuedDeployment.id}`,
            {headers: auth},
        )
        assert.equal((await activeDeployment.json() as {status: string}).status, 'active')

        const gatewayPort = port + 1
        const gateway = await startGateway({...env, GATEWAY_PORT: String(gatewayPort)})
        try {
            await platformPool.query(`UPDATE projects SET access_mode = 'network' WHERE id = $1`, [row.rows[0].id])
            const productionHost = 'integration-site.sites.example.test'
            const directBypass = await gatewayRequest(gatewayPort, productionHost, {'x-forwarded-for': '127.0.0.1'})
            assert.equal(directBypass.status, 403)
            const offNetwork = await gatewayRequest(gatewayPort, productionHost, {
                    'x-ritsdev-edge-token': env.EDGE_PROXY_SECRET,
                    'x-forwarded-for': '8.8.8.8',
            })
            assert.equal(offNetwork.status, 403)
            const onNetwork = await gatewayRequest(gatewayPort, productionHost, {
                    'x-ritsdev-edge-token': env.EDGE_PROXY_SECRET,
                    'x-forwarded-for': '127.0.0.1',
            })
            assert.equal(onNetwork.status, 200)
            await platformPool.query(`UPDATE projects SET access_mode = 'owner' WHERE id = $1`, [row.rows[0].id])

            const previewHost = `integration-site--v-${version.rows[0].id.replace(/-/g, '').slice(0, 10)}.sites.example.test`
            const renderToken = jwt.sign({
                typ: 'render',
                host: previewHost,
                project: row.rows[0].id,
                version: version.rows[0].id,
            }, env.PLATFORM_SESSION_SECRET, {
                algorithm: 'HS256',
                issuer: env.PUBLIC_BASE_URL,
                audience: `${env.PUBLIC_BASE_URL}/internal/render`,
                expiresIn: '2m',
            })
            const rendered = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
                headers: {
                    'x-ritsdev-render-host': previewHost,
                    'x-ritsdev-render-token': renderToken,
                },
            })
            assert.equal(rendered.status, 200)
            assert.match(await rendered.text(), /Integration preview/)
            assert.equal(rendered.headers.get('x-ritsdev-version'), version.rows[0].id)
        } finally {
            await gateway.close()
        }

        const deletion = await fetch(`${env.PUBLIC_BASE_URL}/v1/projects/integration-site`, {
            method: 'DELETE',
            headers: {...auth, 'content-type': 'application/json'},
            body: JSON.stringify({confirmation: 'integration-site'}),
        })
        assert.equal(deletion.status, 202)
        const restoration = await fetch(`${env.PUBLIC_BASE_URL}/v1/projects/integration-site/restore`, {
            method: 'POST',
            headers: auth,
        })
        assert.equal(restoration.status, 200)
        assert.equal((await restoration.json() as {status: string}).status, 'ready')
        await platformPool.end()
    } finally {
        await admin.end()
    }
    console.log('integration control-plane test passed')
} finally {
    await server.close()
    await rm(sourceRoot, {recursive: true, force: true})
}

function oauthToken(baseUrl: string, values: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams(values),
    })
}

function gatewayRequest(port: number, host: string, headers: Record<string, string>): Promise<{status: number; body: string}> {
    return new Promise((resolveRequest, reject) => {
        const request = httpRequest({
            hostname: '127.0.0.1',
            port,
            path: '/',
            method: 'GET',
            headers: {host, ...headers},
        }, response => {
            const chunks: Buffer[] = []
            response.on('data', chunk => chunks.push(Buffer.from(chunk)))
            response.on('end', () => resolveRequest({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
            }))
        })
        request.on('error', reject)
        request.end()
    })
}
