import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {Hono} from 'hono'
import {staticRoutes} from '../routes/static'

test('public skill files cannot escape the skills subtree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ritsdev-static-'))
    const outside = await mkdtemp(join(tmpdir(), 'ritsdev-static-outside-'))
    try {
        await mkdir(join(root, 'skills', 'create-ritsdev'), {recursive: true})
        await writeFile(join(root, 'skills', 'create-ritsdev', 'SKILL.md'), '# safe')
        await writeFile(join(root, 'secret.txt'), 'repository secret')
        await writeFile(join(outside, 'secret.txt'), 'symlink secret')
        await symlink(join(outside, 'secret.txt'), join(root, 'skills', 'linked-secret.txt'))

        const app = new Hono()
        app.route('/', staticRoutes({repoRoot: root, publicBaseUrl: 'https://sites.example.test'}))

        const valid = await app.request('/skills/create-ritsdev/SKILL.md')
        assert.equal(valid.status, 200)
        assert.equal(await valid.text(), '# safe')

        for (const path of [
            '/skills/../secret.txt',
            '/skills/%2e%2e/secret.txt',
            '/skills/linked-secret.txt',
        ]) {
            assert.equal((await app.request(path)).status, 404, path)
        }
    } finally {
        await rm(root, {recursive: true, force: true})
        await rm(outside, {recursive: true, force: true})
    }
})

/**
 * The CLI ships with no compiled-in platform address, so the download has to
 * carry one. Getting the insertion point wrong is silently fatal: a `#!` line
 * is only honoured on the first line of a file, so a prelude placed above it
 * yields a binary the shell will not run.
 */
test('the CLI download is stamped with the platform that served it, below the shebang', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ritsdev-cli-'))
    try {
        await mkdir(join(root, 'cli'), {recursive: true})
        await writeFile(join(root, 'cli', 'ritsdev.cjs'), '#!/usr/bin/env node\nconsole.log(1)\n')

        const app = new Hono()
        app.route('/', staticRoutes({repoRoot: root, publicBaseUrl: 'https://sites.example.test'}))

        const body = await (await app.request('/cli')).text()
        const lines = body.split('\n')
        assert.equal(lines[0], '#!/usr/bin/env node', 'the shebang must stay on the first line')
        assert.match(lines[1], /__RITSDEV_DEFAULT_SERVER__="https:\/\/sites\.example\.test"/)
        assert.ok(body.includes('console.log(1)'), 'the bundle itself is preserved')
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})

test('a bundle without a shebang is still stamped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ritsdev-cli-'))
    try {
        await mkdir(join(root, 'cli'), {recursive: true})
        await writeFile(join(root, 'cli', 'ritsdev.cjs'), 'console.log(1)\n')

        const app = new Hono()
        app.route('/', staticRoutes({repoRoot: root, publicBaseUrl: 'https://sites.example.test'}))

        const body = await (await app.request('/cli')).text()
        assert.match(body.split('\n')[0], /__RITSDEV_DEFAULT_SERVER__/)
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})
