import {Hono} from 'hono'
import {getCookie, setCookie, deleteCookie} from 'hono/cookie'
import {HTTPException} from 'hono/http-exception'
import {bodyLimit} from 'hono/body-limit'
import type {Pool} from 'pg'
import type {PlatformRole, Principal, TokenService} from '../lib/authn'
import {base64Url, sha256} from '../lib/crypto'
import {DEFAULT_PROJECT_QUOTA} from '../lib/projects'
import {rateLimit} from '../lib/rate-limit'
import {emailAllowed, hostedDomainHint, signInRequirement, type AuthPolicy} from '../lib/allowed-domains'

const SESSION_COOKIE = '__Host-ritsdev_session'

export interface AuthDeps {
    pool: Pool
    /** Who may sign in. See lib/allowed-domains. */
    authPolicy: AuthPolicy
    tokens: TokenService
    publicBaseUrl: string
    googleClientId?: string
    googleClientSecret?: string
    devBypass?: boolean
    /**
     * Written only when a sign-in creates the account. Never in the conflict
     * branch: an account whose quota an operator raised must keep it, and every
     * login takes that branch.
     */
    defaultProjectQuota?: number
}

export function authRoutes(deps: AuthDeps) {
    const app = new Hono()
    app.use('*', bodyLimit({maxSize: 64 * 1024}))

    app.use('/google', rateLimit('google-login', 30, 60_000))
    app.use('/google/callback', rateLimit('google-callback', 30, 60_000))
    app.use('/site', rateLimit('site-login', 60, 60_000))
    app.use('/dev', rateLimit('dev-login', 30, 60_000))

    app.get('/google', async c => {
        if (!deps.googleClientId || !deps.googleClientSecret) {
            throw new HTTPException(503, {message: 'Google OAuth is not configured'})
        }
        const state = base64Url()
        const nonce = base64Url()
        const returnTo = safeReturnTo(c.req.query('return_to'), deps.publicBaseUrl)
        await deps.pool.query(
            `INSERT INTO oauth_login_states (state_hash, nonce, return_to, expires_at)
             VALUES ($1,$2,$3,now() + interval '10 minutes')`,
            [sha256(state), nonce, returnTo],
        )
        const target = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        target.search = new URLSearchParams({
            client_id: deps.googleClientId,
            redirect_uri: `${deps.publicBaseUrl}/auth/google/callback`,
            response_type: 'code',
            scope: 'openid email profile',
            state,
            nonce,
            ...(hostedDomainHint(deps.authPolicy) ? {hd: hostedDomainHint(deps.authPolicy)!} : {}),
            prompt: 'select_account',
        }).toString()
        return c.redirect(target.toString())
    })

    app.get('/google/callback', async c => {
        if (!deps.googleClientId || !deps.googleClientSecret) {
            throw new HTTPException(503, {message: 'Google OAuth is not configured'})
        }
        const state = c.req.query('state')
        const code = c.req.query('code')
        if (!state || !code) throw new HTTPException(400, {message: 'missing Google authorization response'})
        const stateResult = await deps.pool.query<{nonce: string; return_to: string}>(
            `DELETE FROM oauth_login_states
             WHERE state_hash = $1 AND expires_at > now()
             RETURNING nonce, return_to`,
            [sha256(state)],
        )
        const loginState = stateResult.rows[0]
        if (!loginState) throw new HTTPException(400, {message: 'invalid or expired login state'})

        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {'content-type': 'application/x-www-form-urlencoded'},
            body: new URLSearchParams({
                code,
                client_id: deps.googleClientId,
                client_secret: deps.googleClientSecret,
                redirect_uri: `${deps.publicBaseUrl}/auth/google/callback`,
                grant_type: 'authorization_code',
            }),
        })
        const tokenBody = await tokenResponse.json() as {id_token?: string; error?: string}
        if (!tokenResponse.ok || !tokenBody.id_token) {
            throw new HTTPException(401, {message: tokenBody.error || 'Google token exchange failed'})
        }
        const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenBody.id_token)}`)
        const identity = await verifyResponse.json() as {
            sub?: string
            aud?: string
            iss?: string
            email?: string
            email_verified?: string
            hd?: string
            name?: string
            picture?: string
            nonce?: string
        }
        if (!verifyResponse.ok
            || identity.aud !== deps.googleClientId
            || !['accounts.google.com', 'https://accounts.google.com'].includes(identity.iss ?? '')
            || identity.email_verified !== 'true'
            || !identity.email
            || !emailAllowed(deps.authPolicy, identity.email, identity.hd)
            || !identity.sub
            || identity.nonce !== loginState.nonce) {
            throw new HTTPException(403, {message: signInRequirement(deps.authPolicy)})
        }
        const result = await deps.pool.query<{
            id: string
            email: string
            display_name: string
            platform_role: PlatformRole
        }>(
            `INSERT INTO accounts (google_sub, email, display_name, avatar_url, last_login_at, project_quota)
             VALUES ($1,$2,$3,$4,now(),$5)
             ON CONFLICT (email) DO UPDATE
             SET google_sub = EXCLUDED.google_sub,
                 display_name = EXCLUDED.display_name,
                 avatar_url = EXCLUDED.avatar_url,
                 last_login_at = now()
             RETURNING id, email, display_name, platform_role`,
            [
                identity.sub,
                identity.email.toLowerCase(),
                identity.name || identity.email,
                identity.picture ?? null,
                deps.defaultProjectQuota ?? DEFAULT_PROJECT_QUOTA,
            ],
        )
        setSessionCookie(c, deps.tokens, rowPrincipal(result.rows[0]))
        return c.redirect(loginState.return_to)
    })

    app.get('/me', async c => {
        const principal = sessionPrincipal(c, deps.tokens)
        if (!principal) throw new HTTPException(401, {message: 'not logged in'})
        // The cookie carries the role it was minted with, and a session lasts
        // twelve hours. Reading the account keeps a promotion or demotion
        // visible in the dashboard without forcing a fresh sign-in.
        const account = await deps.pool.query<{platform_role: PlatformRole}>(
            `SELECT platform_role FROM accounts WHERE id = $1`,
            [principal.accountId],
        )
        if (!account.rowCount) throw new HTTPException(401, {message: 'account no longer exists'})
        return c.json({
            id: principal.accountId,
            email: principal.email,
            name: principal.displayName,
            role: account.rows[0].platform_role,
        })
    })

    app.post('/logout', c => {
        // A __Host- cookie must be deleted with the same attributes it was set
        // with. Omitting `secure` makes Hono throw, which turned every logout
        // into a 500 that left the session cookie in place.
        deleteCookie(c, SESSION_COOKIE, {httpOnly: true, secure: true, sameSite: 'Lax', path: '/'})
        return c.json({ok: true})
    })

    app.get('/site', async c => {
        const principal = sessionPrincipal(c, deps.tokens)
        if (!principal) {
            const requestUrl = new URL(c.req.url)
            const returnTo = `${deps.publicBaseUrl}${requestUrl.pathname}${requestUrl.search}`
            return c.redirect(`${deps.publicBaseUrl}/auth/google?return_to=${encodeURIComponent(returnTo)}`)
        }
        const host = (c.req.query('host') ?? '').toLowerCase().split(':')[0]
        const domain = new URL(deps.publicBaseUrl).hostname
        if (!host.endsWith(`.${domain}`)) throw new HTTPException(400, {message: 'invalid site host'})
        const label = host.slice(0, -(domain.length + 1))
        const slug = label.split('--v-')[0]
        if (!/^[a-z][a-z0-9-]{2,39}$/.test(slug)) throw new HTTPException(400, {message: 'invalid site host'})
        const project = await deps.pool.query<{id: string}>(
            `SELECT id FROM projects WHERE slug = $1 AND owner_id = $2 AND status <> 'deleted'`,
            [slug, principal.accountId],
        )
        if (!project.rowCount) throw new HTTPException(403, {message: 'only the project owner may visit this site'})
        const projectId = project.rows[0].id
        const returnPath = safeSitePath(c.req.query('return'))
        const ticket = base64Url(32)
        await deps.pool.query(
            `INSERT INTO site_login_tickets (ticket_hash, project_id, account_id, return_path, expires_at)
             VALUES ($1,$2,$3,$4,now() + interval '2 minutes')`,
            [sha256(ticket), projectId, principal.accountId, returnPath],
        )
        return c.redirect(`https://${host}/__auth/callback?ticket=${encodeURIComponent(ticket)}`)
    })

    app.post('/dev', async c => {
        if (!deps.devBypass) throw new HTTPException(404, {message: 'not found'})
        const body = await c.req.json<{email?: string; name?: string}>()
        const email = body.email?.toLowerCase()
        if (!emailAllowed(deps.authPolicy, email, undefined)) {
            throw new HTTPException(400, {message: signInRequirement(deps.authPolicy)})
        }
        const result = await deps.pool.query<{
            id: string
            email: string
            display_name: string
            platform_role: PlatformRole
        }>(
            `INSERT INTO accounts (email, display_name, last_login_at, project_quota)
             VALUES ($1,$2,now(),$3)
             ON CONFLICT (email) DO UPDATE SET last_login_at = now()
             RETURNING id, email, display_name, platform_role`,
            [email, body.name || email, deps.defaultProjectQuota ?? DEFAULT_PROJECT_QUOTA],
        )
        const principal = rowPrincipal(result.rows[0])
        setSessionCookie(c, deps.tokens, principal)
        return c.json({access_token: deps.tokens.signAccess({...principal, scopes: ['sites:read', 'sites:write', 'deployments:write', 'logs:read']})})
    })

    return app
}

