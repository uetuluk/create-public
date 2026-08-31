import assert from 'node:assert/strict'
import {test} from 'node:test'

import {cloudflareMailer, cloudflareMailerFromEnv} from './mail-cloudflare'
import {mailerFromEnv} from './mailer'

const CONFIG = {
    accountId: 'acct-0123456789',
    token: 'cf-token-secret',
    endpoint: 'https://api.example.test/client/v4',
    timeoutMs: 1_000,
}

const MAIL = {
    from: 'alerts@example.org',
    to: ['ops@example.org'],
    subject: '[warning] something',
    body: 'a rule fired',
}

function stub(response: Response | (() => Response | Promise<Response>)) {
    const calls: Array<{url: string; init: RequestInit}> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({url, init})
        return typeof response === 'function' ? await response() : response
    }) as unknown as typeof fetch
    return {calls, fetchImpl}
}

const ok = (body: unknown) => new Response(JSON.stringify(body), {status: 200})

test('a send posts to the account send endpoint with a bearer token', async () => {
    const {calls, fetchImpl} = stub(ok({result: {delivered: ['ops@example.org']}}))
    await cloudflareMailer({...CONFIG, fetchImpl}).send(MAIL)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.example.test/client/v4/accounts/acct-0123456789/email/sending/send')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer cf-token-secret')

    const body = JSON.parse(calls[0].init.body as string)
    assert.equal(body.from, 'alerts@example.org')
    assert.deepEqual(body.to, ['ops@example.org'])
    assert.equal(body.subject, '[warning] something')
    assert.equal(body.text, 'a rule fired')
})

test('an error status is reported with the body, not swallowed', async () => {
    const {fetchImpl} = stub(new Response('{"errors":[{"message":"domain not onboarded"}]}', {status: 403}))
    await assert.rejects(
        () => cloudflareMailer({...CONFIG, fetchImpl}).send(MAIL),
        /403.*domain not onboarded/s,
    )
})

/**
 * The case that makes a 200 insufficient. Recording this as sent would leave an
 * alert nobody received, marked as though they had.
 */
test('a permanent bounce inside a 200 is a failure, not a delivery', async () => {
    const {fetchImpl} = stub(ok({result: {delivered: [], permanent_bounces: ['ops@example.org']}}))
    await assert.rejects(
        () => cloudflareMailer({...CONFIG, fetchImpl}).send(MAIL),
        /permanently bounced for ops@example\.org/,
    )
})

test('a bounce reported as an object still names the address', async () => {
    const {fetchImpl} = stub(ok({permanent_bounces: [{email: 'ops@example.org'}]}))
    await assert.rejects(() => cloudflareMailer({...CONFIG, fetchImpl}).send(MAIL), /ops@example\.org/)
})

// A body that will not parse is not evidence of a bounce: the status already
// said the request succeeded, and inventing a failure would retry a message
// that may well have been delivered.
test('an unparseable success body is not treated as a bounce', async () => {
    const {fetchImpl} = stub(new Response('not json at all', {status: 200}))
    await cloudflareMailer({...CONFIG, fetchImpl}).send(MAIL)
})

test('a transport failure names the cause', async () => {
    const {fetchImpl} = stub(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')))
    await assert.rejects(() => cloudflareMailer({...CONFIG, fetchImpl}).send(MAIL), /ENOTFOUND/)
})

// The token is the only secret here, and a thrown fetch error can carry the
// whole request with it.
test('the token never reaches a stored error message', () => {
    const {fetchImpl} = stub(ok({}))
    const mailer = cloudflareMailer({...CONFIG, fetchImpl})
    const message = mailer.redact(new Error('failed with authorization: Bearer cf-token-secret'))
    assert.ok(!message.includes('cf-token-secret'), message)
    assert.match(message, /\[redacted\]/)
})

test('the description names the transport without spelling out the account', () => {
    const {fetchImpl} = stub(ok({}))
    const mailer = cloudflareMailer({...CONFIG, fetchImpl})
    assert.match(mailer.describe, /cloudflare/)
    assert.ok(!mailer.describe.includes(CONFIG.token))
})

test('cloudflare is configured only when both the account and the token are present', () => {
    assert.equal(cloudflareMailerFromEnv({}), null)
    assert.equal(cloudflareMailerFromEnv({CLOUDFLARE_ACCOUNT_ID: 'a'}), null)
    assert.equal(cloudflareMailerFromEnv({CLOUDFLARE_EMAIL_TOKEN: 't'}), null)
    assert.ok(cloudflareMailerFromEnv({CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_EMAIL_TOKEN: 't'}))
})

test('no mail configured at all is a supported state, not an error', () => {
    assert.equal(mailerFromEnv({}, 'host.example.org'), null)
})

// An existing installation must keep the transport it already had without
// editing anything.
test('SMTP is still chosen when it is what was configured', () => {
    const mailer = mailerFromEnv({SMTP_HOST: 'relay', SMTP_TLS: 'none', SMTP_ALLOW_PLAINTEXT: '1'}, 'host.example.org')
    assert.match(mailer!.describe, /^smtp relay:/)
})

test('cloudflare wins when both are configured and nothing says otherwise', () => {
    const mailer = mailerFromEnv({
        SMTP_HOST: 'relay', SMTP_TLS: 'none', SMTP_ALLOW_PLAINTEXT: '1',
        CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_EMAIL_TOKEN: 't',
    }, 'host.example.org')
    assert.match(mailer!.describe, /cloudflare/)
})

test('an explicit transport is honoured over what happens to be configured', () => {
    const mailer = mailerFromEnv({
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'relay', SMTP_TLS: 'none', SMTP_ALLOW_PLAINTEXT: '1',
        CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_EMAIL_TOKEN: 't',
    }, 'host.example.org')
    assert.match(mailer!.describe, /^smtp/)
})

// Asking for a transport and not configuring it is a mistake worth stopping
// for: the alternative is alerts silently going nowhere.
test('naming a transport that is not configured is refused, not quietly downgraded', () => {
    assert.throws(() => mailerFromEnv({MAIL_TRANSPORT: 'cloudflare'}, 'host.example.org'), /CLOUDFLARE_ACCOUNT_ID/)
    assert.throws(() => mailerFromEnv({MAIL_TRANSPORT: 'smtp'}, 'host.example.org'), /SMTP_HOST/)
    assert.throws(() => mailerFromEnv({MAIL_TRANSPORT: 'carrier-pigeon'}, 'host.example.org'), /MAIL_TRANSPORT/)
})
