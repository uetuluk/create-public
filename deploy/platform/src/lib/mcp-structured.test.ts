import assert from 'node:assert/strict'
import {test} from 'node:test'
import {structuredContentFor} from '../routes/mcp'

const isPlainObject = (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

test('array results are nested so structuredContent is never an array', () => {
    // The spec types structuredContent as a JSON object. Sending an array made
    // a validating client reject the entire tool result, which is why
    // list_projects failed for every caller regardless of how many projects
    // existed — including none.
    const projects = structuredContentFor('list_projects', [{slug: 'a'}, {slug: 'b'}])
    assert.equal(isPlainObject(projects), true)
    assert.deepEqual(projects, {projects: [{slug: 'a'}, {slug: 'b'}]})

    const logs = structuredContentFor('get_logs', [{message: 'built'}])
    assert.deepEqual(logs, {logs: [{message: 'built'}]})

    // An empty list is the case that looks most like "nothing is wrong".
    assert.deepEqual(structuredContentFor('list_projects', []), {projects: []})

    // An unrecognised array-returning tool still must not emit a bare array.
    assert.deepEqual(structuredContentFor('something_new', [1, 2]), {items: [1, 2]})
})

test('object results pass through unchanged', () => {
    const project = {slug: 'demo', status: 'ready'}
    assert.deepEqual(structuredContentFor('get_project', project), project)
})

test('non-object results are omitted rather than sent invalid', () => {
    for (const value of [undefined, null, 'text', 42, true]) {
        assert.equal(
            structuredContentFor('whatever', value), undefined,
            `${JSON.stringify(value)} is not a valid structuredContent`,
        )
    }
})
