import {connect as tlsConnect, type TLSSocket} from 'node:tls'
import {connect as netConnect, type Socket} from 'node:net'

/**
 * A minimal SMTP client, enough to hand a message to one configured relay.
 *
 * Hand-rolled rather than pulling in a mail library because the surface really
 * is small: one operator-configured server, a fixed operator recipient list,
 * plain text bodies, and nothing untrusted parsed beyond three-digit response
 * codes. What it must never do is fail open, so the rules below are enforced
 * rather than merely intended:
 *
 *   - STARTTLS never silently falls back to plaintext. If an upgrade is asked
 *     for and the server does not offer it, or the upgrade fails, the send is
 *     abandoned before AUTH and before DATA. Quietly continuing in the clear is
 *     the classic hand-rolled-SMTP bug and it leaks the relay password.
 *   - AUTH is never written on an unencrypted socket.
 *   - Plaintext requires an explicit opt-in, so the local-only hop this
 *     platform uses is a recorded decision rather than an accident.
 *   - Header values are rejected for CR or LF before a byte is written, since
 *     a project slug reaches the subject line.
 */

export type SmtpMode = 'implicit' | 'starttls' | 'none'

export interface SmtpConfig {
    host: string
    port: number
    mode: SmtpMode
    user?: string
    password?: string
    allowPlaintext: boolean
    heloName: string
    timeoutMs: number
}

export interface Mail {
    from: string
    to: string[]
    subject: string
    body: string
}

/** Thrown with the protocol stage attached, so a failure says where it failed. */
export class SmtpError extends Error {
    constructor(readonly stage: string, message: string) {
        super(`smtp ${stage}: ${message}`)
        this.name = 'SmtpError'
    }
}

/**
 * `heloName` is a parameter rather than another environment read because the
 * name this host announces is a fact about the deployment, not about the
 * relay. Deriving it here would make "which domain is this?" a precondition of
 * describing a mail transport, so an installation with no SMTP at all would
 * still fail on a missing domain.
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv, heloName: string): SmtpConfig | null {
    const host = env.SMTP_HOST
    if (!host) return null
    const mode = (env.SMTP_TLS ?? 'implicit') as SmtpMode
    if (!['implicit', 'starttls', 'none'].includes(mode)) {
        throw new Error(`SMTP_TLS must be implicit, starttls, or none; got ${JSON.stringify(mode)}`)
    }
    const allowPlaintext = env.SMTP_ALLOW_PLAINTEXT === '1'
    if (mode === 'none' && !allowPlaintext) {
        throw new Error('SMTP_TLS=none requires SMTP_ALLOW_PLAINTEXT=1, so an unencrypted relay is a deliberate choice')
    }
    return {
        host,
        port: Number(env.SMTP_PORT ?? (mode === 'implicit' ? 465 : 25)),
        mode,
        user: env.SMTP_USER || undefined,
        password: env.SMTP_PASSWORD || undefined,
        allowPlaintext,
        heloName,
        timeoutMs: Number(env.SMTP_TIMEOUT_MS ?? 20_000),
    }
}

const HEADER_UNSAFE = /[\r\n\0]/

export function assertHeaderSafe(field: string, value: string): void {
    if (HEADER_UNSAFE.test(value)) {
        throw new SmtpError('compose', `${field} contains a line break, which would allow header injection`)
    }
}

/** RFC 2047 for a subject that is not pure ASCII. */
export function encodeSubject(subject: string): string {
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7e]*$/.test(subject)) return subject
    return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
}

