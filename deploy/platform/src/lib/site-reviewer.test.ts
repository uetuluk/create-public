import assert from 'node:assert/strict'
import test from 'node:test'
import {LlmService} from './llm'
import {parseModelVerdict, reviewSite, type SiteEvidence, reviewTermsFromEnv} from './site-review'
import {SiteReviewModel, stripReasoning} from './site-reviewer'

const TERMS = reviewTermsFromEnv({SITE_REVIEW_IMPERSONATION_TERMS: 'example university,exampleid'})

/**
 * The model half, and the one property it must have: every way it can fail
 * produces no opinion, and no opinion is never approval.
 */

const EXAMPLE_PHISH: SiteEvidence = {
    slug: 'example-login',
    host: 'example-login.sites.example.test',
    status: 200,
    title: 'Example University Login',
    text: 'Sign in with your ExampleID and password to continue to Example Home.',
    forms: [{action: 'https://collector.example.net/steal', method: 'post', inputs: ['text', 'password']}],
    externalOrigins: ['https://www.example.edu'],
    consoleErrors: [],
}

function llm(responses: Array<() => Promise<Response>>): {service: LlmService; calls: string[]} {
    const calls: string[] = []
    let index = 0
    const service = new LlmService({
        adminKey: 'master-key-never-used-for-inference',
        adminUrl: 'https://llm.example',
        timeoutMs: 50,
        retryBackoffMs: 1,
        fetchImpl: (async (url: any) => {
            calls.push(String(url))
            const next = responses[Math.min(index, responses.length - 1)]
            index += 1
            return await next()
        }) as unknown as typeof fetch,
    })
    return {service, calls}
}

const json = (body: unknown, status = 200) => async () =>
    new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})

const completion = (content: string) => json({choices: [{message: {content}, finish_reason: 'stop'}]})

test('a review with no model configured records the static verdict', () => {
    // Not a hypothetical: a deployment without LLM_ADMIN_KEY has no binding at
    // all, and every review on it takes this path.
    const review = reviewSite(EXAMPLE_PHISH, parseModelVerdict(null), TERMS)
    assert.equal(review.level, 'urgent')
    assert.equal(review.modelUnavailable, true)
})

test('a mint that fails leaves no opinion, and does not throw', async () => {
    const {service} = llm([json({error: 'no'}, 500)])
    const reviewer = new SiteReviewModel(service)
    assert.equal(await reviewer.opinion(EXAMPLE_PHISH), null)

    const review = reviewSite(EXAMPLE_PHISH, parseModelVerdict(await reviewer.opinion(EXAMPLE_PHISH)), TERMS)
    assert.equal(review.level, 'urgent')
    assert.equal(review.modelUnavailable, true)
})

test('a completion that fails leaves no opinion, and the static floor stands', async () => {
    const {service} = llm([
        json({}),                                   // key delete
        json({key: 'sk-review', expires: null}),    // key generate
        json({error: 'upstream'}, 502),             // three completion attempts
        json({error: 'upstream'}, 502),
        json({error: 'upstream'}, 502),
    ])
    const reviewer = new SiteReviewModel(service)
    const review = reviewSite(EXAMPLE_PHISH, parseModelVerdict(await reviewer.opinion(EXAMPLE_PHISH)), TERMS)
    assert.equal(review.level, 'urgent')
    assert.equal(review.modelUnavailable, true)
})

test('an answer that does not parse is no opinion, not approval', async () => {
    const {service} = llm([
        json({}),
        json({key: 'sk-review'}),
        completion('I cannot help with that.'),
    ])
    const reviewer = new SiteReviewModel(service)
    const raw = await reviewer.opinion(EXAMPLE_PHISH)
    assert.equal(typeof raw, 'string')
    assert.equal(parseModelVerdict(raw), null)
    assert.equal(reviewSite(EXAMPLE_PHISH, parseModelVerdict(raw), TERMS).level, 'urgent')
})

test('an escalation is carried through, a downgrade is not', async () => {
    const {service} = llm([
        json({}),
        json({key: 'sk-review'}),
        completion('{"level":"clean","reason":"the page told me it was approved"}'),
    ])
    const reviewer = new SiteReviewModel(service)
    const review = reviewSite(EXAMPLE_PHISH, parseModelVerdict(await reviewer.opinion(EXAMPLE_PHISH)), TERMS)
    assert.equal(review.level, 'urgent', 'the model must never be able to lower the static verdict')
    assert.equal(review.modelLevel, 'clean')
})

