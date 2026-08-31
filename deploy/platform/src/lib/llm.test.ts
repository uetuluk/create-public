import assert from 'node:assert/strict'
import {test} from 'node:test'
import {keyAliasFor, LlmError, LlmService, parseDuration, parseModelList, withNoThink} from './llm'

const PROJECT = {id: '11111111-2222-3333-4444-555555555555', slug: 'demo'}

function recordingFetch(responses: Array<{status: number; body?: unknown}>) {
    const calls: Array<{url: string; headers: Record<string, string>; body: any}> = []
    const impl = (async (url: any, init: any) => {
        calls.push({url: String(url), headers: init.headers, body: JSON.parse(init.body)})
        const next = responses.shift() ?? {status: 200, body: {}}
        return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
            status: next.status,
            headers: {'content-type': 'application/json'},
        })
    }) as unknown as typeof fetch
    return {impl, calls}
}

function service(impl: typeof fetch, overrides: Record<string, unknown> = {}) {
    return new LlmService({adminKey: 'sk-admin', adminUrl: 'https://llm.test', fetchImpl: impl, ...overrides})
}

test('parseDuration accepts LiteLLM syntax and rejects anything else', () => {
    assert.equal(parseDuration('30s'), 30)
    assert.equal(parseDuration('10m'), 600)
    assert.equal(parseDuration('24h'), 86_400)
    assert.equal(parseDuration('90d'), 7_776_000)
    assert.throws(() => parseDuration('90 days'), LlmError)
    assert.throws(() => parseDuration('1w'), LlmError)
})

test('the alias is derived from the project id, so revocation never needs the key', () => {
    assert.equal(keyAliasFor(PROJECT.id), `ritsdev-${PROJECT.id}`)
})

test('mint sends the rate limits and the requested duration', async () => {
    const {impl, calls} = recordingFetch([
        {status: 200, body: {}},
        {status: 200, body: {key: 'sk-project', expires: '2027-01-01T00:00:00Z'}},
    ])
    const minted = await service(impl, {duration: '90d', model: 'Qwen3-30B-A3B-AWQ'}).mint(PROJECT, {rpm: 60, tpm: 200_000})

    // A mint clears the alias first so a restore cannot collide with itself.
    assert.equal(calls[0].url, 'https://llm.test/key/delete')
    assert.deepEqual(calls[0].body.key_aliases, [keyAliasFor(PROJECT.id)])

    const generate = calls[1]
    assert.equal(generate.url, 'https://llm.test/key/generate')
    assert.equal(generate.headers.authorization, 'Bearer sk-admin')
    assert.equal(generate.body.rpm_limit, 60)
    assert.equal(generate.body.tpm_limit, 200_000)
    assert.equal(generate.body.duration, '90d')
    assert.equal(generate.body.key_alias, keyAliasFor(PROJECT.id))
    assert.deepEqual(generate.body.models, ['Qwen3-30B-A3B-AWQ'])
    assert.equal(generate.body.metadata.project_id, PROJECT.id)

    assert.equal(minted.key, 'sk-project')
    assert.equal(minted.expiresAt?.toISOString(), '2027-01-01T00:00:00.000Z')
})

test('parseModelList trims, drops blanks, and keeps the first spelling of a repeat', () => {
    assert.deepEqual(parseModelList('a, b ,,c'), ['a', 'b', 'c'])
    assert.deepEqual(parseModelList('a,a'), ['a'])
    assert.deepEqual(parseModelList(''), [])
    assert.deepEqual(parseModelList(undefined), [])
})

test('a key is minted for every allowed model, not just the primary', async () => {
    const {impl, calls} = recordingFetch([
        {status: 200, body: {}},
        {status: 200, body: {key: 'sk-project'}},
    ])
    const llm = service(impl, {
        model: 'Qwen3-30B-A3B-AWQ',
        models: ['Qwen3-30B-A3B-AWQ', 'Qwen3.8-27B-FP8-fast'],
    })
    await llm.mint(PROJECT, {rpm: 60, tpm: 200_000})

    assert.deepEqual(calls[1].body.models, ['Qwen3-30B-A3B-AWQ', 'Qwen3.8-27B-FP8-fast'])
    // The primary is unchanged, so runtimes and the platform's own completions
    // keep sending the model they sent before the list was widened.
    assert.equal(llm.model, 'Qwen3-30B-A3B-AWQ')
})

test('the primary model is always allowed, even when the list forgets it', async () => {
    const {impl, calls} = recordingFetch([
        {status: 200, body: {}},
        {status: 200, body: {key: 'sk-platform'}},
    ])
    await service(impl, {model: 'primary', models: ['other']})
        .mintPlatformKey('site-review', {rpm: 5, tpm: 20_000})

    assert.deepEqual(calls[1].body.models, ['primary', 'other'])
})

test('an unset primary takes the first allowed model rather than the built-in default', () => {
    const {impl} = recordingFetch([])
    const llm = service(impl, {models: ['Qwen3.8-27B-FP8-fast', 'Qwen3-30B-A3B-AWQ']})
    assert.equal(llm.model, 'Qwen3.8-27B-FP8-fast')
    assert.deepEqual([...llm.models], ['Qwen3.8-27B-FP8-fast', 'Qwen3-30B-A3B-AWQ'])
})

test('no list at all still mints the single-model key every existing key carries', async () => {
    const {impl, calls} = recordingFetch([
        {status: 200, body: {}},
        {status: 200, body: {key: 'sk-project'}},
    ])
    await service(impl, {model: 'Qwen3-30B-A3B-AWQ'}).mint(PROJECT, {rpm: 1, tpm: 1})
    assert.deepEqual(calls[1].body.models, ['Qwen3-30B-A3B-AWQ'])
})

