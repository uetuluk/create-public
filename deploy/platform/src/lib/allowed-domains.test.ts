import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
    authPolicyFromEnv,
    emailAllowed,
    hostedDomainHint,
    parseEmailDomains,
    signInHint,
    signInRequirement,
} from './allowed-domains'

const one = {domains: ['example.edu'], allowAnyDomain: false}
const two = {domains: ['example.edu', 'example.org'], allowAnyDomain: false}
const open = {domains: [], allowAnyDomain: true}

test('domains are parsed case-insensitively, however they were pasted', () => {
    assert.deepEqual(parseEmailDomains('Example.edu, @example.org ; example.net'), ['example.edu', 'example.org', 'example.net'])
    assert.deepEqual(parseEmailDomains('example.edu, example.edu'), ['example.edu'], 'duplicates collapse')
    assert.deepEqual(parseEmailDomains('@example.edu'), ['example.edu'])
    // A whole address is a plausible thing to paste into a list of domains.
    assert.deepEqual(parseEmailDomains('someone@example.edu'), ['example.edu'])
    assert.deepEqual(parseEmailDomains(''), [])
    assert.deepEqual(parseEmailDomains(undefined), [])
})

// The whole point of the variable: an installation that configures nothing must
// not quietly admit everyone.
test('an empty list is refused unless opening up is deliberate', () => {
    assert.throws(() => authPolicyFromEnv({}), /AUTH_ALLOWED_EMAIL_DOMAINS/)
    assert.throws(() => authPolicyFromEnv({AUTH_ALLOWED_EMAIL_DOMAINS: '  '}), /AUTH_ALLOWED_EMAIL_DOMAINS/)
    const opened = authPolicyFromEnv({AUTH_ALLOW_ANY_GOOGLE_DOMAIN: '1'})
    assert.equal(opened.allowAnyDomain, true)
})

test('a configured list is read', () => {
    const policy = authPolicyFromEnv({AUTH_ALLOWED_EMAIL_DOMAINS: 'example.edu,example.org'})
    assert.deepEqual(policy.domains, ['example.edu', 'example.org'])
    assert.equal(policy.allowAnyDomain, false)
})

// `hd` is single-valued, so it can only be sent for a single-domain
// installation. It is a hint that pre-filters the account chooser, never the
// control — which is why omitting it below is not a weakening.
test('the hosted-domain hint is sent only when it can be', () => {
    assert.equal(hostedDomainHint(one), 'example.edu')
    assert.equal(hostedDomainHint(two), undefined)
    assert.equal(hostedDomainHint(open), undefined)
})

test('the gate admits a listed domain and refuses anything else', () => {
    assert.ok(emailAllowed(one, 'someone@example.edu', 'example.edu'))
    assert.ok(!emailAllowed(one, 'someone@example.org', 'example.org'))
    assert.ok(!emailAllowed(one, 'someone@gmail.com', undefined))
    assert.ok(!emailAllowed(one, undefined, undefined))
    assert.ok(!emailAllowed(one, 'not-an-address', undefined))
})

// The multi-domain case is exactly where `hd` stopped being sent, so this is
// the assertion that the callback is carrying the control on its own.
test('every listed domain is admitted even though no hint was sent', () => {
    assert.ok(emailAllowed(two, 'someone@example.edu', 'example.edu'))
    assert.ok(emailAllowed(two, 'someone@example.org', 'example.org'))
    assert.ok(!emailAllowed(two, 'someone@example.net', 'example.net'))
})

test('a suffix that merely ends in a listed domain is not that domain', () => {
    assert.ok(!emailAllowed(one, 'someone@evil-example.edu', undefined))
    assert.ok(!emailAllowed(one, 'someone@example.edu.evil.test', undefined))
})

// A Workspace account must not present one organisation's `hd` while holding
// another's address.
test('a mismatched hosted domain is refused even when the address matches', () => {
    assert.ok(!emailAllowed(one, 'someone@example.edu', 'other.test'))
})

test('a consumer account carries no hosted domain, and is judged on its address', () => {
    assert.ok(emailAllowed(one, 'someone@example.edu', undefined))
})

test('an open installation admits anyone with a verified address', () => {
    assert.ok(emailAllowed(open, 'someone@gmail.com', undefined))
    assert.ok(!emailAllowed(open, undefined, undefined))
})

test('the wording says who may sign in', () => {
    assert.match(signInHint(one), /@example\.edu/)
    assert.match(signInHint(two), /@example\.edu.*@example\.org/)
    assert.match(signInHint(open), /Any Google account/)
    assert.match(signInRequirement(one), /@example\.edu/)
    assert.match(signInRequirement(two), /@example\.edu.*@example\.org/)
})
