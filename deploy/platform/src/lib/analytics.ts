import {createHmac} from 'node:crypto'

/**
 * Site visit analytics: what counts as a visit, who the visitor is taken to be,
 * and the SQL the gateway and the control plane share.
 *
 * Everything here is pure or a plain SQL string. The tests in this repository
 * run without a database, so the decisions worth pinning — the counting
 * predicate above all — have to be reachable without one.
 *
 * The gateway writes these rows from the request path, which is a deliberate
 * exception to the rule stated in lib/metrics.ts that no instrumentation is
 * added to hot paths. That rule is about deriving *platform metrics*, all of
 * which can be read back from tables the platform already writes. A visit is
 * not written down anywhere, so it cannot be derived; and this is product data
 * an owner asked for rather than operator telemetry. The write is never
 * awaited and yields under load, so it costs the response nothing.
 */

/**
 * The zone days are bucketed in. Required, and deliberately undefaulted.
 *
 * Nothing in compose.yaml sets `TZ`, so Node and PostgreSQL both run in UTC. A
 * day bucketed in UTC cuts the local day at whatever hour the installation
 * happens to sit at, and an owner looking at yesterday evening's traffic finds
 * it on today's bar.
 *
 * Defaulting this to UTC would be the worst available choice. It would not
 * fail: it would re-bucket every day by the installation's offset, make rows
 * written before the change incomparable with rows written after it, and leave
 * every one of them looking entirely plausible. So an installation must say
 * which zone its people are in, and `visitDay` takes the zone as a required
 * argument rather than reaching for a default that cannot be right for
 * everyone.
 */
export function analyticsTimeZoneFromEnv(env: NodeJS.ProcessEnv): string {
    const zone = env.ANALYTICS_TIMEZONE?.trim()
    if (!zone) {
        throw new Error(
            'missing required env: ANALYTICS_TIMEZONE — the IANA zone visits are bucketed by day in, '
            + 'e.g. Europe/Berlin. There is no default: UTC would silently re-bucket every day.',
        )
    }
    // Fail at startup on a zone Intl cannot resolve, rather than on the first
    // visit after a deploy.
    try {
        new Intl.DateTimeFormat('en-CA', {timeZone: zone})
    } catch {
        throw new Error(`ANALYTICS_TIMEZONE is not a valid IANA time zone: ${JSON.stringify(zone)}`)
    }
    return zone
}

/**
 * The window, and the ceiling the route clamps to.
 *
 * They are the same number on purpose. The distinct-visitor count is only
 * meaningful for as long as the pseudonyms behind it are retained, and those
 * are kept deliberately briefly. Offering a longer window would either mean
 * keeping pseudonyms around to serve it, or quietly returning a visitor figure
 * computed over a shorter span than the views beside it.
 */
export const DEFAULT_READ_DAYS = 30
export const MAX_READ_DAYS = 30

/**
 * Retention, and the reason the two numbers differ.
 *
 * `site_visitor_days` holds a pseudonym that can be tied back to a person by
 * anyone holding the salt, so it has the short life. `site_visit_days` holds
 * counts and nothing else, so it can be kept for as long as it is useful.
 *
 * Both are strictly greater than `MAX_READ_DAYS`. Pruning and reading at the
 * same boundary would race: the oldest day in a window would lose its rows part
 * way through the day it is still being displayed, and the count would sag with
 * nothing to indicate why. Asserted in the tests.
 */
export const VISITOR_RETENTION_DAYS = 35
export const VISIT_RETENTION_DAYS = 400

/**
 * Formatters are cached because constructing one is expensive and this runs on
 * every counted request. Constructing it here also means an invalid timezone
 * fails at module load rather than on a request.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
    let found = formatters.get(timeZone)
    if (!found) {
        found = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        })
        formatters.set(timeZone, found)
    }
    return found
}

/**
 * The day a visit is filed under, as `YYYY-MM-DD`.
 *
 * Computed once, here, at the moment the visit is recorded, and passed to
 * PostgreSQL as a bound parameter. No SQL in this module derives a day —
 * no `CURRENT_DATE`, no `now()::date` — and the tests assert that.
 *
 * That rule is what keeps the reader and the writer agreeing about what "today"
 * means. If the upsert bucketed in UTC and the read filtered on a locally
 * computed boundary, the two would disagree by eight hours, every row would
 * still look plausible, and nobody would notice for a month.
 *
 * It also makes a day rollover mid-request a non-issue by construction: the key
 * is fixed when the visit happens, not when it is written.
 */
export function visitDay(at: Date, timeZone: string): string {
    return formatter(timeZone).format(at)
}

/**
 * Calendar arithmetic on a `YYYY-MM-DD` string.
 *
 * Date-only, so UTC millisecond arithmetic is exact: there is no clock here to
 * be shifted by a daylight saving transition, only a count of calendar days.
 */
export function dayBefore(day: string, days: number): string {
    const [year, month, date] = day.split('-').map(Number)
    const shifted = new Date(Date.UTC(year, month - 1, date) - days * 86_400_000)
    return shifted.toISOString().slice(0, 10)
}

