import type {Mail} from './smtp'
import type {Mailer} from './mailer'

/**
 * Alert mail over Cloudflare's Email Sending REST API.
 *
 * This exists because the SMTP path is unavailable on most rented hardware:
 * providers block outbound port 25 by default and lift it by support ticket, if
 * at all. Cloudflare offers no SMTP submission endpoint either, so the two do
 * not meet in the middle — HTTPS is the only route out.
 *
 * The API is transactional-only, which suits it exactly: this sends operator
 * alerts about one installation, never anything resembling bulk mail.
 */

const DEFAULT_ENDPOINT = 'https://api.cloudflare.com/client/v4'

export interface CloudflareMailConfig {
    accountId: string
    token: string
    /** Overridable so a test never has to reach the network. */
    endpoint: string
    timeoutMs: number
    fetchImpl: typeof fetch
}

export function cloudflareMailerFromEnv(
    env: NodeJS.ProcessEnv,
    fetchImpl: typeof fetch = fetch,
): Mailer | null {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
    const token = env.CLOUDFLARE_EMAIL_TOKEN?.trim()
    if (!accountId || !token) return null
    return cloudflareMailer({
        accountId,
        token,
        endpoint: (env.CLOUDFLARE_API_BASE?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
        timeoutMs: Number(env.MAIL_TIMEOUT_MS ?? 15_000),
        fetchImpl,
    })
}

export function cloudflareMailer(config: CloudflareMailConfig): Mailer {
    const url = `${config.endpoint}/accounts/${config.accountId}/email/sending/send`
    return {
        describe: `cloudflare email sending (account ${config.accountId.slice(0, 8)}…)`,

        /**
         * The token is the only secret in play, and it is only ever a request
         * header — but a thrown `fetch` error can carry the whole request, so
         * it is stripped from anything on its way to the database.
         */
        redact(error: unknown): string {
            const text = error instanceof Error ? error.message : String(error)
            return text.split(config.token).join('[redacted]')
                .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        },

        async send(mail: Mail): Promise<void> {
            const signal = AbortSignal.timeout(config.timeoutMs)
            let response: Response
            try {
                response = await config.fetchImpl(url, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${config.token}`,
                        'content-type': 'application/json',
                    },
                    // `from` takes `address`, not `email`: that is the REST
                    // API's spelling, and differs from the Workers binding.
                    // Both bodies are sent — some clients render only text, and
                    // a text part measurably helps spam scoring.
                    body: JSON.stringify({
                        from: mail.from,
                        to: mail.to,
                        subject: mail.subject,
                        text: mail.body,
                    }),
                    signal,
                })
            } catch (error) {
                throw new Error(`cloudflare email request failed: ${error instanceof Error ? error.message : error}`)
            }

            const payload = await response.text()
            if (!response.ok) {
                throw new Error(`cloudflare email returned ${response.status}: ${summarise(payload)}`)
            }

            // A 200 is not delivery. The response reports per-recipient outcome,
            // and a permanent bounce inside a 200 would otherwise be recorded as
            // a sent alert — an alert nobody received, marked as though they had.
            const bounced = permanentBounces(payload)
            if (bounced.length) {
                throw new Error(`cloudflare email permanently bounced for ${bounced.join(', ')}`)
            }
        },
    }
}

/** Keeps an error message to something a log line and a database column can hold. */
function summarise(payload: string): string {
    const text = payload.replace(/\s+/g, ' ').trim()
    return text.length > 300 ? `${text.slice(0, 300)}…` : text || '(empty response)'
}

function permanentBounces(payload: string): string[] {
    try {
        const parsed = JSON.parse(payload) as {
            result?: {permanent_bounces?: unknown}
            permanent_bounces?: unknown
        }
        const raw = parsed.result?.permanent_bounces ?? parsed.permanent_bounces
        if (!Array.isArray(raw)) return []
        return raw.map(entry =>
            typeof entry === 'string' ? entry : String((entry as {email?: string})?.email ?? 'unknown'))
    } catch {
        // A body that will not parse is not evidence of a bounce. The status
        // code already said the request succeeded; inventing a failure here
        // would retry a message that may well have been delivered.
        return []
    }
}