export function composeMessage(mail: Mail, date = new Date(0)): string {
    assertHeaderSafe('from', mail.from)
    for (const recipient of mail.to) assertHeaderSafe('to', recipient)
    assertHeaderSafe('subject', mail.subject)
    // base64 body: no line can begin with a dot and none exceeds 76 characters,
    // which sidesteps both dot-stuffing and the line-length limit. Transport
    // level dot-stuffing is still applied, as defence in depth.
    const encoded = Buffer.from(mail.body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
    return [
        `From: ${mail.from}`,
        `To: ${mail.to.join(', ')}`,
        `Subject: ${encodeSubject(mail.subject)}`,
        `Date: ${date.toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        encoded,
    ].join('\r\n')
}

/** Escapes a leading dot on any line, per RFC 5321. */
export function dotStuff(payload: string): string {
    return payload.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        .split('\n').map(line => (line.startsWith('.') ? `.${line}` : line)).join('\r\n')
}

export function parseCapabilities(greeting: string): Set<string> {
    const capabilities = new Set<string>()
    for (const line of greeting.split(/\r?\n/)) {
        const match = /^250[ -](.+)$/.exec(line.trim())
        if (match) capabilities.add(match[1].trim().toUpperCase().split(/\s+/)[0])
    }
    return capabilities
}

type Conversation = {
    send(command: string, stage: string, expect?: number): Promise<string>
    upgrade(): Promise<void>
    secure(): boolean
    close(): void
}

export type ConnectFn = (config: SmtpConfig) => Promise<Conversation>

/** Reads one SMTP reply: a final line is `NNN ` with a space, not a hyphen. */
export function isCompleteReply(buffer: string): boolean {
    const lines = buffer.split(/\r\n/).filter(Boolean)
    if (!lines.length) return false
    return /^\d{3} /.test(lines[lines.length - 1])
}

export function replyCode(buffer: string): number {
    const lines = buffer.split(/\r\n/).filter(Boolean)
    const last = lines[lines.length - 1] ?? ''
    return Number(last.slice(0, 3))
}

const MAX_REPLY_BYTES = 64 * 1024

function conversation(socket: Socket | TLSSocket, config: SmtpConfig): Conversation {
    let current: Socket | TLSSocket = socket
    let secure = config.mode === 'implicit'
    let buffer = ''
    let pending: {resolve: (value: string) => void; reject: (error: Error) => void; stage: string} | null = null

    const attach = (target: Socket | TLSSocket) => {
        target.setEncoding('utf8')
        target.on('data', chunk => {
            buffer += chunk
            if (buffer.length > MAX_REPLY_BYTES) {
                pending?.reject(new SmtpError(pending.stage, 'reply exceeded the size cap'))
                pending = null
                target.destroy()
                return
            }
            if (pending && isCompleteReply(buffer)) {
                const reply = buffer
                buffer = ''
                const waiter = pending
                pending = null
                waiter.resolve(reply)
            }
        })
        target.on('error', error => {
            pending?.reject(new SmtpError(pending.stage, error.message))
            pending = null
        })
    }
    attach(current)

    const read = (stage: string): Promise<string> => new Promise((resolve, reject) => {
        if (isCompleteReply(buffer)) {
            const reply = buffer
            buffer = ''
            resolve(reply)
            return
        }
        pending = {resolve, reject, stage}
    })

    return {
        secure: () => secure,
        async send(command, stage, expect = 250) {
            if (command) current.write(`${command}\r\n`)
            const reply = await read(stage)
            const code = replyCode(reply)
            if (Math.floor(code / 100) !== Math.floor(expect / 100)) {
                throw new SmtpError(stage, `server replied ${reply.trim().slice(0, 200)}`)
            }
            return reply
        },
        async upgrade() {
            await new Promise<void>((resolve, reject) => {
                const upgraded = tlsConnect({
                    socket: current as Socket,
                    servername: config.host,
                    rejectUnauthorized: true,
                    minVersion: 'TLSv1.2',
                }, () => resolve())
                upgraded.once('error', error => reject(new SmtpError('starttls', error.message)))
                current = upgraded
                attach(upgraded)
            })
            secure = true
        },
        close() {
            current.destroy()
        },
    }
}

const defaultConnect: ConnectFn = async config => await new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(new SmtpError('connect', error.message))
    if (config.mode === 'implicit') {
        const socket = tlsConnect({
            host: config.host,
            port: config.port,
            servername: config.host,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
        }, () => resolve(conversation(socket, config)))
        socket.setTimeout(config.timeoutMs, () => socket.destroy(new Error('timed out')))
        socket.once('error', onError)
        return
    }
    const socket = netConnect({host: config.host, port: config.port}, () => resolve(conversation(socket, config)))
    socket.setTimeout(config.timeoutMs, () => socket.destroy(new Error('timed out')))
    socket.once('error', onError)
})

export async function sendMail(config: SmtpConfig, mail: Mail, connect: ConnectFn = defaultConnect): Promise<void> {
    // Composed first, so header injection is refused before a socket is opened.
    const message = composeMessage(mail, new Date())
    const session = await connect(config)
    const deadline = setTimeout(() => session.close(), config.timeoutMs)
    try {
        await session.send('', 'greeting')
        let greeting = await session.send(`EHLO ${config.heloName}`, 'ehlo')
        let capabilities = parseCapabilities(greeting)

        if (config.mode === 'starttls') {
            if (!capabilities.has('STARTTLS')) {
                // Never continue in the clear: that is precisely the failure
                // mode this client exists to avoid.
                throw new SmtpError('starttls', 'the server does not advertise STARTTLS and plaintext fallback is refused')
            }
            await session.send('STARTTLS', 'starttls', 220)
            await session.upgrade()
            greeting = await session.send(`EHLO ${config.heloName}`, 'ehlo-tls')
            capabilities = parseCapabilities(greeting)
        }

        if (config.user && config.password) {
            if (!session.secure()) {
                throw new SmtpError('auth', 'refusing to authenticate over an unencrypted connection')
            }
            if (capabilities.has('AUTH')) {
                const token = Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64')
                await session.send(`AUTH PLAIN ${token}`, 'auth', 235)
            }
        }

        await session.send(`MAIL FROM:<${mail.from}>`, 'mail-from')
        for (const recipient of mail.to) {
            await session.send(`RCPT TO:<${recipient}>`, 'rcpt-to')
        }
        await session.send('DATA', 'data', 354)
        await session.send(`${dotStuff(message)}\r\n.`, 'body')
        await session.send('QUIT', 'quit', 221).catch(() => undefined)
    } finally {
        clearTimeout(deadline)
        session.close()
    }
}

/**
 * Redacts anything that could carry the relay password out of an error. The
 * AUTH blob is base64 and would otherwise be trivially reversible from a log.
 */
export function redactSmtpError(error: unknown, config: SmtpConfig | null): string {
    let text = error instanceof Error ? error.message : String(error)
    if (config?.password) text = text.split(config.password).join('[redacted]')
    return text.replace(/AUTH PLAIN \S+/gi, 'AUTH PLAIN [redacted]')
        .replace(/AUTH LOGIN \S+/gi, 'AUTH LOGIN [redacted]')
}