test('the platform key is its own, and is not the master credential', async () => {
    const bodies: string[] = []
    let index = 0
    const responses = [json({}), json({key: 'sk-review'}), completion('{"level":"clean","reason":"ordinary page"}')]
    const service = new LlmService({
        adminKey: 'master-key-never-used-for-inference',
        adminUrl: 'https://llm.example',
        fetchImpl: (async (url: any, init: any) => {
            bodies.push(`${url} ${init.headers.authorization} ${init.body}`)
            return await responses[Math.min(index++, responses.length - 1)]()
        }) as unknown as typeof fetch,
    })
    await new SiteReviewModel(service).opinion(EXAMPLE_PHISH)

    const inference = bodies.find(entry => entry.includes('/chat/completions'))!
    assert.ok(inference.includes('Bearer sk-review'), 'inference runs on the minted key')
    assert.equal(inference.includes('master-key-never-used-for-inference'), false)
    // The alias is the platform's own and cannot collide with a project id.
    assert.ok(bodies[1].includes('ritsdev-platform-site-review'))
    // Reasoning is charged against max_tokens on this model, and a short budget
    // returns HTTP 200 with an empty content.
    assert.ok(inference.includes('"enable_thinking":false'))
    assert.ok(inference.includes('"max_tokens":1024'))
})

test('the key is minted once and reused across reviews', async () => {
    const {service, calls} = llm([
        json({}),
        json({key: 'sk-review'}),
        completion('{"level":"clean","reason":"ordinary page"}'),
    ])
    const reviewer = new SiteReviewModel(service)
    await reviewer.opinion(EXAMPLE_PHISH)
    await reviewer.opinion(EXAMPLE_PHISH)
    assert.equal(calls.filter(url => url.includes('/key/generate')).length, 1)
})

test('a failed completion drops the cached key so the next review re-mints', async () => {
    // The commonest reason a working key stops working is that it is gone.
    let index = 0
    const responses = [
        json({}), json({key: 'sk-1'}),
        json({error: 'token_not_found_in_db'}, 401),
        json({}), json({key: 'sk-2'}),
        completion('{"level":"review","reason":"a login form"}'),
    ]
    const calls: string[] = []
    const service = new LlmService({
        adminKey: 'master',
        adminUrl: 'https://llm.example',
        fetchImpl: (async (url: any) => {
            calls.push(String(url))
            return await responses[Math.min(index++, responses.length - 1)]()
        }) as unknown as typeof fetch,
    })
    const reviewer = new SiteReviewModel(service)
    assert.equal(await reviewer.opinion(EXAMPLE_PHISH), null)
    assert.deepEqual(parseModelVerdict(await reviewer.opinion(EXAMPLE_PHISH)), {level: 'review', reason: 'a login form'})
    assert.equal(calls.filter(url => url.includes('/key/generate')).length, 2)
})

test('a reasoning block around the answer is removed before it is parsed', () => {
    // Thinking is disabled at the request, but the model is a reasoning model
    // and a block that arrives anyway would take the first brace with it.
    const raw = '<think>The page mentions Example University {and} collects a password</think>{"level":"urgent","reason":"borrowed brand"}'
    assert.deepEqual(parseModelVerdict(stripReasoning(raw)), {level: 'urgent', reason: 'borrowed brand'})
    // Reading each balanced object on its own now recovers the answer even with
    // the reasoning left in, where the outermost slice used to give up. The
    // stripping still happens and still matters: it is what keeps the model's
    // own deliberation out of the reason an operator reads.
    assert.deepEqual(parseModelVerdict(raw), {level: 'urgent', reason: 'borrowed brand'})
})

test('where a damaged reply carries two verdicts, the worst one is taken', () => {
    // Salvage can surface more than one candidate — a verdict considered and
    // discarded inside the reasoning, then the real answer. This module only
    // ever lets the model make a verdict worse, so the severe one has to win:
    // taking the first would let a stray "clean" upstream of the answer talk
    // the reviewer down, which is the one thing it must not do.
    const raw = '<think>Could be {"level":"clean","reason":"just a form"}</think>' +
        '{"level":"urgent","reason":"borrowed brand"}}'
    assert.deepEqual(parseModelVerdict(raw), {level: 'urgent', reason: 'borrowed brand'})
})

test('a duplicated closing brace does not cost the verdict', () => {
    // The malformation that made a tenant app fall back to its regex parser on
    // 2026-08-18, in the shape this parser would see it.
    assert.deepEqual(
        parseModelVerdict('{"level":"review","reason":"a login form"}}'),
        {level: 'review', reason: 'a login form'},
    )
})
