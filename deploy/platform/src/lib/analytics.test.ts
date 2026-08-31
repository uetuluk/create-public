import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {
    analyticsKey,
    analyticsTimeZoneFromEnv,
    API_REQUEST_RECORD_SQL,
    countableVisit,
    dayBefore,
    dayRange,
    fillDays,
    MAX_READ_DAYS,
    SHOWCASE_VIEWS_LATERAL,
    shouldRecord,
    sparklinePath,
    visitDay,
    visitorHash,
    VISITOR_PRUNE_SQL,
    VISITOR_RETENTION_DAYS,
    VISITOR_TOTAL_SQL,
    VISIT_PRUNE_SQL,
    VISIT_RECORD_SQL,
    VISIT_RETENTION_DAYS,
    VISIT_SERIES_SQL,
    VISIT_TOTALS_SQL,
    type VisitSignals,
} from './analytics'

const NAVIGATION: VisitSignals = {
    method: 'GET',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    secFetchDest: 'document',
    accept: 'text/html,application/xhtml+xml',
    preview: false,
    internalRender: false,
    ownerSession: false,
}

test('a plain navigation counts', () => {
    assert.equal(countableVisit(NAVIGATION), true)
})

/**
 * The regression this whole predicate exists for.
 *
 * `serveStatic` falls back to index.html for any missing path on an SPA, so a
 * favicon nobody shipped comes back as text/html 200. Counting content types
 * would have made one page load register as three or four, by a multiplier that
 * differed per project depending on how many missing files its HTML asked for.
 */
test('an SPA fallback serving index.html for a missing asset is not a visit', () => {
    for (const dest of ['image', 'script', 'style', 'font', 'empty', 'iframe', 'manifest']) {
        assert.equal(
            countableVisit({...NAVIGATION, secFetchDest: dest}),
            false,
            `sec-fetch-dest: ${dest} must not count`,
        )
    }
})

test('HEAD is not a visit', () => {
    // app.all('*') routes HEAD into serveStatic, which builds the same HTML
    // response before Node drops the body. Uptime checkers send these.
    assert.equal(countableVisit({...NAVIGATION, method: 'HEAD'}), false)
})

test('a prefetch or prerender is not a visit', () => {
    assert.equal(countableVisit({...NAVIGATION, secPurpose: 'prefetch;prerender'}), false)
    assert.equal(countableVisit({...NAVIGATION, purpose: 'prefetch'}), false)
    assert.equal(countableVisit({...NAVIGATION, xMoz: 'prefetch'}), false)
})

test('a client with no sec-fetch-dest counts only when it asked for HTML', () => {
    const bare = {...NAVIGATION, secFetchDest: undefined}
    assert.equal(countableVisit({...bare, accept: 'text/html'}), true)
    assert.equal(countableVisit({...bare, accept: '*/*'}), false)
    assert.equal(countableVisit({...bare, accept: undefined}), false)
})

test('only a 200 of an HTML document counts', () => {
    assert.equal(countableVisit({...NAVIGATION, status: 404}), false)
    assert.equal(countableVisit({...NAVIGATION, contentType: 'image/png'}), false)
})

test('previews, the renderer, and an owner session are all excluded', () => {
    assert.equal(countableVisit({...NAVIGATION, preview: true}), false)
    assert.equal(countableVisit({...NAVIGATION, internalRender: true}), false)
    assert.equal(countableVisit({...NAVIGATION, ownerSession: true}), false)
})

test('the analytics key is not the SecretBox content-encryption key', () => {
    // lib/crypto.ts derives SecretBox's AES key as sha256(SECRET_ENCRYPTION_KEY).
    // Deriving visitor pseudonyms the same way would write values derived from
    // that key into a table.
    const secret = 'a-secret-at-least-thirty-two-bytes-long'
    assert.notDeepEqual(analyticsKey(secret), createHash('sha256').update(secret).digest())
})

test('a visitor is unlinkable across projects', () => {
    const key = analyticsKey('a-secret-at-least-thirty-two-bytes-long')
    const one = visitorHash(key, 'project-a', '10.0.0.1', 'Firefox')
    const two = visitorHash(key, 'project-b', '10.0.0.1', 'Firefox')
    assert.equal(one.length, 16)
    assert.deepEqual(one, visitorHash(key, 'project-a', '10.0.0.1', 'Firefox'))
    assert.notDeepEqual(one, two)
})

test('the visitor hash cannot be confused by a field boundary', () => {
    const key = analyticsKey('a-secret-at-least-thirty-two-bytes-long')
    assert.notDeepEqual(
        visitorHash(key, 'p', 'a', 'bc'),
        visitorHash(key, 'p', 'ab', 'c'),
    )
})

test('the day is the local day, not the UTC day', () => {
    // 23:30 on the 26th in a UTC+9 zone is 14:30 UTC the same day; 01:30 local
    // on the 27th is still 16:30 UTC on the 26th, and that is the case that
    // would land traffic on the wrong bar.
    assert.equal(visitDay(new Date('2026-08-26T16:30:00Z'), 'Asia/Tokyo'), '2026-08-27')
    assert.equal(visitDay(new Date('2026-08-26T14:30:00Z'), 'Asia/Tokyo'), '2026-08-26')
    // The same instants, west of UTC, land on different days again — so this
    // pins the zone being applied rather than one installation's configuration.
    assert.equal(visitDay(new Date('2026-08-26T03:30:00Z'), 'America/New_York'), '2026-08-25')
    assert.equal(visitDay(new Date('2026-08-26T04:30:00Z'), 'America/New_York'), '2026-08-26')
    assert.equal(visitDay(new Date('2026-08-26T00:00:00Z'), 'UTC'), '2026-08-26')
})