export function sessionPrincipal(c: import('hono').Context, tokens: TokenService): Principal | null {
    const token = getCookie(c, SESSION_COOKIE)
    if (!token) return null
    try {
        return tokens.verifySession(token)
    } catch {
        return null
    }
}

function setSessionCookie(c: import('hono').Context, tokens: TokenService, principal: Principal): void {
    setCookie(c, SESSION_COOKIE, tokens.signSession(principal), {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 12 * 60 * 60,
    })
}

function rowPrincipal(row: {id: string; email: string; display_name: string; platform_role: PlatformRole}): Principal {
    return {
        accountId: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.platform_role,
        scopes: ['sites:read', 'sites:write', 'deployments:write', 'logs:read'],
        tokenKind: 'session',
    }
}

function safeReturnTo(value: string | undefined, publicBaseUrl: string): string {
    if (!value) return publicBaseUrl
    try {
        const url = new URL(value, publicBaseUrl)
        if (url.origin !== new URL(publicBaseUrl).origin) return publicBaseUrl
        return url.toString()
    } catch {
        return publicBaseUrl
    }
}

function safeSitePath(value: string | undefined): string {
    if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
    try {
        const url = new URL(value, 'https://site.invalid')
        return `${url.pathname}${url.search}${url.hash}`
    } catch {
        return '/'
    }
}
