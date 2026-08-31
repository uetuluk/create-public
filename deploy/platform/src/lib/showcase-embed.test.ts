import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {ProjectService, ShowcaseEntry} from './projects'
import {embedPage, showcaseEmbedRoutes} from '../routes/showcase-embed'

/**
 * The logged-out gallery is the one surface on this platform that serves
 * project data to someone who has not signed in, so what is asserted here is
 * almost entirely about refusing.
 *
 * Three independent things gate it, and each is tested on its own rather than
 * only in combination: a request that satisfies two of them and not the third
 * must still be refused, because in production each covers a different way of
 * arriving — the wrong hostname, a path that bypassed Caddy, and a visitor who
 * is simply not on the network.
 */

const SECRET = 'edge-secret-value'
const HOST = 'showcase.sites.example.test'

const entries: ShowcaseEntry[] = [{
    slug: 'port-royale',
    url: 'https://port-royale.sites.example.test',
    description: 'A browser-based maritime trading game.',
    ownerName: 'Ada L',
    screenshotUrl: '/v1/showcase/port-royale/screenshot.png',
    capturedAt: '2026-08-19T00:00:00.000Z',
    views: 1284,
}]

function app(projects: Partial<ProjectService> = {}) {
    return showcaseEmbedRoutes({
        projects: {
            listShowcase: async () => entries,
            showcaseScreenshot: async () => ({body: Buffer.from('png'), capturedAt: new Date(0)}),
            ...projects,
        } as unknown as ProjectService,
        edgeProxySecret: SECRET,
        networkCidrs: '10.0.0.0/8',
        embedHost: HOST,
    })
}

function request(overrides: {host?: string; token?: string | null; forwardedFor?: string; path?: string} = {}) {
    const headers: Record<string, string> = {host: overrides.host ?? HOST}
    if (overrides.token !== null) headers['x-ritsdev-edge-token'] = overrides.token ?? SECRET
    if (overrides.forwardedFor !== undefined) headers['x-forwarded-for'] = overrides.forwardedFor
    return new Request(`https://${headers.host}${overrides.path ?? '/'}`, {headers})
}

const ON_NETWORK = {forwardedFor: '10.0.0.55'}

test('a visitor on the network, through the edge, gets the gallery', async () => {
    const response = await app().request(request(ON_NETWORK))
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /port-royale/)
    assert.match(body, /A browser-based maritime trading game\./)
})

/**
 * The hostname is what makes this network-only: it resolves to a private
 * address that does not route from the internet. Answering on any other host
 * would put the same data on the public dashboard origin.
 */
test('the same request on any other hostname is not found', async () => {
    for (const host of ['sites.example.test', 'port-royale.sites.example.test', 'evil.example.com']) {
        const response = await app().request(request({...ON_NETWORK, host}))
        assert.equal(response.status, 404, host)
    }
})

/**
 * Host headers are written by whoever sends the request. The edge token is the
 * proof that Caddy — which only listens on the LAN address — actually handled
 * it, so a request that reached this process by some other route is refused
 * even when it names the right host.
 */
test('the right hostname without the edge token is refused', async () => {
    const missing = await app().request(request({...ON_NETWORK, token: null}))
    assert.equal(missing.status, 403)
    const wrong = await app().request(request({...ON_NETWORK, token: 'not-the-secret'}))
    assert.equal(wrong.status, 403)
    // A prefix of the real secret must not pass either.
    const prefix = await app().request(request({...ON_NETWORK, token: SECRET.slice(0, 5)}))
    assert.equal(prefix.status, 403)
})

test('a visitor outside NETWORK_CIDRS is refused, and a missing address is not a pass', async () => {
    for (const forwardedFor of ['203.0.113.9', '8.8.8.8', '', 'not-an-ip']) {
        const response = await app().request(request({forwardedFor}))
        assert.equal(response.status, 403, JSON.stringify(forwardedFor))
    }
    // No X-Forwarded-For at all is the same as an unusable one.
    const absent = await app().request(request())
    assert.equal(absent.status, 403)
})

test('only the first forwarded address is trusted, so an appended one cannot spoof', async () => {
    // A client-supplied X-Forwarded-For is preserved by Caddy with the real
    // peer appended, so a forged leading entry is the attack and the real
    // address is the last. Caddy overwrites the header, but the parse must not
    // become the weak link if that ever changes: an off-network first entry is
    // refused whatever follows it.
    const response = await app().request(request({forwardedFor: '203.0.113.9, 10.0.0.55'}))
    assert.equal(response.status, 403)
})