/** Every day in the window ending at `today`, oldest first. */
export function dayRange(today: string, days: number): string[] {
    const range: string[] = []
    for (let offset = days - 1; offset >= 0; offset -= 1) range.push(dayBefore(today, offset))
    return range
}

/**
 * The key visitor pseudonyms are derived under.
 *
 * HMAC with an explicit label rather than `sha256(SECRET_ENCRYPTION_KEY + …)`,
 * for a specific reason: SecretBox's AES key *is*
 * `createHash('sha256').update(SECRET_ENCRYPTION_KEY)` — see lib/crypto.ts — so
 * a plain sha256 derivation over the same material risks writing values derived
 * from the literal content-encryption key into a table. The label separates the
 * two domains, and the test asserts the two keys are not equal.
 */
export function analyticsKey(secret: string): Buffer {
    return createHmac('sha256', secret).update('ritsdev/site-analytics/visitor/v1').digest()
}

/**
 * Who the platform takes a visitor to be, for one project, on one day.
 *
 * Two properties are worth stating plainly, because a future reader will
 * otherwise assume more than this offers.
 *
 * It is **obfuscation with a secret, not anonymisation**. The IPv4 space is
 * enumerable in seconds and plausible user agents number in the thousands, so
 * anyone holding the key can brute-force a hash back to an address. That is
 * anyone holding `SECRET_ENCRYPTION_KEY` — who already holds every project's
 * database password. Retention is the real control, not this function.
 *
 * The hash is **per project**, so the same person visiting two projects
 * produces two unrelated values and the table cannot be used to follow anyone
 * across the platform. That is the property actually worth having.
 *
 * The fields are joined with a separator rather than concatenated so that
 * ('a', 'bc') and ('ab', 'c') cannot collide; HMAC's own framing makes this
 * belt-and-braces, and the test pins it either way.
 */
export function visitorHash(key: Buffer, projectId: string, address: string, userAgent: string): Buffer {
    return createHmac('sha256', key)
        .update([projectId, address, userAgent].join('\n'))
        .digest()
        .subarray(0, 16)
}

export type VisitSignals = {
    method: string
    status: number
    contentType: string
    secFetchDest?: string | null
    secPurpose?: string | null
    purpose?: string | null
    xMoz?: string | null
    accept?: string | null
    /** A `--v-` hostname: an undeployed version its owner is testing. */
    preview: boolean
    /** Carries a valid internal render token, so it is the screenshot renderer. */
    internalRender: boolean
    /** Carries the owner's own site session. */
    ownerSession: boolean
}

/**
 * Whether this request was a person opening a page.
 *
 * The obvious rule — count responses whose content type is HTML — is wrong
 * here, and wrong in a way that inflates some projects far more than others.
 * `serveStatic` falls back to `index.html` for any missing path when the
 * manifest declares `spa`, so on a single-page app **every request for a file
 * that does not exist comes back as `text/html` with status 200**:
 * `/favicon.ico`, `/robots.txt`, `/sw.js`, and every broken image in the page.
 * One page load would count as three or four, and the multiplier would differ
 * per project depending on how many missing files its HTML asks for. The
 * content type cannot separate them, because the fallback is exactly what makes
 * them HTML.
 *
 * So the question asked is whether the request was a *navigation*.
 * `sec-fetch-dest` answers it directly and is sent by every current browser on
 * a secure context, which these sites always are: it reads `image` for the
 * favicon, `script` for a service worker, `empty` for `fetch()`, and `iframe`
 * for a framed load. `accept` is the fallback for curl and anything older.
 *
 * `GET` alone excludes HEAD, which `app.all('*')` otherwise routes into
 * `serveStatic` and which uptime checkers and link previewers send. Prefetch
 * and prerender hints are excluded because nobody looked at the page.
 */
export function countableVisit(signals: VisitSignals): boolean {
    if (signals.preview || signals.internalRender || signals.ownerSession) return false
    if (signals.method !== 'GET') return false
    if (signals.status !== 200) return false
    if (!signals.contentType.toLowerCase().startsWith('text/html')) return false
    if (isPrefetch(signals)) return false
    const dest = signals.secFetchDest?.trim().toLowerCase()
    if (dest) return dest === 'document'
    // No Sec-Fetch-Dest: a non-browser client. Treat an explicit willingness to
    // take HTML as a navigation, which counts curl -H 'accept: text/html' and
    // not a bare `accept: */*` probe.
    return (signals.accept ?? '').toLowerCase().includes('text/html')
}

function isPrefetch(signals: VisitSignals): boolean {
    const purpose = `${signals.secPurpose ?? ''} ${signals.purpose ?? ''} ${signals.xMoz ?? ''}`.toLowerCase()
    return purpose.includes('prefetch') || purpose.includes('prerender')
}

/**
 * Whether there is room in the pool to record anything right now.
 *
 * The gateway's pool is shared with `wakeRuntime`'s cold-start polling loop and
 * with `resolveSite`, which runs on every request. Analytics is the least
 * important thing it does, so it is the first thing to yield: a queue of any
 * depth means a request is already waiting for a connection, and a dropped
 * count matters less than a slower cold start.
 */
