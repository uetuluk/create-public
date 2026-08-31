import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Hono} from 'hono'
import type {Pool} from 'pg'
import type {Authenticator, Principal} from './authn'
import {TokenService} from './authn'
import {sha256} from './crypto'
import {oauthRoutes} from '../routes/oauth'
import {tokenRoutes} from '../routes/tokens'

const ISSUER = 'https://sites.example.test'
const ACCOUNT_ID = '870e4621-b01e-4a38-b040-e3872efbbc06'
const SESSION_SECRET = 'test-session-secret-that-is-long-enough'

test('OAuth authorization requires explicit, account-bound, one-time consent', async () => {
    const database = new ConsentDatabase()
    const tokens = new TokenService({
        issuer: ISSUER,
        resource: `${ISSUER}/mcp`,
        sessionSecret: SESSION_SECRET,
    })
    const app = new Hono()
    app.route('/oauth', oauthRoutes({
        pool: database as unknown as Pool,
        tokens,
        publicBaseUrl: ISSUER,
    }))

    const session = tokens.signSession(account(ACCOUNT_ID))
    const authorization = await app.request(authorizationUrl(), {
        headers: {cookie: `__Host-ritsdev_session=${session}`},
    })
    assert.equal(authorization.status, 200)
    assert.equal(authorization.headers.get('cache-control'), 'no-store')
    assert.equal(database.authorizationCodes.length, 0, 'GET must not authorize automatically')

    const html = await authorization.text()
    assert.match(html, /Authorize &lt;script&gt;untrusted client&lt;\/script&gt;\?/)
    assert.doesNotMatch(html, /<script>untrusted client<\/script>/)
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(html)?.[1]
    assert(consentToken)
    assert.equal(database.consent?.request_hash, sha256(consentToken))

    const crossOrigin = await consent(app, session, consentToken, 'approve', {
        origin: 'https://attacker.sites.example.test',
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal(database.consent?.consumed_at, null)

    const otherSession = tokens.signSession(account('12892a48-f468-43ab-a6f1-7592590ce335'))
    const wrongAccount = await consent(app, otherSession, consentToken, 'approve')
    assert.equal(wrongAccount.status, 400)
    assert.equal(database.consent?.consumed_at, null)

    const approval = await consent(app, session, consentToken, 'approve')
    assert.equal(approval.status, 302)
    assert.equal(approval.headers.get('cache-control'), 'no-store')
    const redirect = new URL(approval.headers.get('location')!)
    assert.equal(redirect.origin, 'http://127.0.0.1')
    assert.equal(redirect.searchParams.get('state'), 'client-state')
    assert(redirect.searchParams.get('code'))
    assert.equal(database.authorizationCodes.length, 1)

    const replay = await consent(app, session, consentToken, 'approve')
    assert.equal(replay.status, 400)
    assert.equal(database.authorizationCodes.length, 1)
})

test('denying OAuth consent returns access_denied without issuing a code', async () => {
    const database = new ConsentDatabase()
    const tokens = new TokenService({
        issuer: ISSUER,
        resource: `${ISSUER}/mcp`,
        sessionSecret: SESSION_SECRET,
    })
    const app = new Hono()
    app.route('/oauth', oauthRoutes({
        pool: database as unknown as Pool,
        tokens,
        publicBaseUrl: ISSUER,
    }))
    const session = tokens.signSession(account(ACCOUNT_ID))
    const authorization = await app.request(authorizationUrl(), {
        headers: {cookie: `__Host-ritsdev_session=${session}`},
    })
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(await authorization.text())?.[1]
    assert(consentToken)

    const denial = await consent(app, session, consentToken, 'deny')
    assert.equal(denial.status, 302)
    const redirect = new URL(denial.headers.get('location')!)
    assert.equal(redirect.searchParams.get('error'), 'access_denied')
    assert.equal(redirect.searchParams.get('state'), 'client-state')
    assert.equal(redirect.searchParams.get('code'), null)
    assert.equal(database.authorizationCodes.length, 0)
})

test('scoped OAuth and personal bearer tokens cannot mint personal access tokens', async () => {
    const tokens = new TokenService({
        issuer: ISSUER,
        resource: `${ISSUER}/mcp`,
        sessionSecret: SESSION_SECRET,
    })
    let principal: Principal = bearerPrincipal('oauth')
    let databaseQueries = 0
    const pool = {
        query: async () => {
            databaseQueries += 1
            throw new Error('bearer denial must happen before token persistence')
        },
    } as unknown as Pool
    const authenticator = {
        bearer: async () => principal,
    } as unknown as Authenticator
    const app = new Hono()
    app.route('/v1/tokens', tokenRoutes({pool, authenticator, tokens}))

    for (const kind of ['oauth', 'pat'] as const) {
        principal = bearerPrincipal(kind)
        const response = await app.request('/v1/tokens', {
            method: 'POST',
            headers: {
                authorization: 'Bearer delegated-token',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                name: 'scope escalation',
                scopes: ['sites:read', 'sites:write', 'deployments:write', 'logs:read'],
            }),
        })
        assert.equal(response.status, 403, kind)
        assert.match(await response.text(), /interactive dashboard session/)
    }
    assert.equal(databaseQueries, 0)
})

test('an interactive dashboard session can still mint an explicitly scoped personal token', async () => {
    const tokens = new TokenService({
        issuer: ISSUER,
        resource: `${ISSUER}/mcp`,
        sessionSecret: SESSION_SECRET,
    })
    let persistedScopes: string[] | null = null
    const createdAt = new Date('2026-07-31T00:00:00.000Z')
    const expiresAt = new Date('2026-08-30T00:00:00.000Z')
    const pool = {
        query: async (sql: string, params: unknown[]) => {
            assert.match(sql, /INSERT INTO personal_access_tokens/)
            persistedScopes = params[4] as string[]
            return {
                rowCount: 1,
                rows: [{
                    id: '36a105bd-624e-47b6-9067-f32fc52e0d86',
                    created_at: createdAt,
                    expires_at: expiresAt,
                }],
            }
        },
    } as unknown as Pool
    const authenticator = {
        bearer: async () => {
            throw new Error('dashboard session must not use bearer authentication')
        },
    } as unknown as Authenticator
    const app = new Hono()
    app.route('/v1/tokens', tokenRoutes({pool, authenticator, tokens}))
    const session = tokens.signSession(account(ACCOUNT_ID))

    const response = await app.request('/v1/tokens', {
        method: 'POST',
        headers: {
            cookie: `__Host-ritsdev_session=${session}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            name: 'read-only CLI',
            scopes: ['sites:read'],
            expiresInDays: 30,
        }),
    })
    assert.equal(response.status, 201)
    const body = await response.json() as {token: string; scopes: string[]; expiresAt: string}
    assert.match(body.token, /^rits_/)
    assert.deepEqual(body.scopes, ['sites:read'])
    assert.equal(body.expiresAt, expiresAt.toISOString())
    assert.deepEqual(persistedScopes, ['sites:read'])
})

function authorizationUrl(): string {
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: 'mcp_test',
        redirect_uri: 'http://127.0.0.1/callback',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        resource: `${ISSUER}/mcp`,
        scope: 'sites:read',
        state: 'client-state',
    })
    return `/oauth/authorize?${query}`
}

function consent(
    app: Hono,
    session: string,
    token: string,
    decision: 'approve' | 'deny',
    extraHeaders: Record<string, string> = {},
): Promise<Response> {
    return Promise.resolve(app.request('/oauth/authorize', {
        method: 'POST',
        headers: {
            cookie: `__Host-ritsdev_session=${session}`,
            'content-type': 'application/x-www-form-urlencoded',
            origin: ISSUER,
            ...extraHeaders,
        },
        body: new URLSearchParams({consent_token: token, decision}),
    }))
}

function account(id: string) {
    return {
        accountId: id,
        email: 'student@example.edu',
        displayName: 'Student',
        role: 'user' as const,
    }
}

function bearerPrincipal(tokenKind: 'oauth' | 'pat'): Principal {
    return {
        ...account(ACCOUNT_ID),
        scopes: ['sites:read'],
        tokenKind,
    }
}

type ConsentRow = {
    request_hash: string
    account_id: string
    client_id: string
    redirect_uri: string
    code_challenge: string
    scopes: string[]
    resource: string
    state: string | null
    consumed_at: Date | null
}

class ConsentDatabase {
    consent: ConsentRow | null = null
    authorizationCodes: Array<{code_hash: string; account_id: string}> = []

    async query(sql: string, params: unknown[] = []): Promise<{rowCount: number; rows: any[]}> {
        if (sql.includes('SELECT client_name, redirect_uris FROM oauth_clients')) {
            return {
                rowCount: 1,
                rows: [{
                    client_name: '<script>untrusted client</script>',
                    redirect_uris: ['http://127.0.0.1/callback'],
                }],
            }
        }
        if (sql.includes('INSERT INTO oauth_consent_requests')) {
            this.consent = {
                request_hash: params[0] as string,
                account_id: params[1] as string,
                client_id: params[2] as string,
                redirect_uri: params[3] as string,
                code_challenge: params[4] as string,
                scopes: params[5] as string[],
                resource: params[6] as string,
                state: params[7] as string | null,
                consumed_at: null,
            }
            return {rowCount: 1, rows: []}
        }
        throw new Error(`unexpected pool query: ${sql}`)
    }

    async connect() {
        return {
            query: async (sql: string, params: unknown[] = []) => {
                if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return {rowCount: null, rows: []}
                if (sql.includes('FROM oauth_consent_requests')) {
                    const row = this.consent
                    const matches = row && row.request_hash === params[0] && !row.consumed_at
                    return {rowCount: matches ? 1 : 0, rows: matches ? [row] : []}
                }
                if (sql.includes('UPDATE oauth_consent_requests SET consumed_at')) {
                    const consent = this.consent
                    if (consent && consent.request_hash === params[0]) consent.consumed_at = new Date()
                    return {rowCount: this.consent ? 1 : 0, rows: []}
                }
                if (sql.includes('INSERT INTO oauth_authorization_codes')) {
                    this.authorizationCodes.push({
                        code_hash: params[0] as string,
                        account_id: params[1] as string,
                    })
                    return {rowCount: 1, rows: []}
                }
                throw new Error(`unexpected client query: ${sql}`)
            },
            release: () => undefined,
        }
    }
}
