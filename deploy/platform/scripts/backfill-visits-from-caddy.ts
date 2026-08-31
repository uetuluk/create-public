/**
 * Backfills site visit analytics from Caddy's wildcard access log.
 *
 * The gateway counts visits from the moment it is deployed. This recovers
 * whatever is still in Caddy's log from before that, so a project's first day
 * is not artificially empty.
 *
 * How much that is worth checking before running: the log rolls at 10 MB and
 * keeps three, so the window is however long 40 MB of JSON takes to fill. On a
 * busy afternoon that has been about five hours. This is a one-shot for the
 * changeover, not a recurring import.
 *
 * Two properties make it safe to run, and both are deliberate.
 *
 * It reuses `countableVisit` and `visitorHash` from lib/analytics.ts rather
 * than reimplementing them. A backfill that decided for itself what a visit was
 * would produce numbers that could not be compared with the ones the gateway
 * writes, and the discrepancy would look like real traffic.
 *
 * It never uses the live `views = views + 1` upsert, which is a
 * read-modify-write and would double every count on a second run. It offers two
 * safe modes instead, and choosing between them is the whole subtlety here.
 *
 * By default a day the gateway has already written is left alone
 * (ON CONFLICT DO NOTHING). That is right for importing days the gateway never
 * saw.
 *
 * `--replace` sets the day's counters from the log instead. That is right for
 * the changeover day, and the reasoning is worth stating because the obvious
 * choices are both wrong. The gateway begins counting the moment it is
 * deployed, which is *inside* the window the log already covers — so the log is
 * a superset of whatever the gateway has recorded for that day, not a disjoint
 * earlier slice. Adding would therefore double-count the overlap, and doing
 * nothing would discard the entire pre-deploy day just because the gateway had
 * written a single row. Setting from the log is the only one of the three that
 * is both correct and re-runnable.
 *
 * Its one imprecision: traffic between reading the last log line and writing
 * the row is overwritten, so a few seconds of live counts are lost. Run it
 * promptly after deploying and that is nothing.
 *
 * Usage, on the host, from deploy/platform:
 *   npx tsx scripts/backfill-visits-from-caddy.ts                     # dry run
 *   npx tsx scripts/backfill-visits-from-caddy.ts --apply             # fill gaps only
 *   npx tsx scripts/backfill-visits-from-caddy.ts --apply --replace   # changeover day
 */
import {createGunzip} from 'node:zlib'
import {createReadStream} from 'node:fs'
import {readdir} from 'node:fs/promises'
import {createInterface} from 'node:readline'
import {join} from 'node:path'
import {Pool} from 'pg'
import {analyticsKey, countableVisit, visitDay, visitorHash} from '../src/lib/analytics'
import {PLATFORM_DB} from '../src/lib/schema'

const LOG_DIR = process.env.CADDY_LOG_DIR ?? '/var/log/caddy'
const APPLY = process.argv.includes('--apply')
const REPLACE = process.argv.includes('--replace')

/** Matches the gateway's own host parsing: a preview label is never counted. */
const PREVIEW_LABEL = /^([a-z][a-z0-9-]{2,39})--v-([a-f0-9]{10})$/

type Bucket = {views: number; apiRequests: number; visitors: Set<string>}

function header(headers: Record<string, string[]> | undefined, name: string): string | undefined {
    return headers?.[name]?.[0]
}

async function* lines(path: string): AsyncGenerator<string> {
    const raw = createReadStream(path)
    const stream = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw
    for await (const line of createInterface({input: stream, crlfDelay: Infinity})) {
        if (line.trim()) yield line
    }
}

