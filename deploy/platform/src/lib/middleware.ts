import type {Context, MiddlewareHandler} from 'hono'
import {getCookie} from 'hono/cookie'
import {HTTPException} from 'hono/http-exception'
import type {Authenticator, Principal, Scope, TokenService} from './authn'
import {requireScopes} from './authn'

declare module 'hono' {
    interface ContextVariableMap {
        principal: Principal
    }
}

export function bearerAuth(authenticator: Authenticator, tokens: TokenService, ...scopes: Scope[]): MiddlewareHandler {
    return async (c, next) => {
        const header = c.req.header('authorization')
        if (!header?.startsWith('Bearer ')) {
            c.header('WWW-Authenticate', `Bearer resource_metadata="${tokens.issuer}/.well-known/oauth-protected-resource"`)
            throw new HTTPException(401, {message: 'missing bearer token'})
        }
        try {
            const principal = await authenticator.bearer(header.slice(7).trim())
            requireScopes(principal, ...scopes)
            c.set('principal', principal)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'invalid bearer token'
            throw new HTTPException(message.startsWith('missing required scope') ? 403 : 401, {message})
        }
        await next()
    }
}

export function sessionOrBearerAuth(authenticator: Authenticator, tokens: TokenService, ...scopes: Scope[]): MiddlewareHandler {
    return async (c, next) => {
        try {
            const session = getCookie(c, '__Host-ritsdev_session')
            const principal = session
                ? tokens.verifySession(session)
                : await bearerPrincipal(c, authenticator)
            requireScopes(principal, ...scopes)
            c.set('principal', principal)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'unauthenticated'
            throw new HTTPException(message.startsWith('missing required scope') ? 403 : 401, {message})
        }
        await next()
    }
}

export function requirePrincipal(c: Context): Principal {
    const principal = c.get('principal') as Principal | undefined
    if (!principal) throw new HTTPException(401, {message: 'unauthenticated'})
    return principal
}

async function bearerPrincipal(c: Context, authenticator: Authenticator): Promise<Principal> {
    const header = c.req.header('authorization')
    if (!header?.startsWith('Bearer ')) throw new Error('missing session or bearer token')
    return await authenticator.bearer(header.slice(7).trim())
}

/**
 * The one place an error becomes a response body.
 *
 * Lives here rather than inline in `createServer` so a router mounted on its
 * own in a test answers exactly as it does in production. A test that asserts
 * on a 400 the real app produces, while its own harness produces a 500, is
 * testing the harness.
 */
export function apiErrorHandler(error: Error, c: Context): Response {
    if (error instanceof HTTPException) {
        return c.json({error: error.message, message: error.message}, error.status)
    }
    if ((error as any)?.name === 'ZodError') {
        return c.json(
            {error: 'validation_error', message: 'request validation failed', details: (error as any).issues},
            400,
        )
    }
    console.error(error)
    return c.json({error: 'internal_error', message: 'internal error'}, 500)
}
