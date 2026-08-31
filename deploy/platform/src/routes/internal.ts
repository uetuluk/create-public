import {Hono} from 'hono'
import {bodyLimit} from 'hono/body-limit'
import {HTTPException} from 'hono/http-exception'
import {
    bodyDigest,
    REVIEW_TOKEN_HEADER,
    SHOWCASE_DESCRIPTION_AUDIENCE_PATH,
    verifyReviewToken,
} from '../lib/review-token'
import {EVIDENCE_TEXT_LIMIT, siteEvidenceSchema} from '../lib/site-evidence'
import type {ShowcaseDescriptionModel} from '../lib/showcase-description'
import type {SiteReviewModel} from '../lib/site-reviewer'

/**
 * The endpoints the executor calls on the control plane.
 *
 * It exists because of a network boundary that is worth keeping: the executor
 * holds the Docker socket and has no egress, the control plane has egress and
 * the LiteLLM admin credential, and neither should acquire the other's
 * property. So the executor renders and judges, and asks over here for the one
 * thing it cannot do itself.
 *
 * cloudflared connects straight to `platform:3000`, so this path is reachable
 * from the public internet exactly as every other path on this app is. The
 * signed token is the control, not the path: HS256 over the session secret,
 * audience-bound to this endpoint, two-minute expiry, and bound to a digest of
 * the body so a captured request cannot be re-aimed at other content. That is
 * the same construction the gateway already accepts for renders.
 *
 * It answers 200 with `{"raw": null}` when there is no model to ask. A caller
 * must not be able to tell "no opinion" apart from "no answer", because they
 * mean the same thing to a review and neither is approval.
 */
export function internalRoutes(deps: {
    sessionSecret: string
    publicBaseUrl: string
    reviewer: SiteReviewModel | null
    describer: ShowcaseDescriptionModel | null
}) {
    const app = new Hono()
    // Every other route family here bounds its body, and this one is reachable
    // from the public internet like the rest. Evidence is clamped upstream to
    // EVIDENCE_TEXT_LIMIT characters plus a bounded set of forms and origins,
    // so a legitimate request is far below this; the limit is here to cap what
    // an unauthenticated caller can make this process hold.
    app.use('*', bodyLimit({maxSize: 4 * EVIDENCE_TEXT_LIMIT}))

    app.post('/site-review', async c => {
        // Verified before the body is parsed. The digest check needs the body,
        // but the signature, audience and expiry do not, so an unauthenticated
        // caller never gets attacker-supplied content parsed on its behalf.
        // Note the body may still have been streamed by the limit above when a
        // request arrives without content-length — that is what bounds it; this
        // ordering is about not acting on the content, not about never touching
        // it.
        const claims = verifyReviewToken(c.req.header(REVIEW_TOKEN_HEADER), deps.sessionSecret, deps.publicBaseUrl)
        if (!claims) throw new HTTPException(401, {message: 'invalid review token'})
        const body = await c.req.text()
        if (claims.digest !== bodyDigest(body)) {
            throw new HTTPException(401, {message: 'invalid review token'})
        }
        // Null rather than an error: a deployment without the LLM binding still
        // reviews every site, it just reviews them on the static signals alone.
        if (!deps.reviewer) return c.json({raw: null})

        let evidence
        try {
            evidence = siteEvidenceSchema.parse(JSON.parse(body))
        } catch {
            throw new HTTPException(400, {message: 'evidence did not validate'})
        }
        return c.json({raw: await deps.reviewer.opinion(evidence)})
    })

    /**
     * The same construction, for a different question about the same page.
     *
     * It is a separate route rather than another field on the review reply
     * because the two have different lifetimes and different consequences. A
     * review runs on every network site whether or not anyone asked; a
     * description is drafted only for a project whose owner has chosen to be
     * listed. Folding the second into the first would mean drafting copy for
     * every site on the platform, most of which will never be listed, and
     * would put untrusted summary text on the same reply an operator's
     * security verdict travels on.
     *
     * Answers 200 with `{"summary": null}` when there is no model to ask, for
     * the same reason the reviewer does: the caller must degrade, not fail.
     */
    app.post('/showcase-description', async c => {
        // Its own audience. A token minted to buy a security review must not be
        // spendable here, and vice versa.
        const claims = verifyReviewToken(
            c.req.header(REVIEW_TOKEN_HEADER),
            deps.sessionSecret,
            deps.publicBaseUrl,
            SHOWCASE_DESCRIPTION_AUDIENCE_PATH,
        )
        if (!claims) throw new HTTPException(401, {message: 'invalid review token'})
        const body = await c.req.text()
        if (claims.digest !== bodyDigest(body)) {
            throw new HTTPException(401, {message: 'invalid review token'})
        }
        if (!deps.describer) return c.json({summary: null})

        let evidence
        try {
            evidence = siteEvidenceSchema.parse(JSON.parse(body))
        } catch {
            throw new HTTPException(400, {message: 'evidence did not validate'})
        }
        return c.json({summary: await deps.describer.draft(evidence)})
    })

    return app
}
