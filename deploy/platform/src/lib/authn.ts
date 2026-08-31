import {createPublicKey, generateKeyPairSync, randomUUID} from 'node:crypto'
import {HTTPException} from 'hono/http-exception'
import jwt from 'jsonwebtoken'
import type {Pool} from 'pg'
import {sha256} from './crypto'

/**
 * Granted when a client asks for no scopes in particular.
 *
 * Kept separate from ALL_SCOPES on purpose: an authorization request without a
 * `scope` parameter, and a personal token created without an explicit list,
 * both fall back to this set. Anything added to ALL_SCOPES but not here has to
 * be asked for by name, which is what keeps a newly added scope from granting
 * itself to every existing client.
 */
export const DEFAULT_SCOPES = ['sites:read', 'sites:write', 'deployments:write', 'logs:read'] as const

/** Every scope the platform understands. `database:read` must be requested explicitly. */
export const ALL_SCOPES = [...DEFAULT_SCOPES, 'database:read'] as const
export type Scope = typeof ALL_SCOPES[number]

/**
 * The role ladder, lowest first.
 *
 * `user` publishes their own projects. `operator` adds the system admin view and
 * the operator project quota. `superadmin` adds the write surface under
 * `/v1/admin` — quotas, roles, and per-project limits — and is the only tier
 * that can change another account.
 *
 * Like `ACCESS_RANK` for visitor tiers, the order is what matters rather than
 * the names: every check below asks whether a role reaches a rank, never
 * whether it equals a value. A fourth tier added on top inherits every
 * permission beneath it instead of silently losing them, which is exactly what
 * an `=== 'operator'` test would have done to `superadmin`.
 */
export const PLATFORM_ROLES = ['user', 'operator', 'superadmin'] as const
export type PlatformRole = typeof PLATFORM_ROLES[number]
export const ROLE_RANK: Record<PlatformRole, number> = {user: 0, operator: 1, superadmin: 2}

/** True when `role` sits at or above `minimum` on the ladder. */
export function roleAtLeast(role: PlatformRole, minimum: PlatformRole): boolean {
    return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

export interface Principal {
    accountId: string
    email: string
    displayName: string
    role: PlatformRole
    scopes: Scope[]
    tokenKind: 'oauth' | 'pat' | 'session'
}

interface AccessClaims extends jwt.JwtPayload {
    sub: string
    email: string
    name: string
    role: PlatformRole
    scope: string
    typ: 'access'
}

interface SessionClaims extends jwt.JwtPayload {
    sub: string
    email: string
    name: string
    role: PlatformRole
    typ: 'session' | 'site'
    project?: string
}

export class TokenService {
    readonly issuer: string
    readonly resource: string
    private readonly privateKey: string
    private readonly publicKey: string
    private readonly sessionSecret: string
    private readonly keyId: string

    constructor(opts: {
        issuer: string
        resource: string
        sessionSecret: string
        privateKeyPem?: string
        publicKeyPem?: string
    }) {
        this.issuer = opts.issuer.replace(/\/+$/, '')
        this.resource = opts.resource
        this.sessionSecret = opts.sessionSecret
        if (opts.privateKeyPem && opts.publicKeyPem) {
            this.privateKey = opts.privateKeyPem.replace(/\\n/g, '\n')
            this.publicKey = opts.publicKeyPem.replace(/\\n/g, '\n')
        } else {
            const generated = generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: {type: 'spki', format: 'pem'},
                privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
            })
            this.privateKey = generated.privateKey
            this.publicKey = generated.publicKey
            console.warn('[auth] OAUTH_PRIVATE_KEY_PEM not set; using an ephemeral signing key')
        }
        this.keyId = sha256(this.publicKey).slice(0, 16)
    }

    signAccess(principal: Omit<Principal, 'tokenKind'>, audience = this.resource, ttlSeconds = 3600): string {
        return jwt.sign({
            email: principal.email,
            name: principal.displayName,
            role: principal.role,
            scope: principal.scopes.join(' '),
            typ: 'access',
        } satisfies Omit<AccessClaims, keyof jwt.JwtPayload | 'sub'>, this.privateKey, {
            algorithm: 'RS256',
            keyid: this.keyId,
            issuer: this.issuer,
            audience,
            subject: principal.accountId,
            expiresIn: ttlSeconds,
            jwtid: randomUUID(),
        })
    }

    verifyAccess(token: string): Principal {
        const claims = jwt.verify(token, this.publicKey, {
            algorithms: ['RS256'],
            issuer: this.issuer,
            audience: this.resource,
        }) as AccessClaims
        if (claims.typ !== 'access') throw new Error('not an access token')
        return {
            accountId: claims.sub,
            email: claims.email,
            displayName: claims.name,
            role: claims.role,
            scopes: parseScopes(claims.scope),
            tokenKind: 'oauth',
        }
    }

    signSession(principal: Omit<Principal, 'tokenKind' | 'scopes'>, typ: 'session' | 'site' = 'session', project?: string): string {
        return jwt.sign({
            email: principal.email,
            name: principal.displayName,
            role: principal.role,
            typ,
            project,
        } satisfies Omit<SessionClaims, keyof jwt.JwtPayload | 'sub'>, this.sessionSecret, {
            algorithm: 'HS256',
            issuer: this.issuer,
            audience: typ === 'site' ? `site:${project}` : `${this.issuer}/dashboard`,
            subject: principal.accountId,
            expiresIn: typ === 'site' ? '8h' : '12h',
        })
    }

    verifySession(token: string, typ: 'session' | 'site' = 'session', project?: string): Principal {
        const claims = jwt.verify(token, this.sessionSecret, {
            algorithms: ['HS256'],
            issuer: this.issuer,
            audience: typ === 'site' ? `site:${project}` : `${this.issuer}/dashboard`,
        }) as SessionClaims
        if (claims.typ !== typ || (typ === 'site' && claims.project !== project)) throw new Error('invalid session')
        return {
            accountId: claims.sub,
            email: claims.email,
            displayName: claims.name,
            role: claims.role,
            scopes: [...ALL_SCOPES],
            tokenKind: 'session',
        }
    }

    jwks(): {keys: Array<Record<string, unknown>>} {
        const jwk = createPublicKey(this.publicKey).export({format: 'jwk'}) as Record<string, unknown>
        return {keys: [{...jwk, use: 'sig', alg: 'RS256', kid: this.keyId}]}
    }
}

