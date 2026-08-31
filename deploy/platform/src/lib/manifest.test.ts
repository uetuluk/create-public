import assert from 'node:assert/strict'
import {test} from 'node:test'
import {siteManifestSchema} from './manifest'

test('accepts a static site with optional managed resources', () => {
    const parsed = siteManifestSchema.parse({
        schemaVersion: 1,
        build: {command: 'npm run build', output: 'dist', spa: true},
        resources: {postgres: true, storage: true},
    })
    assert.equal(parsed.build?.output, 'dist')
})

test('accepts an HTTP function project', () => {
    const parsed = siteManifestSchema.parse({
        schemaVersion: 1,
        functions: {entrypoint: 'functions/index.ts', mount: '/api'},
        resources: {postgres: false, storage: false},
    })
    assert.equal(parsed.functions?.mount, '/api')
})

test('the LLM binding defaults off and round-trips when requested', () => {
    const implicit = siteManifestSchema.parse({
        schemaVersion: 1,
        functions: {entrypoint: 'functions/index.ts'},
        resources: {postgres: false, storage: false},
    })
    assert.equal(implicit.resources.llm, false)
    const explicit = siteManifestSchema.parse({
        schemaVersion: 1,
        functions: {entrypoint: 'functions/index.ts'},
        resources: {postgres: false, storage: false, llm: true},
    })
    assert.equal(explicit.resources.llm, true)
})

test('rejects path traversal and migrations without PostgreSQL', () => {
    assert.throws(() => siteManifestSchema.parse({
        schemaVersion: 1,
        build: {command: 'npm run build', output: '../host'},
    }))
    assert.throws(() => siteManifestSchema.parse({
        schemaVersion: 1,
        functions: {entrypoint: 'functions/index.ts', mount: '/api'},
        database: {migrations: 'migrations'},
        resources: {postgres: false, storage: false},
    }))
})