export function shouldRecord(pool: {waitingCount?: number}): boolean {
    return (pool.waitingCount ?? 0) === 0
}

/**
 * One statement, both writes.
 *
 * The visitor insert is `DO NOTHING` on a primary key of
 * (project, day, hash), which is what makes a distinct-visitor count exact
 * without holding any state in the process: deduplication lives in the index,
 * so a gateway restart cannot double-count someone who comes back.
 *
 * The view counter is a read-modify-write and so is *not* idempotent. It is
 * never retried for that reason — losing a count is better than inventing one.
 */
export const VISIT_RECORD_SQL =
    `WITH counted AS (
         INSERT INTO site_visit_days (project_id, day, views)
         VALUES ($1, $2, 1)
         ON CONFLICT (project_id, day) DO UPDATE
         SET views = site_visit_days.views + 1
     )
     INSERT INTO site_visitor_days (project_id, day, visitor_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`

/**
 * The same shape for a function call.
 *
 * Without this a functions-only project reads zero for ever and looks broken
 * rather than empty: `serveStatic` 404s when the manifest declares no build,
 * and a path outside `/api` never reaches the runtime, so such a project cannot
 * serve an HTML document at all. It still has visitors, and they are counted
 * here into the same per-day visitor set.
 */
export const API_REQUEST_RECORD_SQL =
    `WITH counted AS (
         INSERT INTO site_visit_days (project_id, day, api_requests)
         VALUES ($1, $2, 1)
         ON CONFLICT (project_id, day) DO UPDATE
         SET api_requests = site_visit_days.api_requests + 1
     )
     INSERT INTO site_visitor_days (project_id, day, visitor_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`

/**
 * The per-day series. `count(*)` over the visitor table is a distinct count
 * already, because its primary key holds one row per visitor per day.
 */
export const VISIT_SERIES_SQL =
    `SELECT d.day::text AS day,
            d.views::bigint AS views,
            d.api_requests::bigint AS api_requests,
            (SELECT count(*) FROM site_visitor_days v
             WHERE v.project_id = d.project_id AND v.day = d.day)::int AS visitors
     FROM site_visit_days d
     WHERE d.project_id = $1 AND d.day >= $2 AND d.day <= $3
     ORDER BY d.day`

export const VISIT_TOTALS_SQL =
    `SELECT coalesce(sum(views), 0)::bigint AS views,
            coalesce(sum(api_requests), 0)::bigint AS api_requests
     FROM site_visit_days
     WHERE project_id = $1 AND day >= $2 AND day <= $3`

/**
 * The only place `visitor_hash` may be named outside an insert. It never leaves
 * the database — not in an API response, a log line, or an error — and the
 * tests assert it appears nowhere else in a read.
 */
export const VISITOR_TOTAL_SQL =
    `SELECT count(DISTINCT visitor_hash)::int AS visitors
     FROM site_visitor_days
     WHERE project_id = $1 AND day >= $2 AND day <= $3`

export const VISITOR_PRUNE_SQL = `DELETE FROM site_visitor_days WHERE day < $1`

export const VISIT_PRUNE_SQL = `DELETE FROM site_visit_days WHERE day < $1`

/**
 * The gallery's public view count, as a lateral for `listShowcase`.
 *
 * Views only, never distinct visitors. A popularity signal is one thing;
 * publishing the size of someone else's audience to everyone on the network is
 * another, and on a campus this size "3 visitors this month" comes close to
 * naming them. Uniques stay behind project ownership.
 *
 * Expects the start of the window as `$1`.
 */
export const SHOWCASE_VIEWS_LATERAL =
    `LEFT JOIN LATERAL (
         SELECT coalesce(sum(views), 0)::bigint AS views
         FROM site_visit_days sv
         WHERE sv.project_id = p.id AND sv.day >= $1
     ) vw ON true`

/** A day with no row at all is a zero, not a gap. */
export function fillDays(
    rows: Array<{day: string; views: number; apiRequests: number; visitors: number}>,
    today: string,
    days: number,
): Array<{day: string; views: number; apiRequests: number; visitors: number}> {
    const byDay = new Map(rows.map(row => [row.day, row]))
    return dayRange(today, days).map(day =>
        byDay.get(day) ?? {day, views: 0, apiRequests: 0, visitors: 0})
}

/**
 * An SVG path for the sparkline on a project card.
 *
 * Hand-rolled because the dashboard is one inlined HTML string with no build
 * step and no dependencies, and one polyline does not justify changing that.
 *
 * The `|| 1` on the peak is load-bearing: a project with no visits yet has an
 * all-zero series, and dividing by its maximum would put `NaN` in every
 * coordinate and silently render nothing at all.
 */
export function sparklinePath(values: number[], width: number, height: number): string {
    if (!values.length) return ''
    const peak = Math.max(...values) || 1
    const step = values.length > 1 ? width / (values.length - 1) : 0
    return values
        .map((value, index) => {
            const x = (index * step).toFixed(2)
            const y = (height - (value / peak) * height).toFixed(2)
            return `${index === 0 ? 'M' : 'L'}${x},${y}`
        })
        .join(' ')
}