async function main(): Promise<void> {
    const adminUrl = process.env.PLATFORM_ADMIN_DATABASE_URL
    const encryptionSecret = process.env.SECRET_ENCRYPTION_KEY
    const domain = process.env.GATEWAY_DOMAIN ?? ''
    if (!domain) throw new Error('set GATEWAY_DOMAIN')
    if (!adminUrl || !encryptionSecret) {
        throw new Error('PLATFORM_ADMIN_DATABASE_URL and SECRET_ENCRYPTION_KEY must be set')
    }
    const url = new URL(adminUrl)
    url.pathname = `/${PLATFORM_DB}`
    const pool = new Pool({connectionString: url.toString(), max: 4})
    const visitorKey = analyticsKey(encryptionSecret)

    const projects = await pool.query<{id: string; slug: string}>(
        `SELECT id, slug FROM projects WHERE status <> 'deleted'`)
    const bySlug = new Map(projects.rows.map(row => [row.slug, row.id]))

    const files = (await readdir(LOG_DIR))
        .filter(name => name.startsWith('site-access'))
        .sort()
        .map(name => join(LOG_DIR, name))
    if (!files.length) throw new Error(`no site-access logs under ${LOG_DIR}`)

    const buckets = new Map<string, Bucket>()
    let read = 0
    let counted = 0
    let skippedUnknown = 0

    for (const file of files) {
        for await (const line of lines(file)) {
            read += 1
            let entry: any
            try { entry = JSON.parse(line) } catch { continue }
            const request = entry?.request
            if (!request?.host) continue

            const host = String(request.host).toLowerCase().split(':')[0]
            if (!host.endsWith(`.${domain}`)) continue
            const label = host.slice(0, -(domain.length + 1))
            // Previews and the gallery host are not a project's own traffic.
            if (PREVIEW_LABEL.test(label) || label === 'showcase') continue
            const projectId = bySlug.get(label)
            if (!projectId) { skippedUnknown += 1; continue }

            const uri = String(request.uri ?? '/')
            const path = uri.split('?')[0]
            const isApi = path === '/api' || path.startsWith('/api/')
            const day = visitDay(new Date(Number(entry.ts) * 1000))

            // The renderer never reaches Caddy, since it calls gateway:3001
            // directly, so internalRender is false by construction here. An
            // owner session cannot be seen either, because Caddy redacts
            // Cookie. Both match what the live counter does for a network or
            // showcase site.
            const counts = isApi
                ? Number(entry.status) < 500
                : countableVisit({
                    method: String(request.method ?? ''),
                    status: Number(entry.status),
                    contentType: header(entry.resp_headers, 'Content-Type') ?? '',
                    secFetchDest: header(request.headers, 'Sec-Fetch-Dest'),
                    secPurpose: header(request.headers, 'Sec-Purpose'),
                    purpose: header(request.headers, 'Purpose'),
                    xMoz: header(request.headers, 'X-Moz'),
                    accept: header(request.headers, 'Accept'),
                    preview: false,
                    internalRender: false,
                    ownerSession: false,
                })
            if (!counts) continue

            const key = `${projectId} ${day}`
            let bucket = buckets.get(key)
            if (!bucket) {
                bucket = {views: 0, apiRequests: 0, visitors: new Set()}
                buckets.set(key, bucket)
            }
            if (isApi) bucket.apiRequests += 1
            else bucket.views += 1
            // remote_ip is exactly what Caddy forwards as X-Forwarded-For, so
            // this is the same address the gateway would have hashed.
            const address = String(request.remote_ip ?? '')
            const agent = header(request.headers, 'User-Agent') ?? ''
            bucket.visitors.add(visitorHash(visitorKey, projectId, address, agent).toString('hex'))
            counted += 1
        }
    }

    const slugOf = new Map(projects.rows.map(row => [row.id, row.slug]))
    console.log(`read ${read} log lines from ${files.length} file(s); ${counted} counted`)
    if (skippedUnknown) console.log(`${skippedUnknown} lines named a host with no matching project`)
    for (const [key, bucket] of [...buckets].sort()) {
        const [projectId, day] = key.split(' ')
        console.log(`  ${day}  ${slugOf.get(projectId)}: ${bucket.views} page loads, `
            + `${bucket.apiRequests} API requests, ${bucket.visitors.size} visitors`)
    }
    if (!APPLY) {
        console.log(`dry run; nothing written. Re-run with --apply${REPLACE ? ' --replace' : ''} to write these rows.`)
        await pool.end()
        return
    }

    let written = 0
    let untouched = 0
    for (const [key, bucket] of buckets) {
        const [projectId, day] = key.split(' ')
        // Never an increment. Either leave a day the gateway owns alone, or
        // set it from the log, which is a superset of what the gateway can have
        // counted for that day. Both are re-runnable; adding would not be.
        const inserted = await pool.query(
            REPLACE
                ? `INSERT INTO site_visit_days (project_id, day, views, api_requests)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (project_id, day) DO UPDATE
                   SET views = EXCLUDED.views, api_requests = EXCLUDED.api_requests`
                : `INSERT INTO site_visit_days (project_id, day, views, api_requests)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (project_id, day) DO NOTHING`,
            [projectId, day, bucket.views, bucket.apiRequests],
        )
        if (inserted.rowCount) written += 1
        else untouched += 1
        for (const hash of bucket.visitors) {
            await pool.query(
                `INSERT INTO site_visitor_days (project_id, day, visitor_hash)
                 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [projectId, day, Buffer.from(hash, 'hex')],
            )
        }
    }
    console.log(REPLACE
        ? `set ${written} project-days from the log.`
        : `wrote ${written} project-days; left ${untouched} alone (already counted).`)
    await pool.end()
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
