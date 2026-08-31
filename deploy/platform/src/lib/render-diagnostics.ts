/**
 * Post-processing for the console output a render container captured.
 *
 * A render reaches the gateway at `http://gateway:3001`, an internal origin no
 * visitor ever sees, over plain HTTP. The gateway answers every request through
 * Hono's `secureHeaders`, which sets `Cross-Origin-Opener-Policy: same-origin`
 * and `Origin-Agent-Cluster: ?1` on every response including proxied tenant
 * ones. On that origin the browser cannot act on either header and says so, in
 * messages that name a hostname the author has never seen and end by telling
 * them to change headers they do not control. Both are artefacts of how the
 * render gets in.
 *
 * They are annotated rather than dropped. Diagnostics are the one place an
 * author looks to find out what is wrong with their page, and a filter that
 * grows a little too broad would remove real evidence without leaving a trace
 * that it had. Annotating keeps every message and its full text, and adds the
 * sentence that stops someone chasing it.
 *
 * Severity is only ever lowered, and only where the browser's own severity is
 * what misleads. The COOP message arrives typed `error`, beside errors that are
 * the author's to fix, so it is retyped. The Origin-Agent-Cluster message
 * arrives typed `warning`, which is already accurate — it keeps that type and
 * gains only the note.
 */

export interface RenderConsoleEntry {
    type: string
    text: string
    /** Present only on entries the platform annotated, explaining why. */
    note?: string
}

interface RenderPathMessage {
    /** Only an entry the browser reported with this type is considered. */
    type: string
    match: RegExp
    /** Set only where the browser's severity is itself the problem. */
    retype?: string
    note: string
}

/**
 * The messages a render provokes by existing, matched on wording taken verbatim
 * from a real `diagnostics.json` written by this platform rather than
 * paraphrased.
 *
 * Each pattern carries the clause that ties the message to the render path —
 * Chromium's untrustworthy-origin reason, and the internal origin literal — so
 * that the same class of message from a tenant's own page is left alone.
 * Chromium has other COOP messages that are a page's problem to fix
 * (`Cross-Origin-Opener-Policy policy would block the window.opener call`), a
 * page can provoke a genuine origin-keyed agent cluster warning on its own
 * origin, and a page may log whatever it likes. None of those match.
 *
 * `http://gateway:3001` is the executor's `GATEWAY_INTERNAL_URL` default. A
 * deployment that overrode it would stop matching and the message would be
 * reported exactly as the browser sent it, which is the safe direction to fail
 * in: this can never hide something by drifting.
 */
const RENDER_PATH_MESSAGES: readonly RenderPathMessage[] = [
    {
        type: 'error',
        match: /^The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy\. /,
        retype: 'note',
        note: 'Expected on the render path and not a fault in this page: the gateway sets this header on every '
            + 'response, and the internal render reaches it over plain HTTP, where — in the browser\'s own words '
            + 'above — the origin is not trusted enough for the header to be acted on. The same header is sent on '
            + 'the HTTPS address visitors use, where that reason does not apply. Reported as an error by the '
            + 'browser; downgraded here because it is not yours to fix.',
    },
    {
        type: 'warning',
        match: /^The page requested an origin-keyed agent cluster using the Origin-Agent-Cluster header, but could not be origin-keyed since the origin 'http:\/\/gateway:3001' had previously been placed in a site-keyed agent cluster\./,
        note: 'Expected on the render path and not a fault in this page: your page did not request this. The '
            + 'gateway sets Origin-Agent-Cluster on every response, and http://gateway:3001 is the internal '
            + 'address the renderer reaches the gateway on — visitors never see that origin, and the headers the '
            + 'message asks you to update are the platform\'s, not yours. Left as a warning, as the browser sent it.',
    },
]

/**
 * Annotates the console entries a render is expected to produce and leaves
 * everything else exactly as the browser reported it.
 *
 * Input comes from a JSON file written inside the render container, so it is
 * treated as untrusted shape rather than as `RenderConsoleEntry[]`.
 */
export function annotateRenderConsole(entries: unknown): RenderConsoleEntry[] {
    if (!Array.isArray(entries)) return []
    return entries.map(entry => {
        if (!entry || typeof entry !== 'object') return entry as RenderConsoleEntry
        const {type, text} = entry as {type?: unknown; text?: unknown}
        if (typeof text !== 'string') return entry as RenderConsoleEntry
        const rule = RENDER_PATH_MESSAGES.find(candidate => candidate.type === type && candidate.match.test(text))
        if (!rule) return entry as RenderConsoleEntry
        return {
            ...(entry as Record<string, unknown>),
            type: rule.retype ?? rule.type,
            text,
            note: rule.note,
        } as RenderConsoleEntry
    })
}

/**
 * Applies the annotation to a parsed `diagnostics.json`, in place, and returns
 * it. A render that produced no console array is left untouched: an absent
 * `console` key means the container never got far enough to write one, and
 * inventing an empty array here would hide that.
 */
export function annotateRenderDiagnostics(parsed: Record<string, unknown>): Record<string, unknown> {
    if (Array.isArray(parsed.console)) parsed.console = annotateRenderConsole(parsed.console)
    return parsed
}
