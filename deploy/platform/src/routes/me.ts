import {Hono} from 'hono'
import type {Authenticator, TokenService} from '../lib/authn'
import {requirePrincipal, sessionOrBearerAuth} from '../lib/middleware'

export function meRoutes(deps: {authenticator: Authenticator; tokens: TokenService}) {
    const app = new Hono()
    app.use('*', sessionOrBearerAuth(deps.authenticator, deps.tokens))
    app.get('/', c => {
        const principal = requirePrincipal(c)
        return c.json({
            id: principal.accountId,
            email: principal.email,
            name: principal.displayName,
            role: principal.role,
            scopes: principal.scopes,
            authentication: principal.tokenKind,
        })
    })
    return app
}
