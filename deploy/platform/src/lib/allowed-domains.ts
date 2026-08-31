/**
 * Who is allowed to sign in.
 *
 * This was one institution's domain, written four times into `routes/auth.ts`,
 * and it was the
 * single reason nobody else could run this platform: an adopter could set every
 * other variable correctly and still have a login that admitted nobody.
 *
 * The list is required, and an empty one is refused unless the deployment says
 * in as many words that it means to admit anybody. A sign-in gate that falls
 * open when misconfigured is the worst of the three possible behaviours — worse
 * than refusing to start, and worse than admitting nobody — because it is the
 * only one that looks like it is working.
 */

export interface AuthPolicy {
    /** Lower-cased, bare domains. Empty only when `allowAnyDomain` is true. */
    domains: readonly string[]
    /** Set deliberately, by `AUTH_ALLOW_ANY_GOOGLE_DOMAIN=1`. */
    allowAnyDomain: boolean
}

/** Split the way `parseOperatorEmails` already does, so one list format serves both. */
export function parseEmailDomains(raw: string | undefined): string[] {
    const domains = (raw ?? '')
        .split(/[\s,;]+/)
        .map(entry => entry.trim().toLowerCase())
        // A pasted value may arrive as `@example.edu` or as a whole address;
        // both mean the same domain, and admitting neither would be a login
        // that rejects everyone for a reason nothing reports.
        .map(entry => entry.replace(/^.*@/, ''))
        .filter(Boolean)
    return [...new Set(domains)]
}

export function authPolicyFromEnv(env: NodeJS.ProcessEnv): AuthPolicy {
    const domains = parseEmailDomains(env.AUTH_ALLOWED_EMAIL_DOMAINS)
    const allowAnyDomain = env.AUTH_ALLOW_ANY_GOOGLE_DOMAIN === '1'
    if (!domains.length && !allowAnyDomain) {
        throw new Error(
            'missing required env: AUTH_ALLOWED_EMAIL_DOMAINS — the email domains that may sign in, '
            + 'e.g. example.edu. To run an installation open to any Google account, '
            + 'set AUTH_ALLOW_ANY_GOOGLE_DOMAIN=1 instead.',
        )
    }
    return {domains, allowAnyDomain}
}

/**
 * Google's `hd` authorize parameter is single-valued.
 *
 * So it can only be sent when exactly one domain is configured. That is not a
 * weakening: `hd` is a hint that pre-filters the account chooser, never a
 * control — the browser can be pointed at the authorize URL without it. The
 * control is `emailAllowed` below, applied to the verified token on the way
 * back, and it runs identically whether or not the hint was sent.
 */
export function hostedDomainHint(policy: AuthPolicy): string | undefined {
    if (policy.allowAnyDomain) return undefined
    return policy.domains.length === 1 ? policy.domains[0] : undefined
}

/**
 * The actual gate.
 *
 * `hd` on the returned identity is checked against the same list rather than
 * trusted: a personal account has no `hd` at all, and an address may end in an
 * allowed domain while the account belongs to a different Workspace.
 */
export function emailAllowed(policy: AuthPolicy, email: string | undefined, hostedDomain: string | undefined): boolean {
    if (!email) return false
    const address = email.toLowerCase()
    const at = address.lastIndexOf('@')
    if (at < 0) return false
    const domain = address.slice(at + 1)
    if (!domain) return false
    if (policy.allowAnyDomain) return true
    if (!policy.domains.includes(domain)) return false
    // A Workspace account must not present one organisation's `hd` while
    // holding another's address; a consumer account presents none, and is
    // allowed only because the address itself already matched.
    return hostedDomain === undefined || hostedDomain.toLowerCase() === domain
}

/** For the sign-in card, which should say who may actually sign in. */
export function signInHint(policy: AuthPolicy): string {
    if (policy.allowAnyDomain) return 'Any Google account can publish here.'
    if (policy.domains.length === 1) return `Any verified @${policy.domains[0]} Google account can publish here.`
    const list = policy.domains.map(domain => `@${domain}`)
    const last = list.pop()
    return `Any verified ${list.join(', ')} or ${last} Google account can publish here.`
}

/** The 403 an unlisted account gets, saying what would have worked. */
export function signInRequirement(policy: AuthPolicy): string {
    if (policy.allowAnyDomain) return 'a verified Google account is required'
    if (policy.domains.length === 1) return `a verified @${policy.domains[0]} Google account is required`
    return `a verified Google account at one of ${policy.domains.map(d => `@${d}`).join(', ')} is required`
}