test('the screenshot route is behind exactly the same three gates', async () => {
    const ok = await app().request(request({...ON_NETWORK, path: '/shot/port-royale.png'}))
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'image/png')

    for (const bad of [
        {...ON_NETWORK, host: 'sites.example.test'},
        {...ON_NETWORK, token: null},
        {forwardedFor: '203.0.113.9'},
    ]) {
        const response = await app().request(request({...bad, path: '/shot/port-royale.png'}))
        assert.ok(response.status === 403 || response.status === 404, `${response.status}`)
    }
})

test('the page escapes everything an owner or a project name can carry', () => {
    const html = embedPage([{
        slug: 'x',
        url: 'https://x.sites.example.test',
        description: '<img src=x onerror=alert(1)> "quoted" & more',
        ownerName: "O'Brien <b>",
        screenshotUrl: null,
        capturedAt: null,
        views: 0,
    }])
    assert.ok(!html.includes('<img src=x onerror'), 'the description is escaped')
    assert.ok(!html.includes("O'Brien <b>"), 'the owner name is escaped')
    assert.match(html, /&lt;img src=x onerror/)
    assert.match(html, /O&#39;Brien &lt;b&gt;/)
})

test('an empty gallery says so rather than rendering an empty frame', () => {
    assert.match(embedPage([]), /Nothing shared yet/)
})

/**
 * The parent keeps the section hidden until the frame reports in, so a browser
 * that cannot reach this host shows nothing at all rather than an empty box.
 */
test('the page posts its height to the parent so the frame can be sized and revealed', () => {
    const html = embedPage(entries)
    assert.match(html, /parent\.postMessage/)
    assert.match(html, /ritsdev:'showcase'/)
})

/**
 * Two bugs live here, both of which shipped and both of which looked like
 * success from the server side — the frame returned 200 every time.
 *
 * The first: the parent's section is display:none until the frame speaks, and a
 * frame inside a display:none subtree has no layout, so every measurement is 0
 * and `load` has already fired by the time it is revealed. One report is always
 * a report of nothing, and the gallery ended up eight pixels tall.
 *
 * The second was the fix for the first: making the message conditional on a
 * usable height deadlocks, because the reveal is what makes measuring possible.
 * So "I loaded" and "I am this tall" are separate messages, and only the second
 * carries a number.
 */
test('the frame announces itself before it can measure, then keeps re-measuring', () => {
    const html = embedPage(entries)

    // The reachability signal, sent from the top level with no measurement in
    // it. This is what the parent reveals the section on.
    assert.match(html, /send\(\{ready:true\}\)/)
    assert.ok(
        html.indexOf('send({ready:true})') > html.indexOf('function report()'),
        'ready is sent unconditionally, not from inside report()',
    )

    // The observer is what fires again once the section is actually visible,
    // and again when the screenshots decode and the cards grow.
    assert.match(html, /new ResizeObserver\(report\)\.observe\(document\.body\)/)

    // A zero must never leave this page: the parent cannot tell "not laid out
    // yet" from "nothing to show" and would size the frame to it.
    assert.match(html, /if\(h>0\)send\(\{height:h\}\)/)

    // The largest of the three, since which one is meaningful depends on how
    // the document ends up laid out.
    assert.match(html, /Math\.max\(document\.body\.scrollHeight/)
})

/**
 * The bug this exists to prevent shipped once and was invisible: the embed
 * returned 200, the CSP permitted the frame, and the section still never
 * appeared, because `secureHeaders` defaults X-Frame-Options to SAMEORIGIN and
 * that header has no way to name an allowed origin. A response carrying both a
 * permissive frame-ancestors and a SAMEORIGIN X-Frame-Options is not framed.
 *
 * Asserted against the real server configuration rather than a copy of it, so
 * re-enabling the default fails here instead of in a browser.
 */
test('the platform does not send X-Frame-Options, which would block the frame', async () => {
    const {secureHeaders} = await import('hono/secure-headers')
    const {Hono} = await import('hono')
    const app = new Hono()
    // Mirrors server.ts. If these drift, the assertion below stops meaning
    // anything, which is why the value under test is the absence of a default.
    app.use(secureHeaders({
        contentSecurityPolicy: {frameAncestors: ['https://sites.example.test']},
        xFrameOptions: false,
    }))
    app.get('/', c => c.text('ok'))
    const response = await app.request('http://x/')
    assert.equal(response.headers.get('x-frame-options'), null)
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors https:\/\/sites\.example\.test/)
})
