import assert from 'node:assert/strict'
import test from 'node:test'
import type {Pool} from 'pg'
import type {Authenticator, TokenService} from './authn'
import type {ProjectService} from './projects'
import {authRoutes} from '../routes/auth'
import {mcpRoutes} from '../routes/mcp'
import {projectRoutes} from '../routes/projects'

const TEST_AUTH_POLICY = {domains: ['example.edu'], allowAnyDomain: false}

const oversizedJson = JSON.stringify({value: 'x'.repeat(1024 * 1024)})

test('authentication endpoints reject bodies above 64 KiB', async () => {
    const app = authRoutes({
        authPolicy: TEST_AUTH_POLICY,
        pool: {} as Pool,
        tokens: {} as TokenService,
        publicBaseUrl: 'https://sites.example.test',
    })
    const response = await app.request('/dev', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: 'x'.repeat(64 * 1024 + 1),
    })
    assert.equal(response.status, 413)
})

test('MCP rejects bodies above 1 MiB before authentication or parsing', async () => {
    const app = mcpRoutes({
        projects: {} as ProjectService,
        authenticator: {} as Authenticator,
        tokens: {} as TokenService,
        publicBaseUrl: 'https://sites.example.test',
    })
    const response = await app.request('/', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: oversizedJson,
    })
    assert.equal(response.status, 413)
})

test('project JSON routes reject bodies above 1 MiB before authentication', async () => {
    const app = projectRoutes({
        projects: {} as ProjectService,
        authenticator: {} as Authenticator,
        tokens: {} as TokenService,
    })
    const response = await app.request('/', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: oversizedJson,
    })
    assert.equal(response.status, 413)
})
