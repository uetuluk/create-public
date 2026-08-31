import assert from 'node:assert/strict'
import test from 'node:test'
import {Hono} from 'hono'
import {resolveClientAddress} from './client-ip'
import {clientIp} from './client-ip'
import {rateLimit} from './rate-limit'

const TRUSTED = '192.168.64.32/28,192.168.64.80/28'
const CLOUDFLARE = '192.168.64.80/28'

test('untrusted peers cannot spoof forwarding headers', () => {
    assert.equal(resolveClientAddress({
        peerAddress: '203.0.113.9',
        forwardedFor: '198.51.100.4',
        cloudflareAddress: '198.51.100.5',
        trustedProxyCidrs: TRUSTED,
        trustedCloudflareProxyCidrs: CLOUDFLARE,
    }), '203.0.113.9')
})

test('trusted reverse proxies resolve the nearest untrusted forwarded hop', () => {
    assert.equal(resolveClientAddress({
        peerAddress: '192.168.64.35',
        forwardedFor: '198.51.100.8, 192.168.64.36',
        trustedProxyCidrs: TRUSTED,
    }), '198.51.100.8')
    assert.equal(resolveClientAddress({
        peerAddress: '::ffff:192.168.64.35',
        forwardedFor: '198.51.100.9',
        trustedProxyCidrs: TRUSTED,
    }), '198.51.100.9')
})

test('Cloudflare client header is accepted only from its separate proxy range', () => {
    assert.equal(resolveClientAddress({
        peerAddress: '192.168.64.82',
        forwardedFor: '198.51.100.10',
        cloudflareAddress: '198.51.100.11',
        trustedProxyCidrs: TRUSTED,
        trustedCloudflareProxyCidrs: CLOUDFLARE,
    }), '198.51.100.11')
    assert.equal(resolveClientAddress({
        peerAddress: '192.168.64.35',
        forwardedFor: '198.51.100.10',
        cloudflareAddress: '198.51.100.11',
        trustedProxyCidrs: TRUSTED,
        trustedCloudflareProxyCidrs: CLOUDFLARE,
    }), '198.51.100.10')
    assert.equal(resolveClientAddress({
        peerAddress: '192.168.64.82',
        cloudflareAddress: '2001:0db8:0:0:0:0:0:1',
        trustedProxyCidrs: TRUSTED,
        trustedCloudflareProxyCidrs: CLOUDFLARE,
    }), '2001:db8::1')
})

test('malformed trusted proxy configuration fails closed at startup', () => {
    assert.throws(() => resolveClientAddress({
        peerAddress: '192.168.64.35',
        forwardedFor: '198.51.100.10',
        trustedProxyCidrs: '192.168.64.999/28',
    }), /invalid IPv4 CIDR/)
})

test('rate limits cannot be evaded by rotating forwarded headers', async () => {
    const app = new Hono()
    app.use(clientIp({trustedProxyCidrs: TRUSTED}))
    app.use(rateLimit('test', 1, 60_000))
    app.get('/', c => c.text('ok'))

    const first = await app.request('/', {headers: {'x-forwarded-for': '198.51.100.1'}})
    const second = await app.request('/', {headers: {'x-forwarded-for': '198.51.100.2'}})
    assert.equal(first.status, 200)
    assert.equal(second.status, 429)
})
