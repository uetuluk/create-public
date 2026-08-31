import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Pool} from 'pg'
import {authRoutes} from '../routes/auth'
import {TokenService} from './authn'

const TEST_AUTH_POLICY = {domains: ['example.edu'], allowAnyDomain: false}

/**
 * The session cookie is `__Host-` prefixed, and Hono refuses to emit such a
 * cookie without Secure. Deleting it with only `{path: '/'}` therefore threw,
 * so every logout returned 500 and left the visitor signed in. The route never
 * reads the database, so a stub pool is enough to exercise it.
 */
function logoutApp() {
    return authRoutes({
        authPolicy: TEST_AUTH_POLICY,
        pool: {} as Pool,
        tokens: new TokenService({
            issuer: 'https://sites.example.test',
            resource: 'https://sites.example.test/mcp',
            sessionSecret: 'test-session-secret-that-is-long-enough',
        }),
        publicBaseUrl: 'https://sites.example.test',
    })
}

test('logout succeeds and expires the host-scoped session cookie', async () => {
    const response = await logoutApp().request('/logout', {method: 'POST'})

    assert.equal(response.status, 200, await response.text().catch(() => ''))
    const setCookie = response.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /__Host-ritsdev_session=/)
    // Attributes must match the ones used when setting it, or the browser
    // keeps the original cookie and the user stays signed in.
    assert.match(setCookie, /Secure/i)
    assert.match(setCookie, /Path=\//i)
    assert.match(setCookie, /HttpOnly/i)
    assert.doesNotMatch(setCookie, /Domain=/i)
    // Expiry in the past, or a zero Max-Age, is what actually clears it.
    assert.equal(/Max-Age=0/i.test(setCookie) || /Expires=/i.test(setCookie), true, setCookie)
})

test('logout is safe to call without a session', async () => {
    // The sign-out control is reachable on a stale page, and a signed-out
    // visitor must get a clean answer rather than a server error.
    const response = await logoutApp().request('/logout', {method: 'POST'})

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {ok: true})
})
