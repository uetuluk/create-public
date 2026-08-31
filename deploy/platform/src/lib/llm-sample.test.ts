/**
 * Runs the LLM function documented in `site-contract.md`.
 *
 * That sample is copy-pasted verbatim by every author who asks for the
 * binding, and it has already shipped once in a form that returned blank
 * answers with no error. Reading it out of the markdown and executing it is
 * the only way a change to the page cannot quietly break what it teaches. The
 * code it runs comes from a file in this repository and from nowhere else;
 * nothing here is reachable from a request.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'
import {transformSync} from 'esbuild'

const CONTRACT = join(
    import.meta.dirname, '..', '..', '..', '..',
    'skills', 'create-ritsdev', 'references', 'site-contract.md',
)

interface SampleHandler {
    fetch(request: Request): Promise<Response>
}

/** Loads the documented function with a fake `Deno.env` and a fake upstream. */
function loadSample(upstream: (call: number) => Response): {handler: SampleHandler; calls: () => number} {
    const markdown = readFileSync(CONTRACT, 'utf8')
    const block = [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)]
        .map(match => match[1])
        .find(code => code.includes('chat/completions'))
    assert.ok(block, 'site-contract.md no longer contains a TypeScript sample calling chat/completions')

    const js = transformSync(block, {loader: 'ts', format: 'cjs'}).code
    const env: Record<string, string> = {
        LLM_BASE_URL: 'https://llm.example.test/v1',
        LLM_API_KEY: 'sk-test',
        LLM_MODEL: 'Qwen3-30B-A3B-AWQ',
    }
    let calls = 0
    const fetchImpl = async () => upstream(calls++)
    const module_ = {exports: {} as {default?: SampleHandler}}
    // The sample reads its bindings through Deno.env at module scope, so both
    // globals have to exist before the module body runs.
    new Function('module', 'exports', 'Deno', 'fetch', js)(
        module_, module_.exports, {env: {get: (name: string) => env[name]}}, fetchImpl,
    )
    assert.ok(module_.exports.default, 'the sample must export a default fetch handler')
    return {handler: module_.exports.default, calls: () => calls}
}

function completion(): Response {
    return Response.json({choices: [{message: {content: 'hello'}, finish_reason: 'stop'}]})
}

function ask(handler: SampleHandler): Promise<Response> {
    return handler.fetch(new Request('http://site/api', {method: 'POST', body: JSON.stringify({prompt: 'hi'})}))
}

test('a transient 5xx is retried and the answer still gets through', async () => {
    const {handler, calls} = loadSample(call =>
        call < 2 ? Response.json({error: 'upstream'}, {status: 500}) : completion())
    const started = Date.now()
    const response = await ask(handler)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {text: 'hello'})
    assert.equal(calls(), 3)
    // The retries wait rather than hammering the proxy.
    assert.ok(Date.now() - started >= 1000, 'the second attempt must back off')
})

test('a 429 is passed through, never retried', async () => {
    // Retrying the rate limiter is what turns one project into a retry storm.
    const {handler, calls} = loadSample(() =>
        Response.json({error: 'rate limited'}, {status: 429, headers: {'retry-after': '60'}}))
    const response = await ask(handler)
    assert.equal(response.status, 429)
    assert.equal(calls(), 1)
    assert.equal((await response.json() as {retryAfter: string}).retryAfter, '60')
})

test('a 4xx is not retried: the same request would fail the same way', async () => {
    const {handler, calls} = loadSample(() => Response.json({error: 'bad model'}, {status: 403}))
    const response = await ask(handler)
    assert.equal(response.status, 502)
    assert.equal(calls(), 1)
})

test('retries are bounded, so a proxy outage still answers', async () => {
    const {handler, calls} = loadSample(() => Response.json({error: 'upstream'}, {status: 503}))
    const response = await ask(handler)
    assert.equal(response.status, 502)
    assert.equal(calls(), 3)
})

test('an empty completion is still reported as a failure', async () => {
    // The trap the page was rewritten for: reasoning ate the token budget and
    // the sample returned a blank string with HTTP 200.
    const {handler} = loadSample(() =>
        Response.json({choices: [{message: {content: ''}, finish_reason: 'length'}]}))
    const response = await ask(handler)
    assert.equal(response.status, 502)
    assert.equal((await response.json() as {finishReason: string}).finishReason, 'length')
})
