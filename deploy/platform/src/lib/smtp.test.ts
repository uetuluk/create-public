import assert from 'node:assert/strict'
import test from 'node:test'
import {
    assertHeaderSafe,
    composeMessage,
    dotStuff,
    encodeSubject,
    isCompleteReply,
    parseCapabilities,
    redactSmtpError,
    replyCode,
    sendMail,
    smtpConfigFromEnv,
    type ConnectFn,
    type SmtpConfig,
} from './smtp'

const base: SmtpConfig = {
    host: 'relay.internal', port: 25, mode: 'none', allowPlaintext: true,
    heloName: 'sites.example.test', timeoutMs: 5000,
}

/** A scripted server: each command gets the next canned reply. */
function fakeServer(replies: string[], options: {secure?: boolean; upgradeFails?: boolean} = {}) {
    const sent: string[] = []
    let index = 0
    let secure = options.secure ?? false
    const connect: ConnectFn = async () => ({
        secure: () => secure,
        async send(command, stage, expect = 250) {
            if (command) sent.push(command)
            const reply = replies[index++] ?? '250 OK'
            if (Math.floor(Number(reply.slice(0, 3)) / 100) !== Math.floor(expect / 100)) {
                throw new Error(`smtp ${stage}: ${reply}`)
            }
            return reply
        },
        async upgrade() {
            if (options.upgradeFails) throw new Error('smtp starttls: handshake failed')
            secure = true
        },
        close() {},
    })
    return {connect, sent}
}

test('a normal send produces the expected command transcript', async () => {
    const {connect, sent} = fakeServer([
        '220 relay ready', '250-relay\r\n250 SIZE 5000000',
        '250 OK', '250 OK', '354 go ahead', '250 queued', '221 bye',
    ])
    await sendMail(base, {from: 'a@example.edu', to: ['b@example.edu'], subject: 'hi', body: 'text'}, connect)
    assert.deepEqual(sent.slice(0, 4), [
        'EHLO sites.example.test',
        'MAIL FROM:<a@example.edu>',
        'RCPT TO:<b@example.edu>',
        'DATA',
    ])
    assert.match(sent[4], /Subject: hi/)
    assert.match(sent[4], /\r\n\.$/, 'the body must be terminated by a lone dot')
})

test('STARTTLS that the server does not offer aborts before AUTH', async () => {
    // The failure this client exists to prevent: continuing in the clear and
    // then writing the relay password onto an unencrypted socket.
    const {connect, sent} = fakeServer(['220 ready', '250 relay'])
    await assert.rejects(
        sendMail({...base, mode: 'starttls', user: 'u', password: 'p'},
            {from: 'a@example.edu', to: ['b@example.edu'], subject: 's', body: 'b'}, connect),
        /does not advertise STARTTLS/,
    )
    assert.ok(!sent.some(command => /AUTH/i.test(command)), 'AUTH must not be written')
    assert.ok(!sent.some(command => /DATA/i.test(command)), 'DATA must not be written')
})

test('a failed STARTTLS upgrade aborts before AUTH and before DATA', async () => {
    const {connect, sent} = fakeServer(
        ['220 ready', '250-relay\r\n250 STARTTLS', '220 go ahead'],
        {upgradeFails: true},
    )
    await assert.rejects(
        sendMail({...base, mode: 'starttls', user: 'u', password: 'p'},
            {from: 'a@example.edu', to: ['b@example.edu'], subject: 's', body: 'b'}, connect),
        /handshake failed/,
    )
    assert.ok(!sent.some(command => /AUTH|DATA/i.test(command)))
})

test('AUTH is never written on an unencrypted connection', async () => {
    const {connect, sent} = fakeServer(['220 ready', '250-relay\r\n250 AUTH PLAIN'])
    await assert.rejects(
        sendMail({...base, mode: 'none', user: 'u', password: 'p'},
            {from: 'a@example.edu', to: ['b@example.edu'], subject: 's', body: 'b'}, connect),
        /unencrypted/,
    )
    assert.ok(!sent.some(command => /AUTH/i.test(command)))
})