export class Authenticator {
    constructor(private readonly pool: Pool, private readonly tokens: TokenService) {}

    async bearer(raw: string): Promise<Principal> {
        if (raw.startsWith('rits_')) {
            const hash = sha256(raw)
            const result = await this.pool.query<{
                account_id: string
                email: string
                display_name: string
                platform_role: PlatformRole
                scopes: Scope[]
            }>(
                `UPDATE personal_access_tokens t
                 SET last_used_at = now()
                 FROM accounts a
                 WHERE t.token_hash = $1
                   AND t.account_id = a.id
                   AND t.revoked_at IS NULL
                   AND (t.expires_at IS NULL OR t.expires_at > now())
                 RETURNING t.account_id, a.email, a.display_name, a.platform_role, t.scopes`,
                [hash],
            )
            const row = result.rows[0]
            if (!row) throw new Error('invalid personal access token')
            return {
                accountId: row.account_id,
                email: row.email,
                displayName: row.display_name,
                role: row.platform_role,
                scopes: row.scopes,
                tokenKind: 'pat',
            }
        }
        return this.tokens.verifyAccess(raw)
    }
}

export function parseScopes(value: string | string[]): Scope[] {
    const requested = Array.isArray(value) ? value : value.split(/\s+/)
    const scopes = requested.filter((scope): scope is Scope => (ALL_SCOPES as readonly string[]).includes(scope))
    return [...new Set(scopes)]
}

export function requireScopes(principal: Principal, ...required: Scope[]): void {
    if (roleAtLeast(principal.role, 'operator')) return
    for (const scope of required) {
        if (!principal.scopes.includes(scope)) throw new Error(`missing required scope: ${scope}`)
    }
}

/**
 * The role the account holds right now, or null if it no longer exists.
 *
 * The session cookie and access token both carry the role that was current when
 * they were issued, and both outlive a demotion by up to twelve hours. Every
 * privileged surface re-reads the role here so removing a role takes effect on
 * the next request rather than at the next expiry.
 */
export async function currentRole(pool: Pool, principal: Principal): Promise<PlatformRole | null> {
    const result = await pool.query<{platform_role: PlatformRole}>(
        `SELECT platform_role FROM accounts WHERE id = $1`,
        [principal.accountId],
    )
    return result.rows[0]?.platform_role ?? null
}

/** Refuse anyone below `operator`; a superadmin is above it and passes. */
export async function assertOperator(pool: Pool, principal: Principal): Promise<void> {
    await assertRole(pool, principal, 'operator', 'operator access is required')
}

/**
 * Refuse anyone below `superadmin`.
 *
 * Separate from `assertOperator` because the two guard different things: an
 * operator may *read* every account and project, and only a superadmin may
 * change one. The message names the tier rather than saying "forbidden", since
 * an operator hitting this is not doing anything wrong — they are on a surface
 * one rung above them and should be told so.
 */
export async function assertSuperadmin(pool: Pool, principal: Principal): Promise<void> {
    await assertRole(pool, principal, 'superadmin', 'superadmin access is required to change this')
}

async function assertRole(
    pool: Pool,
    principal: Principal,
    minimum: PlatformRole,
    message: string,
): Promise<void> {
    const role = await currentRole(pool, principal)
    if (!role || !roleAtLeast(role, minimum)) throw new HTTPException(403, {message})
}
