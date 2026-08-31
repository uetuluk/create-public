import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {readSkillResource, skillResources} from './skill-resources'

const BASE = 'https://sites.example.test'

async function repo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ritsdev-skills-'))
    await mkdir(join(root, 'skills', 'create-ritsdev', 'references'), {recursive: true})
    await writeFile(join(root, 'skills', 'create-ritsdev', 'SKILL.md'), '# skill')
    await writeFile(join(root, 'skills', 'create-ritsdev', 'references', 'site-contract.md'), '# contract')
    return root
}

test('both skill documents are listed with dereferenceable URIs', async () => {
    const root = await repo()
    try {
        const listed = skillResources(root, BASE)
        assert.equal(listed.length, 2)
        // The URI is the real public URL, so a human handed one can just open it.
        assert.equal(listed[0].uri, `${BASE}/skills/create-ritsdev/SKILL.md`)
        assert.equal(listed[0].mimeType, 'text/markdown')
        assert.ok(listed.every(resource => typeof resource.description === 'string'))
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})

test('a resource reads by URI and by short name', async () => {
    const root = await repo()
    try {
        assert.equal(readSkillResource(root, BASE, 'create-ritsdev')?.text, '# skill')
        assert.equal(readSkillResource(root, BASE, `${BASE}/skills/create-ritsdev/SKILL.md`)?.text, '# skill')
        assert.equal(readSkillResource(root, BASE, 'site-contract')?.text, '# contract')
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})

test('only allowlisted documents are reachable', async () => {
    const root = await repo()
    const outside = await mkdtemp(join(tmpdir(), 'ritsdev-skills-outside-'))
    try {
        await writeFile(join(root, 'secret.txt'), 'operator secret')
        await writeFile(join(outside, 'secret.txt'), 'symlink secret')
        await symlink(join(outside, 'secret.txt'), join(root, 'skills', 'linked.md'))
        // The allowlist means this second entry point into the repository mount
        // cannot expose anything the public HTTP route does not.
        for (const key of [
            'secret.txt',
            '../secret.txt',
            'skills/linked.md',
            `${BASE}/secret.txt`,
            `${BASE}/skills/create-ritsdev/../../secret.txt`,
            'linked',
        ]) {
            assert.equal(readSkillResource(root, BASE, key), null, key)
        }
    } finally {
        await rm(root, {recursive: true, force: true})
        await rm(outside, {recursive: true, force: true})
    }
})

test('a deployment without the repository mount lists nothing rather than throwing', () => {
    assert.deepEqual(skillResources(undefined, BASE), [])
    assert.equal(readSkillResource(undefined, BASE, 'create-ritsdev'), null)
})

test('a missing file is omitted from the listing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ritsdev-skills-partial-'))
    try {
        await mkdir(join(root, 'skills', 'create-ritsdev'), {recursive: true})
        await writeFile(join(root, 'skills', 'create-ritsdev', 'SKILL.md'), '# only one')
        const listed = skillResources(root, BASE)
        assert.equal(listed.length, 1)
        assert.equal(listed[0].name, 'create-ritsdev')
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})

test('an oversized document is truncated with a marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ritsdev-skills-big-'))
    try {
        await mkdir(join(root, 'skills', 'create-ritsdev'), {recursive: true})
        await writeFile(join(root, 'skills', 'create-ritsdev', 'SKILL.md'), 'x'.repeat(300 * 1024))
        const found = readSkillResource(root, BASE, 'create-ritsdev')
        assert.match(found!.text, /\[truncated at \d+ characters\]/)
    } finally {
        await rm(root, {recursive: true, force: true})
    }
})