test('plaintext requires an explicit opt-in', () => {
    assert.throws(() => smtpConfigFromEnv({SMTP_HOST: 'relay', SMTP_TLS: 'none'}, 'mail.example.test'), /SMTP_ALLOW_PLAINTEXT=1/)
    assert.ok(smtpConfigFromEnv({SMTP_HOST: 'relay', SMTP_TLS: 'none', SMTP_ALLOW_PLAINTEXT: '1'}, 'mail.example.test'))
    assert.equal(smtpConfigFromEnv({}, 'mail.example.test'), null, 'no SMTP_HOST means no transport at all')
    assert.throws(() => smtpConfigFromEnv({SMTP_HOST: 'relay', SMTP_TLS: 'wat'}, 'mail.example.test'), /must be implicit/)
})

test('a line break in a header is refused before anything is sent', async () => {
    // A project slug reaches the subject line, so this is reachable input.
    const {connect, sent} = fakeServer(['220 ready', '250 ok'])
    await assert.rejects(
        sendMail(base, {from: 'a@example.edu', to: ['b@example.edu'], subject: 'ok\r\nBcc: evil@example.com', body: 'b'}, connect),
        /header injection/,
    )
    assert.deepEqual(sent, [], 'nothing may be written to the socket')
    assert.throws(() => assertHeaderSafe('to', 'a@b\nc@d'), /header injection/)
})

test('a body line of a single dot is stuffed', () => {
    assert.equal(dotStuff('a\r\n.\r\nb'), 'a\r\n..\r\nb')
    assert.equal(dotStuff('.leading'), '..leading')
    // Bare LF and bare CR are both normalised to CRLF.
    assert.equal(dotStuff('a\nb'), 'a\r\nb')
    assert.equal(dotStuff('a\rb'), 'a\r\nb')
})

test('the body is base64, so it cannot produce a dot-led or over-long line', () => {
    const message = composeMessage({from: 'a@example.edu', to: ['b@example.edu'], subject: 's', body: '.\n'.repeat(200)})
    assert.match(message, /Content-Transfer-Encoding: base64/)
    const body = message.split('\r\n\r\n')[1]
    for (const line of body.split('\r\n')) {
        assert.ok(line.length <= 76, `line too long: ${line.length}`)
        assert.ok(!line.startsWith('.'))
    }
})

test('a non-ASCII subject is encoded rather than sent raw', () => {
    assert.equal(encodeSubject('plain ascii'), 'plain ascii')
    assert.match(encodeSubject('café'), /^=\?UTF-8\?B\?.+\?=$/)
})

test('multiline capability replies parse, and only the final code counts', () => {
    const capabilities = parseCapabilities('250-relay greets you\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN')
    assert.ok(capabilities.has('STARTTLS'))
    assert.ok(capabilities.has('AUTH'))
    assert.ok(!isCompleteReply('250-relay\r\n'))
    assert.ok(isCompleteReply('250-relay\r\n250 done\r\n'))
    assert.equal(replyCode('250-a\r\n550 no\r\n'), 550)
})

test('an error at any stage names the stage and never leaks the password', async () => {
    const {connect} = fakeServer(['220 ready', '250 relay', '550 mailbox unavailable'])
    await assert.rejects(
        sendMail(base, {from: 'a@example.edu', to: ['b@example.edu'], subject: 's', body: 'b'}, connect),
        /mail-from/,
    )
    const config = {...base, password: 'sup3r-secret'}
    const redacted = redactSmtpError(new Error('failed with AUTH PLAIN AGF1c2VyAHN1cDNyLXNlY3JldA== for sup3r-secret'), config)
    assert.ok(!redacted.includes('sup3r-secret'))
    assert.ok(!redacted.includes('AGF1c2VyAHN1cDNyLXNlY3JldA=='))
})
