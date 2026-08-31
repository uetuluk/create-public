import assert from 'node:assert/strict'
import {test} from 'node:test'

import {deploymentFromEnv} from './deployment'

test('the domain comes from the environment', () => {
    const config = deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', GATEWAY_DOMAIN: 'sites.example.test'})
    assert.equal(config.domain, 'sites.example.test')
    assert.equal(config.publicBaseUrl, 'https://sites.example.test')
})

test('an explicit override beats the environment', () => {
    const config = deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', GATEWAY_DOMAIN: 'env.example.test'}, {gatewayDomain: 'opt.example.test'})
    assert.equal(config.domain, 'opt.example.test')
})

test('a public base url is taken as given, minus trailing slashes', () => {
    const config = deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', GATEWAY_DOMAIN: 'sites.example.test', PUBLIC_BASE_URL: 'https://front.example.test//'})
    assert.equal(config.publicBaseUrl, 'https://front.example.test')
})

// The reason `present()` exists. Compose passes a variable listed as `${FOO:-}`
// through as an empty string rather than leaving it unset, so `??` alone would
// accept `''` and skip every fallback beneath it.
test('an empty environment value is treated as absent, not as a value', () => {
    const config = deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', 
        GATEWAY_DOMAIN: 'sites.example.test',
        SMTP_HELO_NAME: '',
        MAIL_HELO_NAME: '',
        ALERT_FROM: '',
        PUBLIC_BASE_URL: '',
    })
    assert.equal(config.publicBaseUrl, 'https://sites.example.test')
    assert.equal(config.heloName, 'sites.example.test')
    assert.equal(config.alertFrom, 'create-platform@sites.example.test')
})

test('whitespace is not a value either', () => {
    const config = deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', GATEWAY_DOMAIN: 'sites.example.test', SMTP_HELO_NAME: '   '})
    assert.equal(config.heloName, 'sites.example.test')
})

test('the platform announces its own HELO name when it has one', () => {
    const config = deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', 
        GATEWAY_DOMAIN: 'sites.example.test',
        SMTP_HELO_NAME: 'mail.example.test',
        MAIL_HELO_NAME: 'relay.example.test',
    })
    assert.equal(config.heloName, 'mail.example.test')
})

// The platform and the relay should say the same thing unless told otherwise:
// the relay's hostname is a name whose forward DNS the host actually owns,
// which the public domain need not be.
test('failing that, it borrows the relay hostname before the public domain', () => {
    const config = deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', GATEWAY_DOMAIN: 'sites.example.test', MAIL_HELO_NAME: 'relay.example.test'})
    assert.equal(config.heloName, 'relay.example.test')
})

test('an explicit alert sender is kept', () => {
    const config = deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', GATEWAY_DOMAIN: 'sites.example.test', ALERT_FROM: 'ops@example.test'})
    assert.equal(config.alertFrom, 'ops@example.test')
})

// The change that lets anyone else deploy this: there is no default domain to
// silently inherit, so a half-configured installation refuses to start rather
// than quietly naming someone else's host.
test('a missing domain is refused, not defaulted', () => {
    assert.throws(() => deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC'}), /GATEWAY_DOMAIN/)
    assert.throws(() => deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', GATEWAY_DOMAIN: ''}), /GATEWAY_DOMAIN/)
    assert.throws(() => deploymentFromEnv({ANALYTICS_TIMEZONE: 'UTC', PUBLIC_BASE_URL: 'https://sites.example.test'}), /GATEWAY_DOMAIN/)
})
