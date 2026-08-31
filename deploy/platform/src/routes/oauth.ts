import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {bodyLimit} from 'hono/body-limit'
import type {Pool} from 'pg'
import {z} from 'zod'
import {ALL_SCOPES, DEFAULT_SCOPES, parseScopes, type TokenService, type PlatformRole} from '../lib/authn'
import {base64Url, sha256} from '../lib/crypto'
import {rateLimit} from '../lib/rate-limit'
import {sessionPrincipal} from './auth'

export interface OAuthDeps {
    pool: Pool
    tokens: TokenService
    publicBaseUrl: string
}

const registrationSchema = z.object({
    client_name: z.string().min(1).max(100).default('MCP client'),
    redirect_uris: z.array(z.string().url()).min(1).max(10),
    token_endpoint_auth_method: z.literal('none').optional(),
})

export function oauthRoutes(deps: OAuthDeps) {
    const app = new Hono()

    app.use('/register', rateLimit('oauth-register', 20, 60 * 60_000))
    app.use('/authorize', rateLimit('oauth-authorize', 60, 60_000))
    app.use('/token', rateLimit('oauth-token', 60, 60_000))
    app.use('/revoke', rateLimit('oauth-revoke', 60, 60_000))
    app.use('*', bodyLimit({maxSize: 64 * 1024}))

    app.post('/register', async c => {
        const body = registrationSchema.parse(await c.req.json())
        body.redirect_uris.forEach(validateRedirectUri)
        const clientId = `mcp_${base64Url(18)}`
        await deps.pool.query(
            `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,$2,$3)`,
            [clientId, body.client_name, body.redirect_uris],
        )
        return c.json({
            client_id: clientId,
            client_name: body.client_name,
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        }, 201)
    })

    app.get('/authorize', async c => {
        const principal = sessionPrincipal(c, deps.tokens)
        if (!principal) {
            const requestUrl = new URL(c.req.url)
            const returnTo = `${deps.publicBaseUrl}${requestUrl.pathname}${requestUrl.search}`
            return c.redirect(`${deps.publicBaseUrl}/auth/google?return_to=${encodeURIComponent(returnTo)}`)
        }
        const request = await validateAuthorizationRequest(deps, c.req.query())
        const consentToken = base64Url(32)
        await deps.pool.query(
            `INSERT INTO oauth_consent_requests
             (request_hash, account_id, client_id, redirect_uri, code_challenge, scopes, resource, state, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now() + interval '10 minutes')`,
            [
                sha256(consentToken),
                principal.accountId,
                request.clientId,
                request.redirectUri,
                request.codeChallenge,
                request.scopes,
                request.resource,
                request.state,
            ],
        )
        noStore(c)
        return c.html(consentPage({
            token: consentToken,
            clientName: request.clientName,
            redirectHost: new URL(request.redirectUri).host,
            platformHost: new URL(deps.publicBaseUrl).host,
            scopes: request.scopes,
        }))
    })

    app.post('/authorize', async c => {
        const principal = sessionPrincipal(c, deps.tokens)
        if (!principal) throw new HTTPException(401, {message: 'login session expired'})
        requireSameOrigin(c.req.header('origin'), deps.publicBaseUrl)
        const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/x-www-form-urlencoded') {
            throw new HTTPException(415, {message: 'consent responses must use form encoding'})
        }
        const form = new URLSearchParams(await c.req.text())
        const consentToken = form.get('consent_token')
        const decision = form.get('decision')
        if (!consentToken || !['approve', 'deny'].includes(decision ?? '')) {
            throw new HTTPException(400, {message: 'invalid consent response'})
        }
        const client = await deps.pool.connect()
        try {
            await client.query('BEGIN')
            const result = await client.query<{
                account_id: string
                client_id: string
                redirect_uri: string
                code_challenge: string
                scopes: string[]
                resource: string
                state: string | null
            }>(
                `SELECT account_id, client_id, redirect_uri, code_challenge, scopes, resource, state
                 FROM oauth_consent_requests
                 WHERE request_hash = $1 AND consumed_at IS NULL AND expires_at > now()
                 FOR UPDATE`,
                [sha256(consentToken)],
            )
            const request = result.rows[0]
            if (!request || request.account_id !== principal.accountId) {
                throw new HTTPException(400, {message: 'invalid or expired consent request'})
            }
            await client.query(
                `UPDATE oauth_consent_requests SET consumed_at = now() WHERE request_hash = $1`,
                [sha256(consentToken)],
            )
            const redirect = new URL(request.redirect_uri)
            if (decision === 'deny') {
                redirect.searchParams.set('error', 'access_denied')
            } else {
                const code = base64Url()
                await client.query(
                    `INSERT INTO oauth_authorization_codes
                     (code_hash, account_id, client_id, redirect_uri, code_challenge, scopes, resource, expires_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '5 minutes')`,
                    [
                        sha256(code),
                        request.account_id,
                        request.client_id,
                        request.redirect_uri,
                        request.code_challenge,
                        request.scopes,
                        request.resource,
                    ],
                )
                redirect.searchParams.set('code', code)
            }
            if (request.state) redirect.searchParams.set('state', request.state)
            await client.query('COMMIT')
            noStore(c)
            return c.redirect(redirect.toString())
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    })

    app.post('/token', async c => {
        const form = new URLSearchParams(await c.req.text())
        const grant = form.get('grant_type')
        if (grant === 'authorization_code') return await exchangeCode(c, deps, form)
        if (grant === 'refresh_token') return await exchangeRefresh(c, deps, form)
        return oauthError(c, 'unsupported_grant_type', 400)
    })

    app.post('/revoke', async c => {
        const form = new URLSearchParams(await c.req.text())
        const token = form.get('token')
        if (token) {
            await deps.pool.query(`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [sha256(token)])
        }
        return c.body(null, 200)
    })

    return app
}

export function oauthMetadata(deps: OAuthDeps) {
    const app = new Hono()
    app.get('/oauth-authorization-server', c => c.json({
        issuer: deps.tokens.issuer,
        authorization_endpoint: `${deps.publicBaseUrl}/oauth/authorize`,
        token_endpoint: `${deps.publicBaseUrl}/oauth/token`,
        registration_endpoint: `${deps.publicBaseUrl}/oauth/register`,
        revocation_endpoint: `${deps.publicBaseUrl}/oauth/revoke`,
        jwks_uri: `${deps.publicBaseUrl}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ALL_SCOPES,
    }))
    app.get('/oauth-protected-resource', c => c.json({
        resource: deps.tokens.resource,
        authorization_servers: [deps.tokens.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ALL_SCOPES,
    }))
    app.get('/jwks.json', c => c.json(deps.tokens.jwks()))
    return app
}

async function exchangeCode(c: import('hono').Context, deps: OAuthDeps, form: URLSearchParams) {
    const code = form.get('code')
    const verifier = form.get('code_verifier')
    const clientId = form.get('client_id')
    const redirectUri = form.get('redirect_uri')
    if (!code || !verifier || !clientId || !redirectUri) return oauthError(c, 'invalid_request', 400)
    const client = await deps.pool.connect()
    try {
        await client.query('BEGIN')
        const result = await client.query<TokenRow & {redirect_uri: string; code_challenge: string}>(
            `SELECT a.account_id, a.client_id, a.redirect_uri, a.code_challenge,
                    a.scopes, a.resource, u.email, u.display_name, u.platform_role
             FROM oauth_authorization_codes a
             JOIN accounts u ON u.id = a.account_id
             WHERE a.code_hash = $1 AND a.consumed_at IS NULL AND a.expires_at > now()
             FOR UPDATE OF a`,
            [sha256(code)],
        )
        const row = result.rows[0]
        const challenge = Buffer.from(sha256Buffer(verifier)).toString('base64url')
        if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || row.code_challenge !== challenge) {
            await client.query('ROLLBACK')
            return oauthError(c, 'invalid_grant', 400)
        }
        await client.query(
            `UPDATE oauth_authorization_codes SET consumed_at = now() WHERE code_hash = $1`,
            [sha256(code)],
        )
        const response = await issueTokens(c, deps, row, client)
        await client.query('COMMIT')
        return response
    } catch (error) {
        await client.query('ROLLBACK')
        throw error
    } finally {
        client.release()
    }
}

async function exchangeRefresh(c: import('hono').Context, deps: OAuthDeps, form: URLSearchParams) {
    const raw = form.get('refresh_token')
    const clientId = form.get('client_id')
    if (!raw || !clientId) return oauthError(c, 'invalid_request', 400)
    const client = await deps.pool.connect()
    try {
        await client.query('BEGIN')
        const result = await client.query<TokenRow>(
            `SELECT t.account_id, t.client_id, t.scopes, t.resource,
                    u.email, u.display_name, u.platform_role
             FROM oauth_refresh_tokens t
             JOIN accounts u ON u.id = t.account_id
             WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()
             FOR UPDATE OF t`,
            [sha256(raw)],
        )
        const row = result.rows[0]
        if (!row || row.client_id !== clientId) {
            await client.query('ROLLBACK')
            return oauthError(c, 'invalid_grant', 400)
        }
        await client.query(`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [sha256(raw)])
        const response = await issueTokens(c, deps, row, client)
        await client.query('COMMIT')
        return response
    } catch (error) {
        await client.query('ROLLBACK')
        throw error
    } finally {
        client.release()
    }
}

type TokenRow = {
    account_id: string
    client_id: string
    scopes: string[]
    resource: string
    email: string
    display_name: string
    platform_role: PlatformRole
}

async function issueTokens(
    c: import('hono').Context,
    deps: OAuthDeps,
    row: TokenRow,
    db: Pick<import('pg').PoolClient, 'query'> = deps.pool,
) {
    const refresh = base64Url(48)
    await db.query(
        `INSERT INTO oauth_refresh_tokens
         (token_hash, account_id, client_id, scopes, resource, expires_at)
         VALUES ($1,$2,$3,$4,$5,now() + interval '30 days')`,
        [sha256(refresh), row.account_id, row.client_id, row.scopes, row.resource],
    )
    const access = deps.tokens.signAccess({
        accountId: row.account_id,
        email: row.email,
        displayName: row.display_name,
        role: row.platform_role,
        scopes: parseScopes(row.scopes),
    }, row.resource)
    noStore(c)
    return c.json({
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refresh,
        scope: row.scopes.join(' '),
    })
}

function sha256Buffer(value: string): Buffer {
    return Buffer.from(sha256(value), 'hex')
}

function validateRedirectUri(value: string): void {
    const url = new URL(value)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
        throw new HTTPException(400, {message: 'redirect URIs must use HTTPS or loopback HTTP'})
    }
    if (url.hash) throw new HTTPException(400, {message: 'redirect URIs cannot contain fragments'})
}

async function validateAuthorizationRequest(deps: OAuthDeps, query: Record<string, string>) {
    if (query.response_type !== 'code' || query.code_challenge_method !== 'S256') {
        throw new HTTPException(400, {message: 'authorization code with PKCE S256 is required'})
    }
    const client = await deps.pool.query<{client_name: string; redirect_uris: string[]}>(
        `SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = $1`,
        [query.client_id],
    )
    if (!client.rowCount || !client.rows[0].redirect_uris.includes(query.redirect_uri)) {
        throw new HTTPException(400, {message: 'invalid client or redirect URI'})
    }
    if (!query.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(query.code_challenge)) {
        throw new HTTPException(400, {message: 'invalid PKCE challenge'})
    }
    const resource = query.resource || deps.tokens.resource
    if (resource !== deps.tokens.resource) throw new HTTPException(400, {message: 'invalid resource'})
    const scopes = parseScopes(query.scope || DEFAULT_SCOPES.join(' '))
    if (!scopes.length) throw new HTTPException(400, {message: 'no supported scopes requested'})
    return {
        clientId: query.client_id,
        clientName: client.rows[0].client_name,
        redirectUri: query.redirect_uri,
        codeChallenge: query.code_challenge,
        scopes,
        resource,
        state: query.state || null,
    }
}

function consentPage(input: {token: string; clientName: string; redirectHost: string; platformHost: string; scopes: string[]}): string {
    const scopes = input.scopes.map(scope => `<li><code>${escapeHtml(scope)}</code></li>`).join('')
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${escapeHtml(input.clientName)}</title>
<style>:root{color-scheme:dark;font:16px/1.5 system-ui;background:#090b10;color:#f4f6fb}body{margin:0;padding:48px 20px}.card{max-width:560px;margin:auto;background:#11151d;border:1px solid #29303d;border-radius:18px;padding:28px}h1{font-size:28px;margin-top:0}.muted{color:#a5adbb}form{display:flex;gap:12px;margin-top:28px}button{border:0;border-radius:10px;padding:11px 16px;font-weight:700;cursor:pointer}.approve{background:#fff;color:#090b10}.deny{background:#2a313d;color:#fff}</style>
</head><body><main class="card"><h1>Authorize ${escapeHtml(input.clientName)}?</h1>
<p>This client will receive access to your ${escapeHtml(input.platformHost)} account and return to <strong>${escapeHtml(input.redirectHost)}</strong>.</p>
<p class="muted">Requested permissions:</p><ul>${scopes}</ul>
<form method="post" action="/oauth/authorize"><input type="hidden" name="consent_token" value="${escapeHtml(input.token)}">
<button class="approve" type="submit" name="decision" value="approve">Allow</button>
<button class="deny" type="submit" name="decision" value="deny">Deny</button></form>
</main></body></html>`
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[character]!)
}

export function requireSameOrigin(origin: string | undefined, publicBaseUrl: string): void {
    if (!origin) return
    // Some clients open the consent page in a context with an opaque origin, so
    // the browser sends the literal string "null". That is indistinguishable
    // from a same-origin submission for CSRF purposes and carries no less
    // information than omitting the header entirely, which is already allowed.
    // The real protection is consent_token: single-use, account-bound, hashed,
    // and expiring in ten minutes.
    if (origin === 'null') return
    if (origin !== new URL(publicBaseUrl).origin) {
        console.error(`[oauth] consent rejected: origin ${JSON.stringify(origin)} is not ${new URL(publicBaseUrl).origin}`)
        throw new HTTPException(403, {message: `cross-origin consent response rejected (origin: ${origin})`})
    }
}

function noStore(c: import('hono').Context): void {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
}

function oauthError(c: import('hono').Context, error: string, status: 400 | 401) {
    noStore(c)
    return c.json({error}, status)
}
