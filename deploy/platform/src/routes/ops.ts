import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import type {Pool} from 'pg'
import {roleAtLeast, type Authenticator, type TokenService} from '../lib/authn'
import {requirePrincipal, sessionOrBearerAuth} from '../lib/middleware'

/**
 * Operator view of alert state.
 *
 * On the public app rather than the metrics listener, because it is an ordinary
 * authenticated API: operator role required, same posture as the rest of /v1.
 * It exists so that "alerts are not being delivered" is discoverable without
 * email, which is the one failure an email cannot report.
 */
export function opsRoutes(deps: {pool: Pool; authenticator: Authenticator; tokens: TokenService}) {
    const app = new Hono()
    app.use('*', sessionOrBearerAuth(deps.authenticator, deps.tokens))

    app.get('/alerts', async c => {
        const principal = requirePrincipal(c)
        if (!roleAtLeast(principal.role, 'operator')) {
            throw new HTTPException(403, {message: 'operator role required'})
        }
        const alerts = await deps.pool.query(
            `SELECT rule, subject, state, severity, value, threshold, summary,
                    first_breach_at, fired_at, resolved_at, last_eval_at, notify_attempts
             FROM alerts WHERE state = 'firing' ORDER BY severity DESC, rule, subject`,
        )
        const deliveries = await deps.pool.query(
            `SELECT status, subject, error_message, attempts, created_at, sent_at
             FROM alert_deliveries ORDER BY created_at DESC LIMIT 10`,
        )
        return c.json({
            firing: alerts.rows,
            recentDeliveries: deliveries.rows,
        })
    })

    /**
     * Automated reviews of the sites anyone on the network can reach.
     *
     * Two lists, because they answer different questions. `sites` is every
     * project at `network` with its current verdict, including the ones that
     * have never been reviewed — a page nobody has looked at is the thing most
     * easily mistaken for a page that came back clean. `recent` is the history,
     * so a verdict that changed is visible rather than overwritten.
     *
     * `caveat` is served with the data on purpose. This endpoint is where an
     * operator forms an opinion about a site, and the sentence that bounds what
     * a verdict means belongs where the verdict is read, not only in a document
     * nobody opens twice.
     */
    app.get('/site-reviews', async c => {
        const principal = requirePrincipal(c)
        if (!roleAtLeast(principal.role, 'operator')) {
            throw new HTTPException(403, {message: 'operator role required'})
        }
        const sites = await deps.pool.query(
            `SELECT p.slug, p.access_mode, s.level, s.host, s.signals, s.model_level, s.model_reason,
                    s.model_unavailable, s.summary, s.version_id, s.created_at AS reviewed_at
             FROM projects p
             LEFT JOIN LATERAL (
                 SELECT * FROM site_reviews r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1
             ) s ON true
             WHERE p.access_mode <> 'owner' AND p.status NOT IN ('deleted', 'deleting')
             ORDER BY CASE s.level WHEN 'urgent' THEN 0 WHEN 'review' THEN 1 WHEN 'clean' THEN 2 ELSE 3 END, p.slug`,
        )
        const recent = await deps.pool.query(
            `SELECT p.slug, s.level, s.model_level, s.model_unavailable, s.summary, s.created_at
             FROM site_reviews s JOIN projects p ON p.id = s.project_id
             ORDER BY s.created_at DESC LIMIT 50`,
        )
        return c.json({
            sites: sites.rows,
            recent: recent.rows,
            caveat: 'A site is a program, not a document: it can serve one page to this reviewer and another to'
                + ' visitors. A clean verdict is evidence of carelessness not found, never evidence of safety.'
                + ' A null level means the site has never been reviewed.',
        })
    })

    return app
}
