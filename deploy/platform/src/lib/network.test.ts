import assert from 'node:assert/strict'
import test from 'node:test'
import {networkSubnetCandidates} from '../executor'
import {networkAllowed, parseCidrList, requiresOwnerSession} from '../gateway'

test('dynamic network pools produce deterministic non-overlapping child CIDRs', () => {
    const first = networkSubnetCandidates('192.168.68.0/22', 28, 'project-a')
    const repeated = networkSubnetCandidates('192.168.68.0/22', 28, 'project-a')

    assert.deepEqual(first, repeated)
    assert.equal(first.length, 64)
    assert.equal(new Set(first).size, 64)
    assert(first.every(subnet => /^192\.168\.(68|69|70|71)\.(?:0|16|32|48|64|80|96|112|128|144|160|176|192|208|224|240)\/28$/.test(subnet)))
})

test('dynamic network pools reject malformed or misaligned CIDRs', () => {
    assert.throws(() => networkSubnetCandidates('192.168.68.1/22', 28, 'x'), /not CIDR-aligned/)
    assert.throws(() => networkSubnetCandidates('192.168.68.0/22', 21, 'x'), /invalid child prefix/)
    assert.throws(() => networkSubnetCandidates('192.168.999.0/22', 28, 'x'), /invalid IPv4/)
})

/**
 * The showcase tier's one real regression risk. It sits above `network` on the
 * ladder, so a site set to it must still be served to the network — not sent to
 * a login page, and not exempted from the CIDR check either. Getting this wrong
 * in the widening direction publishes internal apps to anyone who can reach the
 * gateway; getting it wrong in the narrowing direction 403s every listed app on
 * the LAN.
 */
test('a showcase site is reachable exactly as a network site is', () => {
    assert.equal(requiresOwnerSession({preview: false, access: 'owner'}), true)
    assert.equal(requiresOwnerSession({preview: false, access: 'network'}), false)
    assert.equal(requiresOwnerSession({preview: false, access: 'showcase'}), false)
})

test('a preview is owner-only whatever the project access mode says', () => {
    for (const access of ['owner', 'network', 'showcase']) {
        assert.equal(requiresOwnerSession({preview: true, access}), true, access)
    }
})

/**
 * Being reachable is not the same as being exempt. `requiresOwnerSession`
 * returning false only skips the site-session redirect; the caller still has to
 * pass the network check, and this asserts the two are separate questions.
 */
test('not requiring an owner session says nothing about the network check', () => {
    const showcase = {preview: false, access: 'showcase'}
    assert.equal(requiresOwnerSession(showcase), false)
    const list = parseCidrList('10.0.0.0/8', 'NETWORK_CIDRS')
    assert.equal(networkAllowed(list, '10.1.2.3'), true)
    assert.equal(networkAllowed(list, '203.0.113.9'), false)
})
