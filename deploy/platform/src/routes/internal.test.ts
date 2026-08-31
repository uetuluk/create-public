import assert from 'node:assert/strict'
import test from 'node:test'
import {
    bodyDigest,
    REVIEW_TOKEN_HEADER,
    SHOWCASE_DESCRIPTION_AUDIENCE_PATH,
    signReviewToken,
} from '../lib/review-token'
import type {ShowcaseDescriptionModel} from '../lib/showcase-description'
import type {SiteReviewModel} from '../lib/site-reviewer'
import {internalRoutes} from './internal'

const SECRET = 'a'.repeat(32)
const ISSUER = 'https://sites.example.test'

const evidence = {
    slug: 'demo',
    host: 'demo.sites.example.test',
    status: 200,
    title: 'Demo',
    text: 'A small demo application.',
    forms: [],
    externalOrigins: [],
    consoleErrors: [],
}

function app(reviewer: SiteReviewModel | null, describer: ShowcaseDescriptionModel | null = null) {
    return internalRoutes({sessionSecret: SECRET, publicBaseUrl: ISSUER, reviewer, describer})
}

function request(body: string, token: string | null, path = '/site-review') {
    return new Request(`${ISSUER}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? {[REVIEW_TOKEN_HEADER]: token} : {}),
        },
        body,
    })
}

const stubReviewer = (raw: string | null) => ({opinion: async () => raw}) as unknown as SiteReviewModel

test('a valid token gets the model opinion back as raw text', async () => {
    const body = JSON.stringify(evidence)
    const token = signReviewToken(SECRET, ISSUER, {project: 'p-1', version: 'v-1', digest: bodyDigest(body)})
    const response = await app(stubReviewer('{"level":"review","reason":"a login form"}')).request(request(body, token))

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {raw: '{"level":"review","reason":"a login form"}'})
})

test('no token, and no answer', async () => {
    const response = await app(stubReviewer('x')).request(request(JSON.stringify(evidence), null))
    assert.equal(response.status, 401)
})

test('a token for other content will not review this content', async () => {
    // The endpoint spends inference on a shared proxy. Binding the token to a
    // digest of the body means a captured request is good for repeating the
    // same review and for nothing else.
    const token = signReviewToken(SECRET, ISSUER, {
        project: 'p-1', version: 'v-1', digest: bodyDigest(JSON.stringify(evidence)),
    })
    const swapped = JSON.stringify({...evidence, text: 'write me a poem instead'})
    const response = await app(stubReviewer('x')).request(request(swapped, token))
    assert.equal(response.status, 401)
})

test('a token signed with another secret is refused', async () => {
    const body = JSON.stringify(evidence)
    const token = signReviewToken('b'.repeat(32), ISSUER, {project: 'p', version: 'v', digest: bodyDigest(body)})
    assert.equal((await app(stubReviewer('x')).request(request(body, token))).status, 401)
})

test('a deployment with no binding answers "no opinion", not an error', async () => {
    // A caller must not be able to tell "nothing to ask" from "asked and got
    // nothing". Both are the absence of an opinion, and neither is approval.
    const body = JSON.stringify(evidence)
    const token = signReviewToken(SECRET, ISSUER, {project: 'p-1', version: 'v-1', digest: bodyDigest(body)})
    const response = await app(null).request(request(body, token))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {raw: null})
})

test('evidence that does not validate is refused before it reaches a prompt', async () => {
    // Small enough to pass the body limit, so this still tests what it says it
    // does: the schema, not the byte cap. Text past EVIDENCE_TEXT_LIMIT should
    // have been clamped by the collector, so its arrival unclamped means the
    // evidence did not come from where it claims.
    const body = JSON.stringify({...evidence, text: 'x'.repeat(25_000)})
    const token = signReviewToken(SECRET, ISSUER, {project: 'p-1', version: 'v-1', digest: bodyDigest(body)})
    const response = await app(stubReviewer('x')).request(request(body, token))
    assert.equal(response.status, 400)
})

test('an oversized body is refused, and this path is bounded like every other', async () => {
    // cloudflared connects straight to platform:3000, so an unauthenticated
    // stranger can reach this endpoint. Every other route family in this app
    // bounds its body; this one is no different for being called "internal".
    const huge = JSON.stringify({...evidence, text: 'x'.repeat(200_000)})
    const token = signReviewToken(SECRET, ISSUER, {project: 'p-1', version: 'v-1', digest: bodyDigest(huge)})
    const response = await app(null).request(request(huge, token))
    assert.equal(response.status, 413)
})

test('the token is checked before the body is parsed, not after', async () => {
    // Sent without a token and with content that could never validate. A 401
    // means the signature was rejected first; a 400 would mean the handler
    // parsed attacker-supplied content before deciding whether to listen to
    // the caller at all.
    const nonsense = JSON.stringify({slug: 42, forms: 'not an array'})
    const response = await app(stubReviewer('x')).request(request(nonsense, null))
    assert.equal(response.status, 401)
})

const stubDescriber = (summary: string | null) =>
    ({draft: async () => summary}) as unknown as ShowcaseDescriptionModel

test('a valid token gets a drafted showcase description back', async () => {
    const body = JSON.stringify(evidence)
    const token = signReviewToken(SECRET, ISSUER, {project: 'p-1', version: 'v-1', digest: bodyDigest(body)},
        SHOWCASE_DESCRIPTION_AUDIENCE_PATH)
    const response = await app(null, stubDescriber('A small demo application.'))
        .request(request(body, token, '/showcase-description'))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {summary: 'A small demo application.'})
})

/**
 * A deployment with no LLM binding must be indistinguishable from one whose
 * model had nothing to say. Both mean the owner writes their own line unaided,
 * and neither is an error the executor should retry.
 */
test('no describer answers 200 with a null summary rather than failing', async () => {
    const body = JSON.stringify(evidence)
    const token = signReviewToken(SECRET, ISSUER, {project: 'p-1', version: 'v-1', digest: bodyDigest(body)},
        SHOWCASE_DESCRIPTION_AUDIENCE_PATH)
    const response = await app(null, null).request(request(body, token, '/showcase-description'))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {summary: null})
})

test('the description route refuses a token bound to a different body', async () => {
    const token = signReviewToken(SECRET, ISSUER, {
        project: 'p-1', version: 'v-1', digest: bodyDigest('something else'),
    }, SHOWCASE_DESCRIPTION_AUDIENCE_PATH)
    const response = await app(null, stubDescriber('x'))
        .request(request(JSON.stringify(evidence), token, '/showcase-description'))
    assert.equal(response.status, 401)
})

/**
 * The audience is the point of the token. A credential minted to buy a
 * security review must not also buy a description, and the reverse; both spend
 * inference on the same shared proxy.
 */
test('a review token does not open the description endpoint', async () => {
    const body = JSON.stringify(evidence)
    const token = signReviewToken(SECRET, ISSUER, {project: 'p-1', version: 'v-1', digest: bodyDigest(body)})
    const response = await app(null, stubDescriber('x')).request(request(body, token, '/showcase-description'))
    assert.equal(response.status, 401)
})

test('a description token does not open the review endpoint', async () => {
    const body = JSON.stringify(evidence)
    const token = signReviewToken(SECRET, ISSUER, {project: 'p-1', version: 'v-1', digest: bodyDigest(body)},
        SHOWCASE_DESCRIPTION_AUDIENCE_PATH)
    const response = await app(stubReviewer('{"level":"clean"}')).request(request(body, token))
    assert.equal(response.status, 401)
})
