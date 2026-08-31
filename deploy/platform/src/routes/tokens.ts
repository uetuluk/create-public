import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {bodyLimit} from 'hono/body-limit'
import type {Pool} from 'pg'
import {z} from 'zod'
import {ALL_SCOPES, DEFAULT_SCOPES, parseScopes, type Authenticator, type TokenService} from '../lib/authn'
import {base64Url, sha256} from '../lib/crypto'
import {requirePrincipal, sessionOrBearerAuth} from '../lib/middleware'

export function tokenRoutes(deps: {pool: Pool; authenticator: Authenticator; tokens: TokenService}) {
    const app = new Hono()
    app.use('*', sessionOrBearerAuth(deps.authenticator, deps.tokens))
    app.use('*', bodyLimit({maxSize: 64 * 1024}))

    app.get('/', async c => {
        const principal = requirePrincipal(c)
        requireDashboardSession(principal)
        const result = await deps.pool.query(
            `SELECT id, name, token_last_four, scopes, expires_at, last_used_at, revoked_at, created_at
             FROM personal_access_tokens WHERE account_id = $1 ORDER BY created_at DESC`,
            [principal.accountId],
        )
        return c.json({tokens: result.rows.map(row => ({
            id: row.id,
            name: row.name,
            lastFour: row.token_last_four,
            scopes: row.scopes,
            expiresAt: row.expires_at?.toISOString() ?? null,
            lastUsedAt: row.last_used_at?.toISOString() ?? null,
            revokedAt: row.revoked_at?.toISOString() ?? null,
            createdAt: row.created_at.toISOString(),
        }))})
    })

    app.post('/', async c => {
        const principal = requirePrincipal(c)
        requireDashboardSession(principal)
        const body = z.object({
            name: z.string().min(1).max(80),
            scopes: z.array(z.enum(ALL_SCOPES)).min(1).default([...DEFAULT_SCOPES]),
            expiresInDays: z.number().int().min(1).max(365).default(90),
        }).parse(await c.req.json())
        const raw = `rits_${base64Url(36)}`
        const result = await deps.pool.query<{id: string; created_at: Date; expires_at: Date}>(
            `INSERT INTO personal_access_tokens
             (account_id, name, token_hash, token_last_four, scopes, expires_at)
             VALUES ($1,$2,$3,$4,$5,now() + make_interval(days => $6))
             RETURNING id, created_at, expires_at`,
            [principal.accountId, body.name, sha256(raw), raw.slice(-4), parseScopes(body.scopes), body.expiresInDays],
        )
        return c.json({
            id: result.rows[0].id,
            token: raw,
            name: body.name,
            scopes: body.scopes,
            expiresAt: result.rows[0].expires_at.toISOString(),
            createdAt: result.rows[0].created_at.toISOString(),
        }, 201)
    })

    app.delete('/:id', async c => {
        const principal = requirePrincipal(c)
        requireDashboardSession(principal)
        const result = await deps.pool.query(
            `UPDATE personal_access_tokens SET revoked_at = now()
             WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL`,
            [c.req.param('id'), principal.accountId],
        )
        if (!result.rowCount) throw new HTTPException(404, {message: 'token not found'})
        return c.json({revoked: true})
    })

    return app
}

function requireDashboardSession(principal: ReturnType<typeof requirePrincipal>): void {
    if (principal.tokenKind !== 'session') {
        throw new HTTPException(403, {message: 'personal access tokens can only be managed from an interactive dashboard session'})
    }
}
