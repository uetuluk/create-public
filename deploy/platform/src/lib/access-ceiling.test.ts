import assert from 'node:assert/strict'
import {test} from 'node:test'

import {accessCeilingFor, ACCESS_RANK, parseMaxAccessMode} from './projects'

test('an installation that says nothing keeps the full ladder', () => {
    assert.equal(parseMaxAccessMode(undefined), 'showcase')
    assert.equal(parseMaxAccessMode(''), 'showcase')
    assert.equal(parseMaxAccessMode('  '), 'showcase')
})

test('a ceiling is read, however it was cased', () => {
    assert.equal(parseMaxAccessMode('owner'), 'owner')
    assert.equal(parseMaxAccessMode('NETWORK'), 'network')
    assert.equal(parseMaxAccessMode(' showcase '), 'showcase')
})

// A typo must not silently widen or narrow exposure.
test('an unknown ceiling is refused rather than guessed at', () => {
    assert.throws(() => parseMaxAccessMode('public'))
    assert.throws(() => parseMaxAccessMode('none'))
})

test('an ordinary account is held to the configured ceiling', () => {
    assert.equal(accessCeilingFor('user', 'owner'), 'owner')
    assert.equal(accessCeilingFor('user', 'network'), 'network')
    assert.equal(accessCeilingFor('user', 'showcase'), 'showcase')
})

// The reason for the exemption: a capped installation must still be able to
// carry examples chosen by the people running it. Same shape as the operator
// exemptions for project quota and immediate purge.
test('operators and superadmins are exempt, so a capped installation can still be curated', () => {
    assert.equal(accessCeilingFor('operator', 'owner'), 'showcase')
    assert.equal(accessCeilingFor('superadmin', 'owner'), 'showcase')
})

test('the ceiling is a position on the existing ladder, not a separate idea', () => {
    assert.ok(ACCESS_RANK.owner < ACCESS_RANK.network)
    assert.ok(ACCESS_RANK.network < ACCESS_RANK.showcase)
})
