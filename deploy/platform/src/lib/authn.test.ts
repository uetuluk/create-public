import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TokenService} from './authn'

test('RS256 access tokens and host-scoped site sessions verify', () => {
    const tokens = new TokenService({
        issuer: 'https://sites.example.test',
        resource: 'https://sites.example.test/mcp',
        sessionSecret: 'test-session-secret',
    })
    const principal = {
        accountId: '870e4621-b01e-4a38-b040-e3872efbbc06',
        email: 'student@example.edu',
        displayName: 'Student',
        role: 'user' as const,
        scopes: ['sites:read' as const],
    }
    const access = tokens.verifyAccess(tokens.signAccess(principal))
    assert.equal(access.email, principal.email)
    assert.deepEqual(access.scopes, ['sites:read'])
    const site = tokens.signSession({...principal, scopes: undefined} as any, 'site', 'project-id')
    assert.equal(tokens.verifySession(site, 'site', 'project-id').accountId, principal.accountId)
    assert.equal(tokens.jwks().keys[0].alg, 'RS256')
})
