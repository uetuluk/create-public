import {Hono} from 'hono'
import {requirePrincipal, sessionOrBearerAuth} from '../lib/middleware'
import type {Authenticator, TokenService} from '../lib/authn'
import {requireScopes} from '../lib/authn'
import type {ProjectService} from '../lib/projects'

/**
 * The gallery, and the images behind it.
 *
 * Separate from `/v1/projects` because nothing here is scoped to a project the
 * caller owns — that is the entire point of the tier — and mounting it under a
 * path whose every other route means "a project of mine" would be the kind of
 * quiet inconsistency that eventually gets an ownership check omitted.
 *
 * It still requires a signed-in account. The dashboard this serves is published
 * through the Cloudflare Tunnel and is the one public surface the platform has,
 * while the sites themselves resolve only on the internal network. Listing them
 * internally is what the owner asked for; putting their names, screenshots and
 * descriptions in front of the open internet is not, and an unauthenticated
 * gallery would do exactly that.
 */
export function showcaseRoutes(deps: {
    projects: ProjectService
    authenticator: Authenticator
    tokens: TokenService
}) {
    const app = new Hono()
    app.use('*', sessionOrBearerAuth(deps.authenticator, deps.tokens))

    app.get('/', async c => {
        const principal = requirePrincipal(c)
        requireScopes(principal, 'sites:read')
        const limit = Number(c.req.query('limit') ?? 60)
        return c.json({projects: await deps.projects.listShowcase(Number.isFinite(limit) ? limit : 60)})
    })

    app.get('/:slug/screenshot.png', async c => {
        const principal = requirePrincipal(c)
        requireScopes(principal, 'sites:read')
        const shot = await deps.projects.showcaseScreenshot(c.req.param('slug'))
        return c.body(new Uint8Array(shot.body), 200, {
            'content-type': 'image/png',
            // Weak-free: the body changes only when a capture or an upload
            // writes a new one, and both stamp showcase_shot_at.
            etag: `"${shot.capturedAt.getTime()}"`,
            // Private, because the response is only served to a signed-in
            // caller and must not be held by anything between here and them.
            'cache-control': 'private, max-age=300',
        })
    })

    return app
}
