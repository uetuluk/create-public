/**
 * Who this installation is.
 *
 * Every value here answers the same question — "what host is this?" — and each
 * one used to be answered separately, at twelve call sites, by
 * `env.GATEWAY_DOMAIN ?? '<a hardcoded domain>'`. Twelve copies of a default is
 * twelve chances for a deployment to be half-configured: set the variable and
 * most of the platform moves, while whichever site was missed keeps quietly
 * naming someone else's installation in a URL, a mail header, or a health
 * probe. The bug that produces is not a crash but a wrong answer, which is the
 * kind this codebase is least able to notice.
 *
 * So the derivation happens once, at the three entry points that already take
 * an `env` — `startPlatform`, `startGateway`, `new Executor` — plus the monitor,
 * and everything downstream receives plain strings through the deps object it
 * already had. This is the third `fromEnv` factory in `lib/`, alongside
 * `smtpConfigFromEnv` and `LlmService.fromEnv`, and deliberately not a new
 * configuration system.
 */

import {analyticsTimeZoneFromEnv} from './analytics'

export interface DeploymentConfig {
    /**
     * The apex this installation answers on. Project sites are labels beneath
     * it, so it is also the wildcard's parent.
     */
    domain: string
    /** Absolute origin for links that leave the process. Never trailing-slashed. */
    publicBaseUrl: string
    /**
     * The name the platform's own alert mail announces in HELO.
     *
     * Not necessarily `domain`: a host relaying its own mail must announce a
     * name whose forward DNS it actually owns, and on a tunnelled deployment
     * the public domain is not that name.
     */
    heloName: string
    /** Envelope sender for alert mail. */
    alertFrom: string
    /** IANA zone visits are bucketed by day in. See lib/analytics. */
    analyticsTimeZone: string
}

export interface DeploymentOverrides {
    gatewayDomain?: string
    publicBaseUrl?: string
}

/**
 * Absent means absent, and an empty string is absent.
 *
 * `??` is the wrong test for anything arriving from Compose. A variable listed
 * as `${FOO:-}` and left unset reaches the container as `FOO=""`, not as an
 * unset name, so a nullish check accepts the empty string and every fallback
 * below it is skipped — yielding a HELO of `""` rather than the domain. That
 * failure is invisible until a mail server rejects the greeting.
 */
function present(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

/**
 * `overrides` exists for `PlatformServerOptions`, which lets a test or the
 * integration script pass a domain without reaching through the environment.
 */
export function deploymentFromEnv(env: NodeJS.ProcessEnv, overrides: DeploymentOverrides = {}): DeploymentConfig {
    const domain = present(overrides.gatewayDomain) ?? present(env.GATEWAY_DOMAIN)
    if (!domain) {
        throw new Error(
            'missing required env: GATEWAY_DOMAIN — the domain this installation answers on, e.g. sites.example.org',
        )
    }
    const publicBaseUrl = (present(overrides.publicBaseUrl) ?? present(env.PUBLIC_BASE_URL) ?? `https://${domain}`)
        .replace(/\/+$/, '')
    return {
        domain,
        publicBaseUrl,
        // SMTP_HELO_NAME is the platform's own override; MAIL_HELO_NAME is the
        // relay container's hostname, and is the right answer when the platform
        // has no opinion of its own, because that is the name the relay will
        // present downstream anyway.
        heloName: present(env.SMTP_HELO_NAME) ?? present(env.MAIL_HELO_NAME) ?? domain,
        alertFrom: present(env.ALERT_FROM) ?? `create-platform@${domain}`,
        analyticsTimeZone: analyticsTimeZoneFromEnv(env),
    }
}
