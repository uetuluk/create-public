import {cloudflareMailerFromEnv} from './mail-cloudflare'
import {redactSmtpError, sendMail, smtpConfigFromEnv, type Mail} from './smtp'

/**
 * How this installation gets an alert out of the building.
 *
 * There was one answer before — open a socket to a relay and speak SMTP — and
 * it is a fine answer on a host that can reach port 25. Plenty cannot. Most
 * cloud providers block outbound 25 by default and lift it only on request,
 * which is not a thing an adopter can be told to arrange before their platform
 * will alert them about itself.
 *
 * So the transport is chosen rather than assumed. Both implementations answer
 * the same two questions — send this, and describe yourself for a log line —
 * and the monitor holds one or holds nothing, instead of holding an SMTP config
 * and a function that takes one.
 */
export interface Mailer {
    send(mail: Mail): Promise<void>
    /** What this is, for the log line that says why alerts are not arriving. */
    readonly describe: string
    /** Strips anything credential-shaped out of a failure before it is stored. */
    redact(error: unknown): string
}

export type MailTransport = 'smtp' | 'cloudflare'

function parseTransport(raw: string | undefined): MailTransport | undefined {
    const value = raw?.trim().toLowerCase()
    if (!value) return undefined
    if (value === 'smtp' || value === 'cloudflare') return value
    throw new Error(`MAIL_TRANSPORT must be "smtp" or "cloudflare"; got ${JSON.stringify(raw)}`)
}

/**
 * Returns null when nothing is configured, which is a supported state: the
 * monitor still evaluates every rule and records every transition, it just has
 * nowhere to post them. An installation with no mail is worth running; an
 * installation that silently thinks it has mail is not.
 *
 * With `MAIL_TRANSPORT` unset the choice falls out of what was configured,
 * preferring Cloudflare only when SMTP was not set up — so an existing
 * installation keeps the transport it already had without editing anything.
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv, heloName: string): Mailer | null {
    const requested = parseTransport(env.MAIL_TRANSPORT)

    if (requested !== 'smtp') {
        const cloudflare = cloudflareMailerFromEnv(env)
        if (cloudflare) return cloudflare
        if (requested === 'cloudflare') {
            throw new Error(
                'MAIL_TRANSPORT=cloudflare requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_TOKEN',
            )
        }
    }

    const config = smtpConfigFromEnv(env, heloName)
    if (config) {
        return {
            send: mail => sendMail(config, mail),
            describe: `smtp ${config.host}:${config.port}`,
            redact: error => redactSmtpError(error, config),
        }
    }

    if (requested === 'smtp') {
        throw new Error('MAIL_TRANSPORT=smtp requires SMTP_HOST')
    }
    return null
}
