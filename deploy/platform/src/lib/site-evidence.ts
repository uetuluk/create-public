/**
 * Turns a render container's `diagnostics.json` into `SiteEvidence`.
 *
 * The file is written inside a container that has just executed a page written
 * by the person under review, so every field here is untrusted input in both
 * shape and size. Nothing throws: a missing, malformed or hostile block
 * degrades to empty evidence, which `staticSignals` then reports as
 * `no_page_evidence` rather than as a clean page.
 *
 * The caps are the second half of that. A page can emit ten thousand forms as
 * easily as one, and every one of them would otherwise reach a prompt, a JSONB
 * column and an operator's screen.
 */
import {z} from 'zod'
import type {SiteEvidence} from './site-review'

/**
 * How much visible text is kept.
 *
 * Chosen against what it is for. The static brand check and the model both read
 * prose, and 20 000 characters is roughly 5 000 tokens: comfortably the whole
 * of any landing page anyone has deployed here, while bounding one review to a
 * few seconds on a shared 30B proxy that also serves ten projects. A limit an
 * order of magnitude larger would not catch anything a limit this size misses,
 * because a credential page that hides its pitch below 20 000 characters of
 * filler has already stopped being a credential page to a human visitor.
 *
 * It is still a bypass, and it is named as one in docs/operations.md: text
 * pushed past the cut is invisible to this review. Two things bound the damage.
 * The forms and the origins are captured whole and never truncated, so the two
 * signals that matter most — a password posting off-site, and a password
 * alongside third-party assets — cannot be dodged this way at all. And the text
 * is the *rendered* visible text, so padding it means showing 20 000 characters
 * of filler to every real visitor as well.
 */
export const EVIDENCE_TEXT_LIMIT = 20_000
export const EVIDENCE_TITLE_LIMIT = 300
export const EVIDENCE_MAX_FORMS = 25
export const EVIDENCE_MAX_INPUTS = 20
export const EVIDENCE_MAX_ORIGINS = 25
export const EVIDENCE_MAX_CONSOLE = 20
export const EVIDENCE_CONSOLE_LIMIT = 500

/** Appended by the collector, and re-appended here, so a reader knows. */
export const TRUNCATION_NOTE = `\n[truncated at ${EVIDENCE_TEXT_LIMIT} characters by the platform]`

const stringish = z.unknown().transform(value => (typeof value === 'string' ? value : ''))

const formSchema = z.object({
    action: stringish,
    method: stringish,
    inputs: z.unknown().transform(value =>
        Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string').slice(0, EVIDENCE_MAX_INPUTS)
            : []),
})

const evidenceBlockSchema = z.object({
    title: stringish,
    text: stringish,
    truncated: z.unknown().transform(value => value === true),
    forms: z.unknown().transform(value => (Array.isArray(value) ? value : [])),
    origins: z.unknown().transform(value =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []),
})

/**
 * What the internal review endpoint will accept over the wire.
 *
 * The executor has already capped everything here, but this is a network
 * boundary and the numbers bound what reaches a prompt, so they are enforced
 * again rather than assumed.
 */
export const siteEvidenceSchema = z.object({
    slug: z.string().max(64),
    host: z.string().max(255),
    status: z.number().int().nullable(),
    title: z.string().max(EVIDENCE_TITLE_LIMIT),
    text: z.string().max(EVIDENCE_TEXT_LIMIT + TRUNCATION_NOTE.length),
    forms: z.array(z.object({
        action: z.string().max(2048),
        method: z.string().max(32),
        inputs: z.array(z.string().max(64)).max(EVIDENCE_MAX_INPUTS),
    })).max(EVIDENCE_MAX_FORMS),
    externalOrigins: z.array(z.string().max(255)).max(EVIDENCE_MAX_ORIGINS),
    consoleErrors: z.array(z.string().max(EVIDENCE_CONSOLE_LIMIT)).max(EVIDENCE_MAX_CONSOLE),
})

/**
 * Truncates and marks, so a cut is visible in the record rather than implied.
 *
 * `truncatedUpstream` is the collector saying it already cut the text to fit.
 * Without it, text cut to exactly the limit in the container would arrive
 * looking like a page that happened to end there.
 */
export function clampText(value: string, truncatedUpstream = false, limit = EVIDENCE_TEXT_LIMIT): string {
    const cut = value.length > limit
    const text = cut ? value.slice(0, limit) : value
    return cut || truncatedUpstream ? text + TRUNCATION_NOTE : text
}

/**
 * Reads the evidence block a render wrote, plus the status and console entries
 * the render already recorded before this feature existed.
 */
export function siteEvidenceFrom(
    diagnostics: Record<string, unknown>,
    site: {slug: string; host: string},
): SiteEvidence {
    const block = evidenceBlockSchema.safeParse(diagnostics.evidence)
    const parsed = block.success
        ? block.data
        : {title: '', text: '', truncated: false, forms: [] as unknown[], origins: [] as string[]}

    const forms = parsed.forms.slice(0, EVIDENCE_MAX_FORMS).flatMap(raw => {
        const form = formSchema.safeParse(raw)
        return form.success ? [form.data] : []
    })

    const console_ = Array.isArray(diagnostics.console) ? diagnostics.console : []
    const consoleErrors = console_
        .filter((entry): entry is {type: string; text: string} =>
            Boolean(entry) && typeof entry === 'object'
            && typeof (entry as any).text === 'string'
            && ((entry as any).type === 'error' || (entry as any).type === 'pageerror'))
        .slice(0, EVIDENCE_MAX_CONSOLE)
        .map(entry => entry.text.slice(0, EVIDENCE_CONSOLE_LIMIT))

    return {
        slug: site.slug,
        host: site.host,
        status: typeof diagnostics.status === 'number' ? diagnostics.status : null,
        title: parsed.title.slice(0, EVIDENCE_TITLE_LIMIT),
        text: clampText(parsed.text, parsed.truncated),
        forms,
        // Deduplicated here as well as in the collector: this is what the
        // signals count, and a repeat would read as breadth that is not there.
        externalOrigins: [...new Set(parsed.origins)].slice(0, EVIDENCE_MAX_ORIGINS),
        consoleErrors,
    }
}
