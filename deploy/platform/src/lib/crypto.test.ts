import assert from 'node:assert/strict'
import {test} from 'node:test'
import {SecretBox, sha256} from './crypto'

test('SecretBox encrypts with a random nonce and round-trips', () => {
    const box = new SecretBox('test-only-key')
    const first = box.encrypt('database password')
    const second = box.encrypt('database password')
    assert.notEqual(first, second)
    assert.equal(box.decrypt(first), 'database password')
    assert.equal(box.decrypt(second), 'database password')
})

test('sha256 produces stable lowercase hex', () => {
    assert.equal(sha256('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
})
