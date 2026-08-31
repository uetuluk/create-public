import assert from 'node:assert/strict'
import test from 'node:test'
import {parseProbeRequest} from './probe'

test('the caller supplies a path and never a host', () => {
    // This is the property that makes the probe safe: the target host is
    // derived from the project and version the caller owns, so the tool cannot
    // become a general-purpose fetcher.
    for (const path of [
        'http://169.254.169.254/latest/meta-data/',
        'https://sites.example.test/v1/projects',
        '//evil.example/x',
        'api/tasks',
        '',
    ]) {
        assert.throws(() => parseProbeRequest({path}), /must start with|must not start with/, JSON.stringify(path))
    }
})

test('a normal request is accepted with sensible defaults', () => {
    assert.deepEqual(parseProbeRequest({path: '/api/tasks'}), {
        path: '/api/tasks',
        method: 'GET',
        headers: {},
        body: null,
    })
})

test('methods are limited to the ordinary set and normalised', () => {
    assert.equal(parseProbeRequest({path: '/', method: 'post'}).method, 'POST')
    for (const method of ['CONNECT', 'TRACE', 'OPTIONS', 'BREW']) {
        assert.throws(() => parseProbeRequest({path: '/', method}), /method must be one of/, method)
    }
})

test('platform-controlled headers cannot be overridden', () => {
    // Setting any of these would let a caller retarget the request or forge the
    // gateway's own trust signals.
    for (const name of [
        'host',
        'Host',
        'x-ritsdev-render-host',
        'X-Ritsdev-Render-Token',
        'x-ritsdev-runtime-token',
        'x-forwarded-for',
        'cookie',
    ]) {
        assert.throws(
            () => parseProbeRequest({path: '/', headers: {[name]: 'anything'}}),
            /set by the platform/,
            name,
        )
    }
})

test('header injection through CRLF is refused', () => {
    assert.throws(() => parseProbeRequest({path: '/', headers: {'x-a': 'v\r\nx-b: c'}}), /control character/)
    assert.throws(() => parseProbeRequest({path: '/a\r\nHost: evil'}), /control character/)
    assert.throws(() => parseProbeRequest({path: '/', headers: {'bad name': 'v'}}), /invalid header name/)
})

test('an ordinary header is kept, lowercased', () => {
    const request = parseProbeRequest({path: '/', headers: {'Content-Type': 'application/json'}})
    assert.deepEqual(request.headers, {'content-type': 'application/json'})
})

test('bodies are limited and refused where they make no sense', () => {
    assert.equal(parseProbeRequest({path: '/', method: 'POST', body: '{"a":1}'}).body, '{"a":1}')
    assert.throws(() => parseProbeRequest({path: '/', method: 'GET', body: 'x'}), /cannot carry a body/)
    assert.throws(() => parseProbeRequest({path: '/', method: 'POST', body: 'x'.repeat(300_000)}), /body exceeds/)
    assert.throws(() => parseProbeRequest({path: '/', method: 'POST', body: {} as unknown}), /body must be a string/)
})
