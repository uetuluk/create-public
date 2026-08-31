import assert from 'node:assert/strict'
import {test} from 'node:test'
import {HTTPException} from 'hono/http-exception'
import {requireSameOrigin} from '../routes/oauth'

const BASE = 'https://sites.example.test'

test('consent accepts submissions the browser reports as same-origin', () => {
    assert.doesNotThrow(() => requireSameOrigin('https://sites.example.test', BASE))
    // Browsers may omit Origin on a same-origin form POST.
    assert.doesNotThrow(() => requireSameOrigin(undefined, BASE))
    // An opaque origin arrives as the literal string. It says no less than an
    // absent header, which is already accepted, so rejecting it only breaks
    // legitimate clients that open the page in a sandboxed context.
    assert.doesNotThrow(() => requireSameOrigin('null', BASE))
})

test('consent still rejects a genuinely different origin', () => {
    for (const origin of [
        'https://claude.ai',
        'https://sites.example.test.evil.example',
        'http://sites.example.test',
        'https://evil.example',
    ]) {
        assert.throws(
            () => requireSameOrigin(origin, BASE),
            (error: unknown) => error instanceof HTTPException && error.status === 403,
            `${origin} must be refused`,
        )
    }
})

test('the rejection names the origin it saw', () => {
    // The consent failure was previously indistinguishable from any other
    // cross-origin refusal, which made it impossible to tell what a client had
    // actually sent. The value is the caller's own header, echoed only to them.
    assert.throws(
        () => requireSameOrigin('https://evil.example', BASE),
        /https:\/\/evil\.example/,
    )
})
