import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import test from 'node:test'
import {promisify} from 'node:util'
import {containerStateCommand, parseContainerExit, runtimeWrapper} from '../executor'

const execFileP = promisify(execFile)

test('the generated wrapper is syntactically valid ES module source', async () => {
    // It is assembled by string concatenation and shipped verbatim into every
    // runtime, so a quoting slip here would break every deployed function at
    // once with no local signal.
    const child = execFileP('node', ['--input-type=module', '--check'])
    child.child.stdin!.end(runtimeWrapper('functions/index.ts'))
    await child
})

test('a failure loading the entrypoint names it and prints the stack', () => {
    const wrapper = runtimeWrapper('functions/index.ts')
    // Previously an exception at module scope killed the isolate with nothing
    // but "container ... is not running" reaching the operator.
    assert.match(wrapper, /failed to load function entrypoint functions\/index\.ts/)
    assert.match(wrapper, /error\.stack/)
    assert.match(wrapper, /throw error;/)
})

test('a permission-scoped env failure explains the allowlist', () => {
    const wrapper = runtimeWrapper('functions/index.ts')
    assert.match(wrapper, /Deno\.env is permission-scoped/)
    assert.match(wrapper, /set_project_secrets/)
    // Matched by name as well as message: the class is not present on every
    // Deno version the platform may pin.
    assert.match(wrapper, /error\.name === "NotCapable"/)
})

test('a handler error is caught, logged, and answered with a 500', () => {
    const wrapper = runtimeWrapper('functions/index.ts')
    assert.match(wrapper, /return await handler\(/)
    assert.match(wrapper, /status:500/)
    assert.match(wrapper, /unhandled error in/)
})

test('the schema permission error points at the migrations directory', () => {
    const wrapper = runtimeWrapper('functions/index.ts')
    assert.match(wrapper, /permission denied for schema public/)
    assert.match(wrapper, /database\.migrations/)
})

test('the wrapper still refuses a request without the internal credential', () => {
    const wrapper = runtimeWrapper('functions/index.ts')
    assert.match(wrapper, /x-ritsdev-runtime-token/)
    assert.match(wrapper, /status:403/)
})

test('a dead container is detected from its inspect state', () => {
    assert.equal(containerStateCommand('rits-runtime-x')[0], 'inspect')
    assert.ok(containerStateCommand('rits-runtime-x').includes('rits-runtime-x'))
    // Still running: keep waiting.
    assert.equal(parseContainerExit('true 0\n'), null)
    // Exited: fail immediately with the code rather than burning the budget.
    assert.equal(parseContainerExit('false 1\n'), 1)
    assert.equal(parseContainerExit('false 137'), 137)
    // Unparseable output must not be read as a healthy container.
    assert.equal(parseContainerExit('no such object'), null)
})
