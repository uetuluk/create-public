/**
 * The credential the executor presents when it asks the control plane for a
 * model opinion on a page.
 *
 * Same construction as the render token the gateway already accepts: HS256 over
 * `PLATFORM_SESSION_SECRET`, which both processes hold and nothing else does,
 * with an issuer, an audience naming one endpoint, and a two-minute life. It is
 * written here rather than inline at both ends so the two cannot drift.
 *
 * There is now more than one such endpoint — a review, and a showcase
 * description — so the audience is a parameter rather than a constant. It would
 * have been less code to let one token open both, and that is exactly the
 * property this construction was given in order to have: a token is good for
 * the one thing it was minted for. Two endpoints that each spend inference on
 * a shared proxy are two things.
 *
 * The extra claim is `digest`, a SHA-256 of the exact request body. The
 * endpoint spends inference on a shared proxy, so a token that could be
 * replayed with different content would be a way to spend it; binding the token
 * to its body means a captured one is good for repeating the same review and
 * nothing else.
 */
import {createHash} from 'node:crypto'
import jwt from 'jsonwebtoken'

export const REVIEW_AUDIENCE_PATH = '/internal/site-review'
export const SHOWCASE_DESCRIPTION_AUDIENCE_PATH = '/internal/showcase-description'
export const REVIEW_TOKEN_HEADER = 'x-ritsdev-review-token'
const REVIEW_TOKEN_TYPE = 'site_review'

export interface ReviewTokenClaims {
    project: string
    version: string
    digest: string
}

export function bodyDigest(body: string): string {
    return createHash('sha256').update(body).digest('hex')
}

export function signReviewToken(
    secret: string,
    issuer: string,
    claims: ReviewTokenClaims,
    audiencePath: string = REVIEW_AUDIENCE_PATH,
): string {
    return jwt.sign({typ: REVIEW_TOKEN_TYPE, ...claims}, secret, {
        algorithm: 'HS256',
        issuer,
        audience: `${issuer}${audiencePath}`,
        expiresIn: '2m',
    })
}

/** Null for anything unexpected: an unreadable token is not a valid one. */
export function verifyReviewToken(
    token: string | undefined | null,
    secret: string,
    issuer: string,
    audiencePath: string = REVIEW_AUDIENCE_PATH,
): ReviewTokenClaims | null {
    if (!token) return null
    try {
        const claims = jwt.verify(token, secret, {
            algorithms: ['HS256'],
            issuer,
            audience: `${issuer}${audiencePath}`,
        }) as jwt.JwtPayload
        if (claims.typ !== REVIEW_TOKEN_TYPE) return null
        if (typeof claims.project !== 'string' || typeof claims.version !== 'string'
            || typeof claims.digest !== 'string') {
            return null
        }
        return {project: claims.project, version: claims.version, digest: claims.digest}
    } catch {
        return null
    }
}