test('the zone must be configured, and must be a real one', () => {
    // No default: UTC would look like a working installation while silently
    // re-bucketing every day by the local offset.
    assert.throws(() => analyticsTimeZoneFromEnv({}), /ANALYTICS_TIMEZONE/)
    assert.throws(() => analyticsTimeZoneFromEnv({ANALYTICS_TIMEZONE: '  '}), /ANALYTICS_TIMEZONE/)
    assert.throws(() => analyticsTimeZoneFromEnv({ANALYTICS_TIMEZONE: 'Mars/Olympus'}), /not a valid IANA/)
    assert.equal(analyticsTimeZoneFromEnv({ANALYTICS_TIMEZONE: 'Europe/Berlin'}), 'Europe/Berlin')
})

test('calendar arithmetic crosses a month boundary', () => {
    assert.equal(dayBefore('2026-03-01', 1), '2026-02-28')
    assert.equal(dayBefore('2026-01-01', 1), '2025-12-31')
    assert.equal(dayRange('2026-08-26', 3).join(','), '2026-08-24,2026-08-25,2026-08-26')
})

test('a day with no row is a zero, not a gap', () => {
    const filled = fillDays(
        [{day: '2026-08-26', views: 4, apiRequests: 1, visitors: 2}],
        '2026-08-26',
        3,
    )
    assert.equal(filled.length, 3)
    assert.deepEqual(filled.map(d => d.views), [0, 0, 4])
    assert.equal(filled[0].day, '2026-08-24')
})

test('analytics yields the moment the pool has anyone waiting', () => {
    assert.equal(shouldRecord({waitingCount: 0}), true)
    assert.equal(shouldRecord({waitingCount: 1}), false)
    assert.equal(shouldRecord({}), true)
})

test('an all-zero series draws a flat line rather than NaN', () => {
    const path = sparklinePath([0, 0, 0], 100, 34)
    assert.doesNotMatch(path, /NaN/)
    assert.match(sparklinePath([5], 100, 34), /^M0\.00,/)
    assert.equal(sparklinePath([], 100, 34), '')
})

const ALL_SQL = [
    VISIT_RECORD_SQL, API_REQUEST_RECORD_SQL, VISIT_SERIES_SQL, VISIT_TOTALS_SQL,
    VISITOR_TOTAL_SQL, VISITOR_PRUNE_SQL, VISIT_PRUNE_SQL, SHOWCASE_VIEWS_LATERAL,
]

test('no analytics SQL interpolates a value', () => {
    for (const sql of ALL_SQL) assert.doesNotMatch(sql, /\$\{/)
})

/**
 * The rule that keeps the reader and the writer agreeing about "today". The
 * gateway buckets in the campus timezone; a query that derived its own day
 * would be eight hours out, and every row would still look plausible.
 */
test('no analytics SQL derives a day of its own', () => {
    for (const sql of ALL_SQL) {
        assert.doesNotMatch(sql, /CURRENT_DATE|current_date|now\(\)::date|CURRENT_TIMESTAMP/)
    }
})

test('the record statements upsert rather than accumulate duplicates', () => {
    assert.match(VISIT_RECORD_SQL, /ON CONFLICT \(project_id, day\) DO UPDATE/)
    assert.match(API_REQUEST_RECORD_SQL, /ON CONFLICT \(project_id, day\) DO UPDATE/)
    // Deduplication of visitors lives in the primary key, not in the process,
    // so a gateway restart cannot double-count someone who comes back.
    for (const sql of [VISIT_RECORD_SQL, API_REQUEST_RECORD_SQL]) {
        assert.match(sql, /INSERT INTO site_visitor_days[\s\S]*ON CONFLICT DO NOTHING/)
    }
})

test('every read is scoped to one project', () => {
    for (const sql of [VISIT_SERIES_SQL, VISIT_TOTALS_SQL, VISITOR_TOTAL_SQL]) {
        assert.match(sql, /project_id = \$1/)
    }
})

test('visitor_hash never leaves the database', () => {
    // It may be counted, never selected. Nothing may return it to a caller, a
    // log line, or the metrics endpoint.
    assert.match(VISITOR_TOTAL_SQL, /count\(DISTINCT visitor_hash\)/)
    for (const sql of [VISIT_SERIES_SQL, VISIT_TOTALS_SQL, SHOWCASE_VIEWS_LATERAL]) {
        assert.doesNotMatch(sql, /visitor_hash/)
    }
})

test('the gallery publishes views and never distinct visitors', () => {
    assert.match(SHOWCASE_VIEWS_LATERAL, /sum\(views\)/)
    assert.doesNotMatch(SHOWCASE_VIEWS_LATERAL, /visitor/)
})

/**
 * Pruning and reading at the same boundary would race: the oldest day of a
 * window would lose its rows while it was still being displayed, and the count
 * would sag with nothing to say why.
 */
test('retention outlives the longest window anyone can ask for', () => {
    assert.ok(VISITOR_RETENTION_DAYS > MAX_READ_DAYS)
    assert.ok(VISIT_RETENTION_DAYS > MAX_READ_DAYS)
    // The pseudonym has the shorter life. That asymmetry is the privacy control.
    assert.ok(VISIT_RETENTION_DAYS > VISITOR_RETENTION_DAYS)
})