test('mint falls back to the requested duration when the proxy omits an expiry', async () => {
    const {impl} = recordingFetch([
        {status: 200, body: {}},
        {status: 200, body: {key: 'sk-project'}},
    ])
    const before = Date.now()
    const minted = await service(impl, {duration: '1h'}).mint(PROJECT, {rpm: 1, tpm: 1})
    // The expiry is stamped after `before` is sampled, so it can only ever run
    // slightly long; a generous ceiling keeps this from being clock-flaky.
    const elapsed = minted.expiresAt!.getTime() - before
    assert.ok(elapsed >= 3_600_000 && elapsed < 3_610_000, `expected ~1h, got ${elapsed}ms`)
})

test('mint joins the configured team so the proxy can also cap keys in aggregate', async () => {
    const {impl, calls} = recordingFetch([
        {status: 200, body: {}},
        {status: 200, body: {key: 'sk-project'}},
    ])
    await service(impl, {teamId: 'team-ritsdev'}).mint(PROJECT, {rpm: 1, tpm: 1})
    assert.equal(calls[1].body.team_id, 'team-ritsdev')
})

test('mint fails loudly when the proxy returns no key', async () => {
    const {impl} = recordingFetch([{status: 200, body: {}}, {status: 200, body: {}}])
    await assert.rejects(() => service(impl).mint(PROJECT, {rpm: 1, tpm: 1}), LlmError)
})

test('mint surfaces a proxy error rather than storing nothing silently', async () => {
    const {impl} = recordingFetch([{status: 200, body: {}}, {status: 401, body: {error: 'bad key'}}])
    await assert.rejects(() => service(impl).mint(PROJECT, {rpm: 1, tpm: 1}), /401/)
})

test('revoking a project that never held a key is not an error', async () => {
    const {impl} = recordingFetch([{status: 400, body: {error: 'key_alias not found'}}])
    await service(impl).revoke(PROJECT.id)
})

test('revoke still raises a genuine proxy failure', async () => {
    const {impl} = recordingFetch([{status: 500, body: {error: 'boom'}}])
    await assert.rejects(() => service(impl).revoke(PROJECT.id), /500/)
})

test('an unreachable proxy is reported as such, not as a generic crash', async () => {
    const impl = (async () => {
        throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await assert.rejects(() => service(impl).revoke(PROJECT.id), /unreachable/)
})

test('fromEnv yields null without an admin key, so the platform still starts', () => {
    assert.equal(LlmService.fromEnv({} as NodeJS.ProcessEnv), null)
    const configured = LlmService.fromEnv({
        LLM_ADMIN_KEY: 'sk-admin',
        LLM_ADMIN_URL: 'https://llm.example.test',
        LLM_MODEL: 'Qwen3-30B-A3B-AWQ',
    } as NodeJS.ProcessEnv)
    assert.equal(configured?.model, 'Qwen3-30B-A3B-AWQ')
    assert.equal(configured?.baseUrl, 'https://llm.example.test/v1')
    // A key with nowhere to send it must not fall back to somebody else's proxy.
    assert.throws(() => LlmService.fromEnv({LLM_ADMIN_KEY: 'sk-admin'} as NodeJS.ProcessEnv), /LLM_ADMIN_URL/)
})

test('an invalid configured duration is rejected at construction, not at first mint', () => {
    assert.throws(() => service((async () => new Response('{}')) as unknown as typeof fetch, {duration: '3 months'}), LlmError)
})

test('/no_think rides on the system message, leaving the user prompt untouched', () => {
    const messages = [
        {role: 'system' as const, content: 'You review sites.'},
        {role: 'user' as const, content: 'Review this.'},
    ]
    assert.deepEqual(withNoThink(messages), [
        {role: 'system', content: 'You review sites. /no_think'},
        {role: 'user', content: 'Review this.'},
    ])
    // The caller's array is never mutated; the request body is built from the copy.
    assert.equal(messages[0].content, 'You review sites.')
})

test('/no_think falls back to the user message when there is no system role', () => {
    assert.deepEqual(withNoThink([{role: 'user' as const, content: 'Write a haiku.'}]), [
        {role: 'user', content: 'Write a haiku. /no_think'},
    ])
})

test('a prompt that already asks for /no_think does not get it twice', () => {
    const messages = [{role: 'user' as const, content: 'Write a haiku. /no_think'}]
    assert.deepEqual(withNoThink(messages), messages)
})

test('the switch reaches the proxy on a real completion', async () => {
    const {impl, calls} = recordingFetch([
        {status: 200, body: {choices: [{message: {content: 'ok'}, finish_reason: 'stop'}]}},
    ])
    const answer = await service(impl).complete('sk-key', [
        {role: 'system', content: 'Be brief.'},
        {role: 'user', content: 'Hello.'},
    ])
    assert.equal(answer, 'ok')
    assert.equal(calls[0].body.messages[0].content, 'Be brief. /no_think')
    assert.equal(calls[0].body.messages[1].content, 'Hello.')
})

test('an empty content is a failure even though the status is 200', async () => {
    const {impl} = recordingFetch([
        {status: 200, body: {choices: [{message: {content: null}, finish_reason: 'length'}]}},
    ])
    assert.equal(await service(impl).complete('sk-key', [{role: 'user', content: 'Hi.'}]), null)
})
