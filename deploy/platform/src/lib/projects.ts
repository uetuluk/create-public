import {createHash, randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {access, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {HTTPException} from 'hono/http-exception'
import {
    DEFAULT_READ_DAYS,
    dayBefore,
    fillDays,
    MAX_READ_DAYS,
    SHOWCASE_VIEWS_LATERAL,
    visitDay,
    VISITOR_TOTAL_SQL,
    VISIT_SERIES_SQL,
    VISIT_TOTALS_SQL,
} from './analytics'
import type {Pool, PoolClient} from 'pg'
import {z} from 'zod'
import {assertOperator, type Principal, type PlatformRole, roleAtLeast} from './authn'
import {renderBudget} from './budgets'
import {SecretBox} from './crypto'
import {LlmService, type LlmKeyLimits} from './llm'
import {parseProbeRequest} from './probe'
import {
    describeUploadMismatch,
    MAX_CHUNK_BYTES,
    normalizeChunkBase64,
    RECOMMENDED_CHUNK_BYTES,
    sha256Hex,
} from './uploads'

export const slugSchema = z.string().min(3).max(40).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/)
/**
 * The three visitor tiers, as a ladder.
 *
 * `owner` is reachable by one authenticated person. `network` is reachable by
 * anyone on the LAN who already knows the URL. `showcase` is `network` plus a
 * card in the gallery on the dashboard, so it is reachable by anyone on the LAN
 * *and* advertised to them.
 *
 * The order matters more than the names: `showcase` is strictly `network` with
 * something added, never something taken away, which is why the reachability
 * test below is a negation of `owner` rather than a list of the modes that
 * happen to be reachable today. A fourth tier added above `showcase` inherits
 * the right answer instead of silently 403ing every site under it.
 */
export const accessModeSchema = z.enum(['owner', 'network', 'showcase'])
export type AccessMode = z.infer<typeof accessModeSchema>

/** True when visitors other than the owner can load the site at all. */
export function isNetworkReachable(mode: string): boolean {
    return mode !== 'owner'
}

/**
 * Position on the ladder, so callers can ask whether a change widened exposure
 * rather than enumerating the pairs that do.
 */
export const ACCESS_RANK: Record<AccessMode, number> = {owner: 0, network: 1, showcase: 2}

/**
 * The highest tier an ordinary account may set. Defaults to the top, so an
 * installation that says nothing behaves exactly as before.
 *
 * This exists for deployments that are open to sign-ups — a public demo, say —
 * where the gallery is the one surface that carries a stranger's page to people
 * who were not looking for it. Capping ordinary accounts at `owner` leaves the
 * platform fully usable and removes that reach.
 *
 * Operators are exempt, on the same reasoning as their quota and immediate-purge
 * exemptions: the people running the installation are the ones who can vouch
 * for a listing, so a capped deployment can still carry curated examples.
 */
export function parseMaxAccessMode(raw: string | undefined): AccessMode {
    const value = raw?.trim().toLowerCase()
    if (!value) return 'showcase'
    return accessModeSchema.parse(value)
}

/** The ceiling, applied to everyone the installation has not exempted. */
export function accessCeilingFor(role: PlatformRole, ceiling: AccessMode): AccessMode {
    return roleAtLeast(role, 'operator') ? 'showcase' : ceiling
}

/**
 * How much of the owner's own words the gallery will carry.
 *
 * One line under a screenshot. Long enough to say what an app is for, short
 * enough that a card cannot be turned into a billboard or a wall of text on
 * every other user's home page.
 */
export const MAX_SHOWCASE_DESCRIPTION = 200

/** Upper bound on a screenshot the owner uploads themselves, over REST. */
export const MAX_SHOWCASE_SHOT_BYTES = 2 * 1024 * 1024

/**
 * Hostnames on the wildcard domain that the platform serves itself, so no
 * project may take them as a slug.
 *
 * `showcase` carries the logged-out gallery. A project of that name would take
 * the hostname from under it — the wildcard is resolved by label, and there is
 * no arbitration beyond who Caddy routes it to.
 */
export const RESERVED_SLUGS = new Set(['showcase'])

/** The label the logged-out gallery is served on, under the wildcard domain. */
export const SHOWCASE_EMBED_HOST_LABEL = 'showcase'

/** The first eight bytes of every PNG file. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024
export {MAX_CHUNK_BYTES} from './uploads'
/** Mirrors the `llm_rpm_max` and `llm_tpm_max` defaults declared in the schema. */
export const DEFAULT_LLM_LIMITS: LlmKeyLimits = {rpm: 60, tpm: 200_000}
/** Mirrors the `accounts.project_quota` default declared in the schema. */
export const DEFAULT_PROJECT_QUOTA = 3

/**
 * The floor an account holding `platform_role = 'operator'` creates against.
 *
 * Operators carry the platform's own work — capacity gates, reproductions of a
 * user's bug, the disposable projects a drill makes and removes — and three
 * slots is a fairness limit written for open registration, not for that. The
 * number is deliberately well under host capacity: it is room to work, not a
 * licence to fill the host.
 */
export const OPERATOR_PROJECT_QUOTA = 25

/**
 * The project quota a new account is created with, from `DEFAULT_PROJECT_QUOTA`.
 * Existing accounts keep whatever they hold; this only decides what a first
 * sign-in writes. A bad value fails at startup rather than at the first
 * registration, where it would surface as a broken login and a constraint
 * violation in the log.
 */
export function parseProjectQuotaDefault(value: string | undefined): number {
    return parsePositiveQuota(value, DEFAULT_PROJECT_QUOTA, 'DEFAULT_PROJECT_QUOTA')
}

/**
 * The operator floor, from `OPERATOR_PROJECT_QUOTA`.
 *
 * Unlike `DEFAULT_PROJECT_QUOTA` this is not written anywhere: it is applied at
 * the create check, against the role read in the same transaction. That is what
 * keeps `accounts.project_quota` a column nothing but SQL writes — an operator
 * whose quota somebody raised by hand keeps the higher number, and demoting an
 * operator takes the floor away on their next create with no cleanup to run.
 */
export function parseOperatorProjectQuota(value: string | undefined): number {
    return parsePositiveQuota(value, OPERATOR_PROJECT_QUOTA, 'OPERATOR_PROJECT_QUOTA')
}

/**
 * How many projects an account may hold, given its own column and the role it
 * currently carries in the control database.
 *
 * A floor, never a cap: an operator whose column was raised past the floor keeps
 * the raised number, so the two ways of granting room compose instead of one
 * quietly undoing the other.
 */
export function effectiveProjectQuota(
    account: {project_quota: number; platform_role: PlatformRole},
    operatorQuota: number = OPERATOR_PROJECT_QUOTA,
): number {
    // `roleAtLeast`, not `=== 'operator'`: a superadmin sits above operator and
    // must not create against a *lower* limit than the tier beneath it.
    return roleAtLeast(account.platform_role, 'operator')
        ? Math.max(account.project_quota, operatorQuota)
        : account.project_quota
}

function parsePositiveQuota(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined || value.trim() === '') return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
    }
    return parsed
}

export interface ProjectSummary {
    id: string
    slug: string
    url: string
    access: AccessMode
    status: string
    currentVersionId: string | null
    createdAt: string
    showcase: ShowcaseState
    resources: {
        postgres: boolean
        storage: boolean
        llm: boolean
        /** 'pending' while provisioning runs; migrations cannot apply until 'ready'. */
        provisionState: string
        provisionError: string | null
    }
    quota: {
        runtimeMemoryMiB: number
        runtimeCpu: number
        postgresBytes: number
        objectBytes: number
        versions: number
        llmRequestsPerMinute: number
        llmTokensPerMinute: number
    }
    usage?: {
        postgresBytes: number
        objectBytes: number
        measuredAt: string | null
    }
}

/**
 * The showcase side of a project, as its owner sees it.
 *
 * `description` is the owner's own words and is the only field the gallery ever
 * renders. `draft` is what a model suggested after reading the project's page;
 * it is returned here, to the owner, and nowhere else. Keeping the two apart in
 * the type is the same decision as keeping them in separate columns: a draft
 * that cannot reach the gallery projection cannot be published by forgetting.
 */
export interface ShowcaseState {
    description: string
    /** Null until a capture or an upload has produced one. */
    screenshotUrl: string | null
    screenshotSource: 'captured' | 'uploaded' | null
    capturedAt: string | null
    /** A suggestion, never a listing. Only ever shown to the owner. */
    draft: string | null
    draftAt: string | null
}

/** One card in the gallery. Deliberately far narrower than ProjectSummary. */
export interface ShowcaseEntry {
    slug: string
    url: string
    description: string
    ownerName: string
    screenshotUrl: string | null
    capturedAt: string | null
    /**
     * Page loads over the trailing window, published to everyone who can see
     * the gallery. Views only — never the distinct-visitor count, which stays
     * behind project ownership.
     */
    views: number
}

/** What an owner is shown about who has been to their site. */
export interface SiteAnalytics {
    days: number
    views: number
    apiRequests: number
    visitors: number
    daily: Array<{day: string; views: number; apiRequests: number; visitors: number}>
}

type ProjectRow = {
    id: string
    owner_id: string
    slug: string
    access_mode: AccessMode
    status: string
    current_version_id: string | null
    runtime_memory_mb: number
    runtime_cpu: string
    database_bytes_max: string
    object_bytes_max: string
    version_limit: number
    postgres_enabled: boolean
    storage_enabled: boolean
    llm_enabled: boolean
    llm_rpm_max: number
    llm_tpm_max: number
    created_at: Date
    deleted_at?: Date | null
    purge_after?: Date | null
    postgres_bytes?: string
    object_bytes?: string
    measured_at?: Date | null
    provision_state?: string
    provision_error?: string | null
    showcase_description: string
    showcase_shot_source: 'captured' | 'uploaded' | null
    showcase_shot_at?: Date | null
    showcase_draft?: string | null
    showcase_draft_at?: Date | null
}

type DeploymentRow = {
    id: string
    version_id: string | null
    previous_version_id: string | null
    status: string
    error_message: string | null
    activated_at: Date | null
    created_at: Date
}

export class ProjectService {
    constructor(
        private readonly pool: Pool,
        private readonly domain: string,
        /** Required: see lib/analytics on why this has no default. */
        private readonly analyticsTimeZone: string,
        private readonly sourceRoot: string,
        private readonly secrets: SecretBox,
        private readonly llm: LlmService | null = null,
        private readonly showcaseRoot: string = '/data/showcase',
        private readonly operatorProjectQuota: number = OPERATOR_PROJECT_QUOTA,
        /** The highest tier an ordinary account may set. See parseMaxAccessMode. */
        private readonly maxAccessMode: AccessMode = 'showcase',
    ) {}

    async create(
        principal: Principal,
        input: {slug: string; access?: 'owner' | 'network'; postgres?: boolean; storage?: boolean; llm?: boolean},
    ): Promise<ProjectSummary> {
        const slug = slugSchema.parse(input.slug)
        if (RESERVED_SLUGS.has(slug)) {
            throw new HTTPException(409, {message: `"${slug}" is reserved by the platform; choose another slug`})
        }
        const access = accessModeSchema.parse(input.access ?? 'owner')
        const ceiling = accessCeilingFor(principal.role, this.maxAccessMode)
        if (ACCESS_RANK[access] > ACCESS_RANK[ceiling]) {
            throw new HTTPException(403, {message: `this installation limits projects to "${ceiling}" access`})
        }
        const id = randomUUID()
        const databaseName = `site_${id.replace(/-/g, '')}`
        // The LLM binding is opt-in: inference runs on shared hardware, so a
        // project only takes a share of it when it says it needs one.
        const wantsLlm = input.llm === true
        if (wantsLlm && !this.llm) {
            throw new HTTPException(503, {message: 'the managed LLM binding is not configured on this deployment'})
        }
        // Minted before the transaction opens, never inside it: the proxy is an
        // external HTTP hop and the platform pool is small, so a slow key
        // service must not hold a database connection or the account row lock.
        // A create that then fails its quota or slug check revokes below.
        const minted = wantsLlm && this.llm ? await this.mintOrFail(id, slug) : null
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            // The role is read here, under the same FOR UPDATE, rather than
            // taken from the principal: a session cookie or access token carries
            // the role it was issued with for up to twelve hours, and a quota
            // must not be decided by a stale claim in either direction.
            const quota = await client.query<{project_quota: number; platform_role: PlatformRole}>(
                `SELECT project_quota, platform_role FROM accounts WHERE id = $1 FOR UPDATE`,
                [principal.accountId],
            )
            if (!quota.rowCount) throw new HTTPException(401, {message: 'account not found'})
            const limit = effectiveProjectQuota(quota.rows[0], this.operatorProjectQuota)
            const used = await client.query<{count: string}>(
                `SELECT COUNT(*)::text AS count FROM projects
                 WHERE owner_id = $1 AND status <> 'deleted'`,
                [principal.accountId],
            )
            if (Number(used.rows[0].count) >= limit) {
                // The number is per account, so it is named here: it is the
                // only place a caller can learn what its own limit is.
                throw new HTTPException(403, {
                    message: `project quota exceeded (${limit} projects for this account).`
                        + ` Delete a project you no longer need, or ask an operator to raise the quota.`
                        + ` A project awaiting purge still counts.`,
                })
            }
            await client.query(
                `INSERT INTO projects (
                    id, owner_id, slug, access_mode, database_name,
                    postgres_enabled, storage_enabled, llm_enabled
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [id, principal.accountId, slug, access, databaseName, input.postgres ?? true, input.storage ?? true, wantsLlm],
            )
            await client.query(
                `INSERT INTO project_resources (project_id, llm_key_enc, llm_key_alias, llm_key_expires_at)
                 VALUES ($1,$2,$3,$4)`,
                [
                    id,
                    minted ? this.secrets.encrypt(minted.key) : null,
                    minted?.alias ?? null,
                    minted?.expiresAt ?? null,
                ],
            )
            await enqueue(client, 'provision_project', id, null, `provision:${id}`)
            await audit(client, principal.accountId, id, 'project.created', {slug, access, llm: wantsLlm})
            await client.query('COMMIT')
        } catch (error: any) {
            await client.query('ROLLBACK')
            // The key was minted before the transaction, so a rejected create
            // must not leave it live on the proxy.
            if (minted) await this.llm?.revoke(id).catch(() => undefined)
            if (error?.code === '23505') throw new HTTPException(409, {message: 'slug already exists'})
            throw error
        } finally {
            client.release()
        }
        return await this.get(principal, slug)
    }

    async list(principal: Principal): Promise<ProjectSummary[]> {
        const result = await this.pool.query<ProjectRow>(
            `${projectSelect()}
             WHERE p.owner_id = $1 AND p.status <> 'deleted'
             ORDER BY p.created_at DESC`,
            [principal.accountId],
        )
        return result.rows.map(row => this.map(row))
    }

    async get(principal: Principal, slug: string): Promise<ProjectSummary> {
        const row = await this.ownedProject(principal, slug)
        return this.map(row)
    }

    /**
     * Moves a project up or down the visitor ladder.
     *
     * Two things hang off the direction of the move rather than off the
     * destination. A review is queued when the project becomes reachable by
     * *more* people than before, which covers owner to network, owner to
     * showcase, and network to showcase; going back down is not a new exposure
     * and does not spend a heavy render. And the showcase screenshot is dropped
     * on the way out, because a listing image for a project that is no longer
     * listed is a file nothing will ever read and nothing will ever delete.
     */
    async updateAccess(principal: Principal, slug: string, access: AccessMode): Promise<ProjectSummary> {
        accessModeSchema.parse(access)
        const ceiling = accessCeilingFor(principal.role, this.maxAccessMode)
        if (ACCESS_RANK[access] > ACCESS_RANK[ceiling]) {
            throw new HTTPException(403, {
                message: `this installation limits projects to "${ceiling}" access`
                    + (ceiling === 'owner' ? '; your projects are visible to you alone' : ''),
            })
        }
        const project = await this.ownedProject(principal, slug)
        // Refused before the write, not after: a project that appears in the
        // gallery as a bare slug is worse than one that is not there yet, and
        // the owner is the only person who can say what their app is for.
        if (access === 'showcase' && !project.showcase_description.trim()) {
            throw new HTTPException(409, {
                message: 'set a showcase description first'
                    + ' (PUT /v1/projects/:slug/showcase, or the set_showcase_listing tool):'
                    + ' a gallery card needs one line saying what this app is for',
            })
        }
        await this.pool.query(`UPDATE projects SET access_mode = $1, updated_at = now() WHERE id = $2`, [access, project.id])
        await audit(this.pool, principal.accountId, project.id, 'project.access_changed', {access})
        if (ACCESS_RANK[access] > ACCESS_RANK[project.access_mode] && project.current_version_id) {
            await this.enqueueSiteReview(project.id, project.current_version_id)
        }
        if (access === 'showcase' && project.access_mode !== 'showcase' && project.current_version_id) {
            await this.enqueueShowcaseCapture(project.id, project.current_version_id)
        }
        if (access !== 'showcase' && project.access_mode === 'showcase') {
            await this.clearShowcaseScreenshot(project.id)
        }
        return await this.get(principal, slug)
    }

    /**
     * The gallery: every project whose owner has chosen to advertise it.
     *
     * The one query in this service that is not scoped to the caller, which is
     * the whole point of the tier. What it selects is therefore the security
     * boundary, and it is deliberately narrow: a slug, one line the owner
     * wrote, their display name, and a count of page loads. No project id, no
     * owner email, no status, nothing about the account behind it.
     *
     * That count is the one thing here that is genuinely usage, and it was
     * added knowing this comment used to promise otherwise. It is total page
     * loads over the trailing window and never the distinct-visitor figure: a
     * popularity signal is one thing, and telling everyone on the network how
     * large someone else's audience is another — on a campus this size, "three
     * visitors this month" comes close to naming them. Uniques stay behind
     * ownership, in `analytics`. Nothing about which projects appear changed:
     * a project is here because its owner put it here.
     *
     * A project whose latest review came back `urgent` is left out. Nothing is
     * taken down — it stays reachable at its own hostname exactly as before —
     * but the platform declines to put it on every other user's home page.
     * That is the only effect a review verdict has anywhere in the system, and
     * it is a decision not to promote rather than a decision to block. A
     * project with no review at all is listed: unreviewed is not the same as
     * suspect, and projects that predate the reviewer have no row.
     */
    async listShowcase(limit = 60): Promise<ShowcaseEntry[]> {
        const result = await this.pool.query<{
            slug: string
            showcase_description: string
            showcase_shot_at: Date | null
            display_name: string
            views: string | number | null
        }>(
            `SELECT p.slug, p.showcase_description, p.showcase_shot_at, a.display_name,
                    vw.views
             FROM projects p
             JOIN accounts a ON a.id = p.owner_id
             LEFT JOIN LATERAL (
                 SELECT level FROM site_reviews s
                 WHERE s.project_id = p.id ORDER BY s.created_at DESC LIMIT 1
             ) r ON true
             ${SHOWCASE_VIEWS_LATERAL}
             WHERE p.access_mode = 'showcase'
               AND p.status = 'ready'
               AND p.current_version_id IS NOT NULL
               AND p.showcase_description <> ''
               AND COALESCE(r.level, 'review') <> 'urgent'
             ORDER BY p.showcase_shot_at DESC NULLS LAST, p.slug
             LIMIT $2`,
            [dayBefore(visitDay(new Date(), this.analyticsTimeZone), DEFAULT_READ_DAYS - 1), Math.max(1, Math.min(limit, 200))],
        )
        return result.rows.map(row => ({
            slug: row.slug,
            url: `https://${row.slug}.${this.domain}`,
            description: row.showcase_description,
            ownerName: row.display_name,
            screenshotUrl: row.showcase_shot_at ? `/v1/showcase/${row.slug}/screenshot.png` : null,
            capturedAt: row.showcase_shot_at?.toISOString() ?? null,
            // A project with no visits yet has no row at all. Without the
            // fallback this is NaN, which serialises to null and renders as
            // "null views" on the card.
            views: Number(row.views ?? 0),
        }))
    }

    /**
     * Sets the line the gallery shows under this project's screenshot.
     *
     * Takes the text and nothing else. There is deliberately no "use the draft"
     * argument: the draft was written by a model that read a page written by
     * the person asking to be promoted, and the only thing standing between
     * that text and every other user's home page is that publishing it requires
     * someone to have typed it here. An argument that copied the draft across
     * in one call would remove exactly that step.
     */
    async setShowcaseListing(principal: Principal, slug: string, description: string): Promise<ProjectSummary> {
        const project = await this.ownedProject(principal, slug)
        const text = description.replace(/\s+/g, ' ').trim()
        if (!text) throw new HTTPException(400, {message: 'description is required'})
        if (text.length > MAX_SHOWCASE_DESCRIPTION) {
            throw new HTTPException(400, {
                message: `description is ${text.length} characters; the limit is ${MAX_SHOWCASE_DESCRIPTION}`,
            })
        }
        await this.pool.query(
            `UPDATE projects SET showcase_description = $1, updated_at = now() WHERE id = $2`,
            [text, project.id],
        )
        await audit(this.pool, principal.accountId, project.id, 'project.showcase_updated', {length: text.length})
        return await this.get(principal, slug)
    }

    /**
     * Replaces the captured screenshot with one the owner supplies.
     *
     * Checked by magic bytes rather than by the declared content type, because
     * the declared type is whatever the caller wrote. It is written to the same
     * directory a capture writes to and recorded as `uploaded`, which is what
     * stops the next automatic capture from overwriting a picture the owner
     * chose on purpose.
     */
    async setShowcaseScreenshot(principal: Principal, slug: string, bytes: Buffer): Promise<ProjectSummary> {
        const project = await this.ownedProject(principal, slug)
        if (!bytes.length) throw new HTTPException(400, {message: 'empty body'})
        if (bytes.length > MAX_SHOWCASE_SHOT_BYTES) {
            throw new HTTPException(413, {
                message: `screenshot is ${bytes.length} bytes; the limit is ${MAX_SHOWCASE_SHOT_BYTES}`,
            })
        }
        if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
            throw new HTTPException(400, {message: 'the body is not a PNG'})
        }
        const root = resolve(this.showcaseRoot)
        await mkdir(root, {recursive: true, mode: 0o700})
        const path = resolve(root, `${project.id}.png`)
        await writeFile(path, bytes, {mode: 0o600})
        await this.pool.query(
            `UPDATE projects
             SET showcase_shot_path = $1, showcase_shot_source = 'uploaded',
                 showcase_shot_at = now(), updated_at = now()
             WHERE id = $2`,
            [path, project.id],
        )
        await audit(this.pool, principal.accountId, project.id, 'project.showcase_screenshot', {
            source: 'uploaded', bytes: bytes.length,
        })
        return await this.get(principal, slug)
    }

    /**
     * The same upload, arriving as base64 over MCP.
     *
     * A separate entry point rather than a `dataBase64` argument on the one
     * above, so the byte path has exactly one shape and the decoding — which is
     * where a silently-dropped character turns one image into another — happens
     * in the helper the source upload already uses for the same hazard.
     *
     * The cap is `MAX_CHUNK_BYTES` rather than the REST limit because an MCP
     * request body is capped at one mebibyte and base64 costs a third more than
     * the bytes it carries. An owner with a larger picture has the REST route.
     */
    async setShowcaseScreenshotBase64(principal: Principal, slug: string, dataBase64: string): Promise<ProjectSummary> {
        return await this.setShowcaseScreenshot(principal, slug, normalizeChunkBase64(dataBase64))
    }

    /**
     * The bytes behind a gallery card's image.
     *
     * Looked up by slug with no ownership check, because every signed-in
     * account may see the gallery and the route above it is what requires a
     * session. It answers only for a project that is actually listed, so a URL
     * kept from a project that has since left the showcase stops working.
     */
    async showcaseScreenshot(slug: string): Promise<{body: Buffer; capturedAt: Date}> {
        slugSchema.parse(slug)
        const result = await this.pool.query<{showcase_shot_path: string | null; showcase_shot_at: Date | null}>(
            `SELECT showcase_shot_path, showcase_shot_at FROM projects
             WHERE slug = $1 AND access_mode = 'showcase' AND status = 'ready'`,
            [slug],
        )
        const row = result.rows[0]
        if (!row?.showcase_shot_path || !row.showcase_shot_at) {
            throw new HTTPException(404, {message: 'no screenshot for this project'})
        }
        try {
            return {body: await readFile(row.showcase_shot_path), capturedAt: row.showcase_shot_at}
        } catch {
            // The row outlived the file — a restored database, a cleaned data
            // root. A 404 is the truth; the card falls back to its placeholder.
            throw new HTTPException(404, {message: 'no screenshot for this project'})
        }
    }

    /**
     * Drops the listing image when a project stops being listed.
     *
     * The path is read in a CTE rather than with `RETURNING`, and that is the
     * whole reason this is not a one-liner: PostgreSQL's `RETURNING` yields the
     * *new* row, so `SET showcase_shot_path = NULL ... RETURNING
     * showcase_shot_path` returns null every time and deletes nothing. The
     * database looks correct while every project that ever left the showcase
     * leaves its screenshot on disk for good. A CTE sees the pre-update
     * snapshot, so this reads the old path and clears the row in one statement.
     */
    private async clearShowcaseScreenshot(projectId: string): Promise<void> {
        const result = await this.pool.query<{showcase_shot_path: string | null}>(
            `WITH previous AS (
                 SELECT showcase_shot_path FROM projects WHERE id = $1
             ), cleared AS (
                 UPDATE projects
                 SET showcase_shot_path = NULL, showcase_shot_source = NULL, showcase_shot_at = NULL
                 WHERE id = $1
                 RETURNING id
             )
             SELECT previous.showcase_shot_path FROM previous, cleared`,
            [projectId],
        )
        const path = result.rows[0]?.showcase_shot_path
        if (path) await rm(path, {force: true}).catch(() => {})
    }

    /**
     * Queues the screenshot and description draft for a newly listed project.
     *
     * Swallowed on failure for the same reason `enqueueSiteReview` is: listing
     * a project is the owner's action and it has already succeeded. A capture
     * that could not be queued costs a card with a placeholder image until the
     * next deploy, which is worth a log line and nothing more.
     */
    private async enqueueShowcaseCapture(projectId: string, versionId: string): Promise<void> {
        try {
            await enqueueRerunnable(this.pool, 'capture_showcase', projectId, versionId, `showcase:${projectId}:${versionId}`)
        } catch (error: any) {
            console.error(`[projects] could not queue a showcase capture for ${projectId}: ${error?.message ?? error}`)
        }
    }

    /**
     * Queues a review of the page this project now serves to strangers.
     *
     * Only for `network`. An owner-only project is reachable by exactly one
     * authenticated person, so reviewing it spends inference on a shared proxy
     * to tell an operator something about a page nobody else can load.
     *
     * `enqueueRerunnable` rather than `enqueue`: the key is per version, so a
     * project flipped to owner and back — a deliberate act by the person who
     * owns it — is reviewed again even if that version was reviewed before.
     * Passive activity is not. See docs/operations.md for why an unchanged
     * version is otherwise left alone.
     *
     * Failure here is swallowed on purpose. Making a site public is a user
     * action and a review is not part of it; a review that cannot be queued is
     * worth a log line and nothing more.
     */
    private async enqueueSiteReview(projectId: string, versionId: string): Promise<void> {
        try {
            await enqueueRerunnable(this.pool, 'review_site', projectId, versionId, `review:${projectId}:${versionId}`)
        } catch (error: any) {
            console.error(`[projects] could not queue a site review for ${projectId}: ${error?.message ?? error}`)
        }
    }

    /**
     * Adds a managed resource to a project that already exists.
     *
     * All three flags used to be settable only at creation time, so an author
     * who discovered they needed PostgreSQL had to delete the project and
     * rebuild it under a new slug. Provisioning is re-run under its existing
     * idempotency key; it reuses the credentials it already issued, so a
     * running runtime is not invalidated.
     */
    async enableResources(
        principal: Principal,
        slug: string,
        input: {postgres?: boolean; storage?: boolean; llm?: boolean},
    ): Promise<ProjectSummary> {
        const project = await this.ownedProject(principal, slug)
        if (input.postgres === false || input.storage === false || input.llm === false) {
            throw new HTTPException(400, {
                message: 'managed resources cannot be removed; delete the project and create it again',
            })
        }
        if (!input.postgres && !input.storage && !input.llm) {
            // A call that asks for nothing is the one shape of the stale-schema
            // failure the server can actually see: an MCP host that validates
            // against a cached schema drops the flag it does not know about,
            // and what arrives is a request with only a slug in it.
            throw new HTTPException(400, {
                message: 'specify postgres: true, storage: true, llm: true, or any combination.'
                    + ' If you did pass one, it did not arrive: an MCP client validating against a tool schema it'
                    + ' cached before that flag existed drops it before sending. Reconnect, and call get_skill to'
                    + ' see the arguments this server accepts now.',
            })
        }
        if (project.status === 'deleting' || project.status === 'deleted') {
            throw new HTTPException(409, {message: 'project is being deleted'})
        }
        if (input.llm === true && !this.llm) {
            throw new HTTPException(503, {message: 'the managed LLM binding is not configured on this deployment'})
        }
        // Asking for a binding the project already holds is a no-op rather than
        // a re-mint: minting clears the alias first, so re-running it would
        // revoke the key a live runtime is already using.
        const mintsLlm = input.llm === true && !project.llm_enabled
        // Minted outside the transaction for the same reason `create` does it:
        // the proxy is an external HTTP hop and must not hold a pool connection.
        // A project keeps whatever limits an operator raised it to.
        const minted = mintsLlm
            ? await this.mintOrFail(project.id, slug, {rpm: project.llm_rpm_max, tpm: project.llm_tpm_max})
            : null
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            await client.query(
                `UPDATE projects
                 SET postgres_enabled = postgres_enabled OR $2,
                     storage_enabled = storage_enabled OR $3,
                     llm_enabled = llm_enabled OR $4,
                     updated_at = now()
                 WHERE id = $1`,
                [project.id, Boolean(input.postgres), Boolean(input.storage), Boolean(input.llm)],
            )
            await client.query(
                `INSERT INTO project_resources (project_id, provision_state) VALUES ($1,'pending')
                 ON CONFLICT (project_id) DO UPDATE SET provision_state = 'pending', provision_error = NULL`,
                [project.id],
            )
            if (minted) {
                await client.query(
                    `UPDATE project_resources
                     SET llm_key_enc = $2, llm_key_alias = $3, llm_key_expires_at = $4
                     WHERE project_id = $1`,
                    [project.id, this.secrets.encrypt(minted.key), minted.alias, minted.expiresAt],
                )
            }
            // Reuses the original key on purpose: the DO UPDATE only revives a
            // terminal job, so calling this while provisioning is already
            // queued or running is a correct no-op.
            await enqueueRerunnable(client, 'provision_project', project.id, null, `provision:${project.id}`)
            await audit(client, principal.accountId, project.id, 'project.resources_enabled', {
                postgres: Boolean(input.postgres),
                storage: Boolean(input.storage),
                llm: Boolean(input.llm),
            })
            await client.query('COMMIT')
        } catch (error) {
            await client.query('ROLLBACK')
            // The key was minted before the transaction, so a rejected update
            // must not leave it live on the proxy.
            if (minted) await this.llm?.revoke(project.id).catch(() => undefined)
            throw error
        } finally {
            client.release()
        }
        return await this.get(principal, slug)
    }

    async setSecrets(principal: Principal, slug: string, values: Record<string, string | null>): Promise<{updated: string[]; deleted: string[]}> {
        const project = await this.ownedProject(principal, slug)
        const names = Object.keys(values)
        const deleted: string[] = []
        const updated: string[] = []
        const nameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)
        names.forEach(name => nameSchema.parse(name))
        if (names.length > 50) throw new HTTPException(400, {message: 'at most 50 secrets are allowed'})
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            for (const name of names) {
                const value = values[name]
                if (value === null) {
                    await client.query(
                        `DELETE FROM project_secrets WHERE project_id = $1 AND name = $2`,
                        [project.id, name],
                    )
                    deleted.push(name)
                    continue
                }
                if (Buffer.byteLength(value, 'utf8') > 16 * 1024) {
                    throw new HTTPException(400, {message: `${name} exceeds 16 KiB`})
                }
                await client.query(
                    `INSERT INTO project_secrets (project_id, name, value_enc)
                     VALUES ($1,$2,$3)
                     ON CONFLICT (project_id, name)
                     DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
                    [project.id, name, this.secrets.encrypt(value)],
                )
                updated.push(name)
            }
            await audit(client, principal.accountId, project.id, 'project.secrets_updated', {updated, deleted})
            await client.query('COMMIT')
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
        return {updated: updated.sort(), deleted: deleted.sort()}
    }

    async beginUpload(principal: Principal, slug: string, expectedSha256: string, expectedSize: number): Promise<Record<string, unknown>> {
        const project = await this.ownedProject(principal, slug)
        if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new HTTPException(400, {message: 'sha256 must be lowercase hex'})
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_SOURCE_BYTES) {
            throw new HTTPException(400, {message: `source must be between 1 and ${MAX_SOURCE_BYTES} bytes`})
        }
        const result = await this.pool.query<{id: string; expires_at: Date}>(
            `INSERT INTO source_uploads (project_id, created_by, expected_sha256, expected_size, expires_at)
             VALUES ($1,$2,$3,$4,now() + interval '1 hour') RETURNING id, expires_at`,
            [project.id, principal.accountId, expectedSha256, expectedSize],
        )
        return {
            uploadId: result.rows[0].id,
            chunkBytes: MAX_CHUNK_BYTES,
            recommendedChunkBytes: RECOMMENDED_CHUNK_BYTES,
            expiresAt: result.rows[0].expires_at.toISOString(),
            hint: 'Send the sha256 of each chunk so a bad chunk is caught on arrival instead of at completion.',
        }
    }

    async uploadChunk(
        principal: Principal,
        uploadId: string,
        chunkIndex: number,
        base64: string,
        expectedChunkSha256?: string,
    ): Promise<{nextChunk: number; chunkSha256: string; replaced: boolean}> {
        if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new HTTPException(400, {message: 'invalid chunkIndex'})
        const data = normalizeChunkBase64(base64)
        const chunkSha256 = sha256Hex(data)
        if (expectedChunkSha256 !== undefined) {
            if (!/^[a-f0-9]{64}$/.test(expectedChunkSha256)) {
                throw new HTTPException(400, {message: 'sha256 must be lowercase hex'})
            }
            // Rejected before storage and without advancing, so the client
            // simply re-sends this one chunk.
            if (expectedChunkSha256 !== chunkSha256) {
                throw new HTTPException(400, {
                    message: `chunk ${chunkIndex} does not match the sha256 you declared: ` +
                        `expected ${expectedChunkSha256}, received ${chunkSha256} over ${data.length} bytes. ` +
                        're-send this chunk; nothing was stored and the upload did not advance',
                })
            }
        }
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const upload = await client.query<{next_chunk: number}>(
                `SELECT u.next_chunk
                 FROM source_uploads u JOIN projects p ON p.id = u.project_id
                 WHERE u.id = $1 AND p.owner_id = $2
                   AND u.completed_at IS NULL AND u.expires_at > now()
                 FOR UPDATE OF u`,
                [uploadId, principal.accountId],
            )
            if (!upload.rowCount) {
                throw new HTTPException(409, {message: 'upload missing or expired; begin a new one'})
            }
            const next = upload.rows[0].next_chunk
            // Re-sending an already-stored chunk is the repair path: a single
            // bad chunk used to mean restarting the entire archive because only
            // an exact match on next_chunk was accepted.
            if (chunkIndex > next) {
                throw new HTTPException(409, {
                    message: `chunk ${chunkIndex} leaves a gap; send chunk ${next} next, ` +
                        `or re-send any chunk from 0 to ${next - 1} to replace it`,
                })
            }
            const replaced = chunkIndex < next
            await client.query(
                `INSERT INTO source_upload_chunks (upload_id, chunk_index, data, sha256) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (upload_id, chunk_index)
                 DO UPDATE SET data = EXCLUDED.data, sha256 = EXCLUDED.sha256`,
                [uploadId, chunkIndex, data, chunkSha256],
            )
            const result = await client.query<{next_chunk: number}>(
                `UPDATE source_uploads SET next_chunk = GREATEST(next_chunk, $2::int + 1), last_error = NULL
                 WHERE id = $1 RETURNING next_chunk`,
                [uploadId, chunkIndex],
            )
            await client.query('COMMIT')
            return {nextChunk: result.rows[0].next_chunk, chunkSha256, replaced}
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    }

    /**
     * Reports what the server actually holds, so a client that failed
     * completion can find the offending chunk instead of re-sending everything.
     */
    async getUpload(principal: Principal, uploadId: string): Promise<Record<string, unknown>> {
        const result = await this.pool.query<{
            expected_sha256: string
            expected_size: string
            next_chunk: number
            last_error: string | null
            expires_at: Date
            completed_at: Date | null
        }>(
            `SELECT u.expected_sha256, u.expected_size, u.next_chunk, u.last_error, u.expires_at, u.completed_at
             FROM source_uploads u JOIN projects p ON p.id = u.project_id
             WHERE u.id = $1 AND p.owner_id = $2`,
            [uploadId, principal.accountId],
        )
        const upload = result.rows[0]
        if (!upload) throw new HTTPException(404, {message: 'upload not found'})
        const chunks = await this.pool.query<{chunk_index: number; bytes: string; sha256: string | null}>(
            `SELECT chunk_index, octet_length(data)::text AS bytes, sha256
             FROM source_upload_chunks WHERE upload_id = $1 ORDER BY chunk_index`,
            [uploadId],
        )
        return {
            uploadId,
            expectedSha256: upload.expected_sha256,
            expectedSize: Number(upload.expected_size),
            receivedBytes: chunks.rows.reduce((total, row) => total + Number(row.bytes), 0),
            nextChunk: upload.next_chunk,
            chunkBytes: MAX_CHUNK_BYTES,
            recommendedChunkBytes: RECOMMENDED_CHUNK_BYTES,
            expiresAt: upload.expires_at.toISOString(),
            completedAt: upload.completed_at?.toISOString() ?? null,
            lastError: upload.last_error,
            chunks: chunks.rows.map(row => ({
                index: row.chunk_index,
                bytes: Number(row.bytes),
                sha256: row.sha256,
            })),
        }
    }

    async abortUpload(principal: Principal, uploadId: string): Promise<{aborted: boolean}> {
        const result = await this.pool.query(
            `DELETE FROM source_uploads u
             USING projects p
             WHERE u.id = $1 AND u.project_id = p.id AND p.owner_id = $2 AND u.completed_at IS NULL`,
            [uploadId, principal.accountId],
        )
        if (!result.rowCount) throw new HTTPException(404, {message: 'active upload not found'})
        return {aborted: true}
    }

    async completeUpload(principal: Principal, uploadId: string): Promise<{sourceRevisionId: string; sha256: string; sizeBytes: number}> {
        const result = await this.pool.query<{
            project_id: string
            expected_sha256: string
            expected_size: string
        }>(
            `UPDATE source_uploads u
             SET completed_at = now()
             FROM projects p
             WHERE u.id = $1 AND u.project_id = p.id AND p.owner_id = $2
               AND u.completed_at IS NULL AND u.expires_at > now()
             RETURNING u.project_id, u.expected_sha256, u.expected_size`,
            [uploadId, principal.accountId],
        )
        const upload = result.rows[0]
        if (!upload) throw new HTTPException(404, {message: 'active upload not found'})
        const chunks = await this.pool.query<{chunk_index: number; data: Buffer}>(
            `SELECT chunk_index, data FROM source_upload_chunks WHERE upload_id = $1 ORDER BY chunk_index`,
            [uploadId],
        )
        const assembled = Buffer.concat(chunks.rows.map(row => row.data))
        const expectedSize = Number(upload.expected_size)
        const actualSha256 = sha256Hex(assembled)
        if (assembled.length !== expectedSize || actualSha256 !== upload.expected_sha256) {
            // The chunks are deliberately kept. Recovery used to require a
            // whole new begin_source_upload because next_chunk was never
            // rewound and the stored chunks were never cleared, so one bad
            // chunk cost the entire archive.
            const message = describeUploadMismatch({
                expectedSize,
                expectedSha256: upload.expected_sha256,
                actualSize: assembled.length,
                actualSha256,
                chunks: chunks.rows.map(row => ({index: row.chunk_index, bytes: row.data.length})),
                chunkBytes: MAX_CHUNK_BYTES,
            })
            await this.pool.query(
                `UPDATE source_uploads SET completed_at = NULL, last_error = $2 WHERE id = $1`,
                [uploadId, message],
            )
            throw new HTTPException(400, {message})
        }
        try {
            return await this.persistSource(principal, upload.project_id, assembled, {
                expectedSha256: upload.expected_sha256,
                expectedSize,
            })
        } catch (error) {
            await this.pool.query(
                `UPDATE source_uploads SET completed_at = NULL, last_error = $2 WHERE id = $1`,
                [uploadId, error instanceof Error ? error.message.slice(0, 2_000) : 'upload failed'],
            )
            throw error
        }
    }

    async uploadSource(principal: Principal, slug: string, body: Uint8Array, expectedSha256?: string): Promise<{sourceRevisionId: string; sha256: string; sizeBytes: number}> {
        const project = await this.ownedProject(principal, slug)
        return await this.persistSource(principal, project.id, Buffer.from(body), {expectedSha256})
    }

    async createVersion(principal: Principal, slug: string, sourceRevisionId: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
        const project = await this.ownedProject(principal, slug)
        if (idempotencyKey && idempotencyKey.length > 200) {
            throw new HTTPException(400, {message: 'idempotency key exceeds 200 characters'})
        }
        const operationKey = idempotencyKey
            ? `build:${project.id}:${idempotencyKey}`
            : `build:${project.id}:${randomUUID()}`
        const source = await this.pool.query(
            `SELECT id FROM source_revisions WHERE id = $1 AND project_id = $2`,
            [sourceRevisionId, project.id],
        )
        if (!source.rowCount) throw new HTTPException(404, {message: 'source revision not found'})
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            if (idempotencyKey) {
                const existing = await client.query(
                    `SELECT v.* FROM jobs j JOIN versions v ON v.id = j.version_id
                     WHERE j.idempotency_key = $1 AND j.kind = 'build_version'
                       AND j.project_id = $2 AND v.project_id = $2
                     FOR UPDATE OF v`,
                    [operationKey, project.id],
                )
                if (existing.rows[0]) {
                    if (existing.rows[0].source_revision_id !== sourceRevisionId) {
                        throw new HTTPException(409, {message: 'idempotency key was already used for another source revision'})
                    }
                    await client.query('COMMIT')
                    return versionJson(existing.rows[0], this.domain, project.slug)
                }
            }
            const result = await client.query<{id: string; status: string; created_at: Date}>(
                `INSERT INTO versions (project_id, source_revision_id, created_by)
                 VALUES ($1,$2,$3) RETURNING id, status, created_at`,
                [project.id, sourceRevisionId, principal.accountId],
            )
            await client.query(
                `INSERT INTO jobs (kind, project_id, version_id, idempotency_key)
                 VALUES ('build_version',$1,$2,$3)`,
                [project.id, result.rows[0].id, operationKey],
            )
            await audit(client, principal.accountId, project.id, 'version.created', {versionId: result.rows[0].id})
            await client.query('COMMIT')
            return versionJson(result.rows[0], this.domain, project.slug)
        } catch (error: any) {
            await client.query('ROLLBACK')
            if (error?.code === '23505' && idempotencyKey) {
                const existing = await this.pool.query(
                    `SELECT v.* FROM jobs j JOIN versions v ON v.id = j.version_id
                     WHERE j.idempotency_key = $1 AND j.kind = 'build_version'
                       AND j.project_id = $2 AND v.project_id = $2`,
                    [operationKey, project.id],
                )
                if (existing.rows[0]) {
                    if (existing.rows[0].source_revision_id !== sourceRevisionId) {
                        throw new HTTPException(409, {message: 'idempotency key was already used for another source revision'})
                    }
                    return versionJson(existing.rows[0], this.domain, project.slug)
                }
            }
            throw error
        } finally {
            client.release()
        }
    }

    async listVersions(principal: Principal, slug: string): Promise<Record<string, unknown>[]> {
        const project = await this.ownedProject(principal, slug)
        const result = await this.pool.query(
            `SELECT id, status, artifact_bytes, error_message, created_at, finished_at
             FROM versions WHERE project_id = $1 ORDER BY created_at DESC`,
            [project.id],
        )
        return result.rows.map(row => versionJson(row, this.domain, project.slug))
    }

    async getVersion(principal: Principal, slug: string, versionId: string): Promise<Record<string, unknown>> {
        const project = await this.ownedProject(principal, slug)
        const result = await this.pool.query(
            `SELECT id, status, artifact_bytes, error_message, manifest, created_at, finished_at
             FROM versions WHERE id = $1 AND project_id = $2`,
            [versionId, project.id],
        )
        if (!result.rowCount) throw new HTTPException(404, {message: 'version not found'})
        return versionJson(result.rows[0], this.domain, project.slug)
    }

    async deploy(principal: Principal, slug: string, versionId: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
        const project = await this.ownedProject(principal, slug)
        if (idempotencyKey && idempotencyKey.length > 200) {
            throw new HTTPException(400, {message: 'idempotency key exceeds 200 characters'})
        }
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const lockedProject = await client.query<{current_version_id: string | null}>(
                `SELECT current_version_id FROM projects WHERE id = $1 FOR UPDATE`,
                [project.id],
            )
            const ready = await client.query(
                `SELECT id FROM versions WHERE id = $1 AND project_id = $2 AND status = 'ready' FOR UPDATE`,
                [versionId, project.id],
            )
            if (!ready.rowCount) throw new HTTPException(409, {message: 'version is not ready'})
            const operationKey = idempotencyKey
                ? `deploy:${project.id}:${idempotencyKey}`
                : `deploy:${project.id}:${randomUUID()}`
            const existing = await client.query<DeploymentRow>(
                `SELECT d.*
                 FROM jobs j JOIN deployments d ON d.id = j.deployment_id
                 WHERE j.idempotency_key = $1
                 FOR UPDATE OF d`,
                [operationKey],
            )
            if (existing.rows[0]) {
                if (existing.rows[0].version_id !== versionId) {
                    throw new HTTPException(409, {message: 'idempotency key was already used for another version'})
                }
                await client.query('COMMIT')
                return deploymentJson(existing.rows[0], this.domain, project.slug)
            }
            const deployment = await client.query<DeploymentRow>(
                `INSERT INTO deployments (project_id, version_id, previous_version_id, created_by)
                 VALUES ($1,$2,$3,$4) RETURNING *`,
                [project.id, versionId, lockedProject.rows[0].current_version_id, principal.accountId],
            )
            await client.query(
                `INSERT INTO jobs (kind, project_id, version_id, deployment_id, idempotency_key)
                 VALUES ('deploy_version',$1,$2,$3,$4)`,
                [project.id, versionId, deployment.rows[0].id, operationKey],
            )
            await audit(client, principal.accountId, project.id, 'deployment.queued', {versionId, deploymentId: deployment.rows[0].id})
            await client.query('COMMIT')
            return deploymentJson(deployment.rows[0], this.domain, project.slug)
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    }

    async getDeployment(principal: Principal, slug: string, deploymentId: string): Promise<Record<string, unknown>> {
        const project = await this.ownedProject(principal, slug)
        const result = await this.pool.query<DeploymentRow>(
            `SELECT * FROM deployments WHERE id = $1 AND project_id = $2`,
            [deploymentId, project.id],
        )
        if (!result.rowCount) throw new HTTPException(404, {message: 'deployment not found'})
        return deploymentJson(result.rows[0], this.domain, project.slug)
    }

    async logs(principal: Principal, slug: string, limit = 200): Promise<Record<string, unknown>[]> {
        const project = await this.ownedProject(principal, slug)
        const result = await this.pool.query(
            `SELECT id, version_id, source, level, message, created_at
             FROM project_logs WHERE project_id = $1 ORDER BY id DESC LIMIT $2`,
            [project.id, Math.max(1, Math.min(limit, 1000))],
        )
        return result.rows.reverse().map(row => ({
            id: String(row.id),
            versionId: row.version_id,
            source: row.source,
            level: row.level,
            message: row.message,
            createdAt: row.created_at.toISOString(),
        }))
    }

    /**
     * Who has been to this site, for its owner.
     *
     * Counted at the gateway from real requests, so it needs nothing in the
     * page and a project's own code can neither contribute to it nor see it.
     *
     * Two limits are worth knowing before reading the numbers. Only a
     * navigation counts, so a single-page app that routes on the client reports
     * the load that started the session and not the screens after it — the
     * figure is page loads, not page views. And an owner's own visits to their
     * own `network` or `showcase` site are counted like anyone else's, because
     * on those tiers the browser carries no platform cookie to recognise them
     * by; only owner-only sites, which do, are filtered.
     */
    async analytics(principal: Principal, slug: string, days = DEFAULT_READ_DAYS): Promise<SiteAnalytics> {
        const project = await this.ownedProject(principal, slug)
        const window = Math.max(1, Math.min(Math.trunc(days) || DEFAULT_READ_DAYS, MAX_READ_DAYS))
        // The window is a range of campus-local calendar days, computed here
        // and bound, never derived in SQL. lib/analytics.ts says why.
        const today = visitDay(new Date(), this.analyticsTimeZone)
        const from = dayBefore(today, window - 1)
        const range = [project.id, from, today]
        const [totals, unique, series] = await Promise.all([
            this.pool.query<{views: string; api_requests: string}>(VISIT_TOTALS_SQL, range),
            this.pool.query<{visitors: number}>(VISITOR_TOTAL_SQL, range),
            this.pool.query<{day: string; views: string; api_requests: string; visitors: number}>(
                VISIT_SERIES_SQL, range),
        ])
        return {
            days: window,
            views: Number(totals.rows[0]?.views ?? 0),
            apiRequests: Number(totals.rows[0]?.api_requests ?? 0),
            visitors: Number(unique.rows[0]?.visitors ?? 0),
            daily: fillDays(
                series.rows.map(row => ({
                    day: row.day,
                    views: Number(row.views),
                    apiRequests: Number(row.api_requests),
                    visitors: Number(row.visitors),
                })),
                today,
                window,
            ),
        }
    }

    async renderVersion(principal: Principal, slug: string, versionId: string): Promise<Record<string, unknown>> {
        const project = await this.ownedProject(principal, slug)
        const version = await this.pool.query(`SELECT id FROM versions WHERE id = $1 AND project_id = $2 AND status = 'ready'`, [versionId, project.id])
        if (!version.rowCount) throw new HTTPException(409, {message: 'version is not ready'})
        // Only a failed render is re-run: a succeeded job still owns its cached
        // screenshot, and the 24h GC marks the job failed when that expires.
        const job = await enqueueRerunnable(
            this.pool,
            'render_version',
            project.id,
            versionId,
            `render:${project.id}:${versionId}`,
            ['failed'],
        )
        const previewUrl = `https://${slug}--v-${versionId.replace(/-/g, '').slice(0, 10)}.${this.domain}`
        const deadline = Date.now() + renderBudget().pollMs
        while (Date.now() < deadline) {
            const result = await this.pool.query<{
                status: string
                error_message: string | null
                screenshot_path: string | null
                diagnostics: Record<string, unknown> | null
            }>(
                `SELECT j.status, j.error_message, r.screenshot_path, r.diagnostics
                 FROM jobs j LEFT JOIN render_results r ON r.job_id = j.id
                 WHERE j.id = $1`,
                [job.jobId],
            )
            const row = result.rows[0]
            if (row?.status === 'succeeded' && row.screenshot_path) {
                return {
                    previewUrl,
                    screenshotBase64: (await readFile(row.screenshot_path)).toString('base64'),
                    mimeType: 'image/png',
                    diagnostics: row.diagnostics ?? {},
                }
            }
            if (row?.status === 'failed') {
                // Returning 200 with the diagnostics on purpose. The console
                // output and page errors captured during the failed render are
                // the whole point of asking, and a bare 502 threw them away.
                return {
                    status: 'failed',
                    previewUrl,
                    error: row.error_message ?? 'render failed',
                    diagnostics: row.diagnostics ?? {},
                }
            }
            await new Promise(resolve => setTimeout(resolve, 500))
        }
        return {status: 'queued', jobId: job.jobId, previewUrl, retryAfterSeconds: 10}
    }

    /**
     * Makes one HTTP request to a version's private host and returns the
     * response.
     *
     * Deployed sites are LAN-only, so an author working over MCP could not call
     * their own `/api` at all. The caller names a path; the host comes from the
     * project and version they own, so this cannot be pointed anywhere else.
     */
    async probeVersion(principal: Principal, slug: string, versionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
        const project = await this.ownedProject(principal, slug)
        const version = await this.pool.query(
            `SELECT id FROM versions WHERE id = $1 AND project_id = $2 AND status = 'ready'`,
            [versionId, project.id],
        )
        if (!version.rowCount) throw new HTTPException(409, {message: 'version is not ready'})
        const request = parseProbeRequest(input)
        // Distinct per request: a probe is an action, not a cacheable lookup.
        const job = await enqueueRerunnable(
            this.pool,
            'probe_version',
            project.id,
            versionId,
            `probe:${project.id}:${versionId}:${randomUUID()}`,
        )
        await this.pool.query(
            `INSERT INTO probe_results (job_id, project_id, version_id, request) VALUES ($1,$2,$3,$4)
             ON CONFLICT (job_id) DO UPDATE SET request = EXCLUDED.request, response = NULL, created_at = now()`,
            [job.jobId, project.id, versionId, JSON.stringify(request)],
        )
        const deadline = Date.now() + renderBudget().pollMs
        while (Date.now() < deadline) {
            const result = await this.pool.query<{
                status: string
                error_message: string | null
                response: Record<string, unknown> | null
            }>(
                `SELECT j.status, j.error_message, r.response
                 FROM jobs j JOIN probe_results r ON r.job_id = j.id WHERE j.id = $1`,
                [job.jobId],
            )
            const row = result.rows[0]
            if (row?.status === 'succeeded' && row.response) {
                return {request: {path: request.path, method: request.method}, ...row.response}
            }
            if (row?.status === 'failed') {
                return {
                    status: 'failed',
                    request: {path: request.path, method: request.method},
                    error: row.error_message ?? 'probe failed',
                }
            }
            await new Promise(resolve => setTimeout(resolve, 500))
        }
        return {status: 'queued', jobId: job.jobId, retryAfterSeconds: 10}
    }

    /**
     * Produces a downloadable dump of the project database.
     *
     * A schema-only export is returned inline, because it holds no tenant rows
     * and is what an agent actually needs to reason about the database. A full
     * export is never returned inline: it can be hundreds of megabytes and
     * every row would land in the caller's transcript and the model's context.
     * It is fetched from an authenticated route instead.
     */
    async exportDatabase(principal: Principal, slug: string, include: 'schema' | 'all'): Promise<Record<string, unknown>> {
        const project = await this.ownedProject(principal, slug)
        if (!project.postgres_enabled) {
            throw new HTTPException(409, {message: 'this project has no PostgreSQL database'})
        }
        const state = await this.pool.query<{provision_state: string}>(
            `SELECT provision_state FROM project_resources WHERE project_id = $1`,
            [project.id],
        )
        if (state.rows[0]?.provision_state !== 'ready') {
            throw new HTTPException(409, {message: 'database provisioning has not finished for this project'})
        }
        const includeData = include === 'all'
        const recent = await this.pool.query<{created_at: Date}>(
            `SELECT created_at FROM database_exports
             WHERE project_id = $1 AND created_at > now() - interval '5 minutes' AND file_path IS NOT NULL
             ORDER BY created_at DESC LIMIT 1`,
            [project.id],
        )
        if (recent.rowCount) {
            throw new HTTPException(429, {
                message: 'an export for this project was produced within the last five minutes; ' +
                    'download that one or wait before requesting another',
            })
        }
        const job = await enqueueRerunnable(
            this.pool,
            'export_database',
            project.id,
            null,
            `export:${project.id}:${includeData ? 'all' : 'schema'}`,
        )
        await this.pool.query(
            `INSERT INTO database_exports (job_id, project_id, requested_by, include_data, expires_at)
             VALUES ($1,$2,$3,$4, now() + interval '1 hour')
             ON CONFLICT (job_id) DO UPDATE
             SET include_data = EXCLUDED.include_data, requested_by = EXCLUDED.requested_by,
                 expires_at = EXCLUDED.expires_at, created_at = now(),
                 file_path = NULL, size_bytes = NULL, sha256 = NULL, schema_sql = NULL, error_message = NULL`,
            [job.jobId, project.id, principal.accountId, includeData],
        )
        await audit(this.pool, principal.accountId, project.id, 'database.export_requested', {include})

        const deadline = Date.now() + 55_000
        while (Date.now() < deadline) {
            const result = await this.pool.query<{
                status: string
                error_message: string | null
                file_path: string | null
                size_bytes: string | null
                sha256: string | null
                schema_sql: string | null
                expires_at: Date
            }>(
                `SELECT j.status, j.error_message, e.file_path, e.size_bytes, e.sha256, e.schema_sql, e.expires_at
                 FROM jobs j JOIN database_exports e ON e.job_id = j.id
                 WHERE j.id = $1`,
                [job.jobId],
            )
            const row = result.rows[0]
            if (row?.status === 'succeeded' && row.file_path) {
                return {
                    status: 'ready',
                    include,
                    downloadUrl: `https://${this.domain}/v1/projects/${encodeURIComponent(slug)}/database/exports/${job.jobId}/download`,
                    downloadNote: 'Authenticate the download with the same bearer token or dashboard session; the URL alone grants nothing.',
                    sizeBytes: Number(row.size_bytes ?? 0),
                    sha256: row.sha256,
                    expiresAt: row.expires_at.toISOString(),
                    ...(includeData ? {} : {schemaSql: truncate(row.schema_sql ?? '', 256 * 1024)}),
                }
            }
            if (row?.status === 'failed') {
                return {status: 'failed', include, error: row.error_message ?? 'export failed'}
            }
            await new Promise(resolve => setTimeout(resolve, 500))
        }
        return {status: 'queued', jobId: job.jobId, retryAfterSeconds: 15}
    }

    /** Resolves an export to a file on disk, for the authenticated download route. */
    async exportFile(principal: Principal, slug: string, jobId: string): Promise<{path: string; filename: string; sizeBytes: number}> {
        const project = await this.ownedProject(principal, slug)
        const result = await this.pool.query<{file_path: string | null; size_bytes: string | null}>(
            `SELECT file_path, size_bytes FROM database_exports
             WHERE job_id = $1 AND project_id = $2 AND expires_at > now()`,
            [jobId, project.id],
        )
        const row = result.rows[0]
        if (!row?.file_path) throw new HTTPException(404, {message: 'export not found or expired'})
        // Checked before any header is written. Streaming a file that turns out
        // to be unreadable sends a 200 and then tears the connection, which
        // reaches the client as an opaque transport error.
        try {
            await access(row.file_path, constants.R_OK)
        } catch {
            throw new HTTPException(500, {
                message: 'the export file is present but not readable by the control plane; check /data/dumps ownership',
            })
        }
        return {
            path: row.file_path,
            filename: `${slug}-${jobId.slice(0, 8)}.sql.gz`,
            sizeBytes: Number(row.size_bytes ?? 0),
        }
    }

    /**
     * Schedule a project's purge.
     *
     * `immediate` brings the purge to now instead of seven days out, and is
     * refused to anyone but an operator acting on a project they own — see
     * `assertImmediatePurge`. Everything else is the same path: the same status,
     * the same job, the same key revocation. Only the clock moves.
     */
    async delete(
        principal: Principal,
        slug: string,
        confirmation: string,
        immediate = false,
    ): Promise<{deletedAt: string; purgeAfter: string; immediate: boolean}> {
        if (confirmation !== slug) throw new HTTPException(400, {message: 'confirmation must exactly match the slug'})
        const project = await this.ownedProject(principal, slug)
        if (immediate) await this.assertImmediatePurge(principal, project)
        if (project.status === 'deleting' && project.deleted_at && project.purge_after) {
            // Already pending. Without `immediate` this only re-enqueues a job
            // that may have been lost; with it, the window the first delete
            // opened is closed now, which is the whole point of asking twice.
            if (!immediate) {
                await enqueue(this.pool, 'delete_project', project.id, null, `delete:${project.id}`, project.purge_after)
                return {
                    deletedAt: project.deleted_at.toISOString(),
                    purgeAfter: project.purge_after.toISOString(),
                    immediate: false,
                }
            }
            const pulled = await this.pool.query<{deleted_at: Date; purge_after: Date}>(
                `UPDATE projects SET purge_after = now(), updated_at = now()
                 WHERE id = $1 AND status = 'deleting' RETURNING deleted_at, purge_after`,
                [project.id],
            )
            if (!pulled.rowCount) throw new HTTPException(409, {message: 'project is no longer pending deletion'})
            await audit(this.pool, principal.accountId, project.id, 'project.deletion_requested', {
                purgeAfter: pulled.rows[0].purge_after,
                immediate: true,
            })
            await this.runPurgeNow(project.id)
            return {
                deletedAt: pulled.rows[0].deleted_at.toISOString(),
                purgeAfter: pulled.rows[0].purge_after.toISOString(),
                immediate: true,
            }
        }
        const result = await this.pool.query<{deleted_at: Date; purge_after: Date}>(
            `UPDATE projects
             SET status = 'deleting', deleted_at = now(),
                 purge_after = now() + $2::interval, updated_at = now()
             WHERE id = $1 RETURNING deleted_at, purge_after`,
            [project.id, immediate ? '0 seconds' : '7 days'],
        )
        // Revoked at the deletion request rather than at purge: a project in its
        // seven-day grace window should not keep holding a share of shared
        // inference capacity. `restore` mints a replacement. The executor cannot
        // do this at purge time — it has no egress to the proxy.
        const revoked = project.llm_enabled ? await this.revokeLlmKey(project.id) : null
        // Recorded before the job is queued, not after. `audit_events.project_id`
        // is a real foreign key, and an immediate purge deletes the project row
        // within a poll interval — writing the record second means the one
        // deletion that cannot be undone is the one that races its own audit
        // trail into a foreign key violation. The seven-day path does not have
        // the race, and is ordered the same way rather than differently.
        await audit(this.pool, principal.accountId, project.id, 'project.deletion_requested', {
            purgeAfter: result.rows[0].purge_after,
            ...(immediate ? {immediate: true} : {}),
            ...(revoked === null ? {} : {llmKeyRevoked: revoked}),
        })
        if (immediate) await this.runPurgeNow(project.id)
        else await enqueue(this.pool, 'delete_project', project.id, null, `delete:${project.id}`, result.rows[0].purge_after)
        return {
            deletedAt: result.rows[0].deleted_at.toISOString(),
            purgeAfter: result.rows[0].purge_after.toISOString(),
            immediate,
        }
    }

    /**
     * Who may skip the recovery window.
     *
     * Two conditions, and they are separate on purpose. The role is re-read from
     * the control database because the principal carries the role its token was
     * issued with for up to twelve hours, and this is not a decision to make on
     * a claim that may already have been revoked. Ownership is checked because
     * `ownedProject` deliberately lets an operator reach any project: the
     * seven-day window is the *owner's* recourse, and an operator taking it away
     * from somebody else is a different act from an operator cleaning up after
     * themselves. An operator who must purge another person's project can still
     * delete it and wait, or move `purge_after` in SQL.
     */
    private async assertImmediatePurge(principal: Principal, project: ProjectRow): Promise<void> {
        await assertOperator(this.pool, principal)
        if (project.owner_id !== principal.accountId) {
            throw new HTTPException(403, {
                message: 'immediate purge is limited to projects you own;'
                    + ' delete it and let the seven-day window run instead',
            })
        }
    }

    /**
     * Put the purge job at the front of the queue for a project whose
     * `purge_after` has already been brought to now.
     *
     * `enqueue` alone is not enough: its ON CONFLICT DO NOTHING makes it a no-op
     * against the job a previous delete already queued seven days out, which is
     * exactly the row that has to move. Resetting from `queued` is what pulls
     * that row forward; `running` is excluded so a purge already in flight is
     * never disturbed — it is doing the requested work anyway.
     */
    private async runPurgeNow(projectId: string): Promise<void> {
        await enqueueRerunnable(
            this.pool,
            'delete_project',
            projectId,
            null,
            `delete:${projectId}`,
            ['queued', 'succeeded', 'failed'],
        )
    }

    async restore(principal: Principal, slug: string): Promise<ProjectSummary> {
        const project = await this.ownedProject(principal, slug)
        if (project.status !== 'deleting') throw new HTTPException(409, {message: 'project is not pending deletion'})
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const restored = await client.query(
                `UPDATE projects p
                 SET status = CASE
                         WHEN r.postgres_bytes >= p.database_bytes_max OR r.object_bytes >= p.object_bytes_max
                         THEN 'storage_exceeded'
                         ELSE 'ready'
                     END,
                     deleted_at = NULL, purge_after = NULL, updated_at = now()
                 FROM project_resources r
                 WHERE p.id = $1 AND r.project_id = p.id AND p.status = 'deleting'
                 RETURNING p.id`,
                [project.id],
            )
            if (!restored.rowCount) throw new HTTPException(409, {message: 'project can no longer be restored'})
            await client.query(
                `DELETE FROM jobs
                 WHERE idempotency_key = $1 AND kind = 'delete_project' AND status = 'queued'`,
                [`delete:${project.id}`],
            )
            await audit(client, principal.accountId, project.id, 'project.restored')
            await client.query('COMMIT')
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
        // The key was revoked when deletion was requested, so a restored project
        // needs a fresh one. It keeps whatever limits an operator raised it to.
        if (project.llm_enabled && this.llm) {
            const minted = await this.mintOrFail(project.id, slug, {rpm: project.llm_rpm_max, tpm: project.llm_tpm_max})
            await this.pool.query(
                `UPDATE project_resources
                 SET llm_key_enc = $2, llm_key_alias = $3, llm_key_expires_at = $4
                 WHERE project_id = $1`,
                [project.id, this.secrets.encrypt(minted.key), minted.alias, minted.expiresAt],
            )
        }
        return await this.get(principal, slug)
    }

    private async persistSource(
        principal: Principal,
        projectId: string,
        data: Buffer,
        opts: {expectedSha256?: string; expectedSize?: number},
    ): Promise<{sourceRevisionId: string; sha256: string; sizeBytes: number}> {
        if (!data.length || data.length > MAX_SOURCE_BYTES) throw new HTTPException(413, {message: `source exceeds ${MAX_SOURCE_BYTES} bytes`})
        if (opts.expectedSize !== undefined && data.length !== opts.expectedSize) throw new HTTPException(400, {message: 'source size mismatch'})
        const digest = createHash('sha256').update(data).digest('hex')
        if (opts.expectedSha256 && digest !== opts.expectedSha256) throw new HTTPException(400, {message: 'source sha256 mismatch'})
        const revisionId = randomUUID()
        const dir = resolve(this.sourceRoot, projectId)
        await mkdir(dir, {recursive: true, mode: 0o700})
        const archivePath = resolve(dir, `${revisionId}.tar.gz`)
        if (!archivePath.startsWith(dir + '/')) throw new Error('invalid archive path')
        await writeFile(archivePath, data, {mode: 0o600})
        const result = await this.pool.query<{id: string; archive_path: string}>(
            `INSERT INTO source_revisions (id, project_id, sha256, archive_path, size_bytes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (project_id, sha256)
             DO UPDATE SET sha256 = source_revisions.sha256
             RETURNING id, archive_path`,
            [revisionId, projectId, digest, archivePath, data.length, principal.accountId],
        )
        if (result.rows[0].archive_path !== archivePath) await rm(archivePath, {force: true})
        await audit(this.pool, principal.accountId, projectId, 'source.uploaded', {sha256: digest, sizeBytes: data.length})
        return {sourceRevisionId: result.rows[0].id, sha256: digest, sizeBytes: data.length}
    }

    /**
     * Best effort by design: a proxy outage must not block a deletion the owner
     * asked for. The outcome is recorded in the audit trail so an operator can
     * clear a stranded key by alias.
     */
    private async revokeLlmKey(projectId: string): Promise<boolean> {
        if (!this.llm) return false
        try {
            await this.llm.revoke(projectId)
        } catch {
            return false
        }
        await this.pool.query(
            `UPDATE project_resources
             SET llm_key_enc = NULL, llm_key_alias = NULL, llm_key_expires_at = NULL
             WHERE project_id = $1`,
            [projectId],
        )
        return true
    }

    /**
     * The proxy enforces the limits; the platform only chooses them. A project
     * being created has not been customised yet, so it takes the same defaults
     * the columns declare. A project being restored keeps whatever an operator
     * raised it to, which is why `restore` passes its own row values in.
     *
     * A minted key is reported ready without being exercised. `LlmService.mint`
     * carries the reasoning, including why an auth-only probe would have
     * reported "verified" during the one failure that suggested probing at all.
     */
    private async mintOrFail(projectId: string, slug: string, limits: LlmKeyLimits = DEFAULT_LLM_LIMITS) {
        if (!this.llm) throw new HTTPException(503, {message: 'the managed LLM binding is not configured on this deployment'})
        try {
            return await this.llm.mint({id: projectId, slug}, limits)
        } catch (error: any) {
            throw new HTTPException(502, {message: `could not provision an LLM key: ${error?.message ?? error}`})
        }
    }

    private async ownedProject(principal: Principal, slug: string): Promise<ProjectRow> {
        slugSchema.parse(slug)
        const result = await this.pool.query<ProjectRow>(
            `${projectSelect()} WHERE p.slug = $1 AND p.status <> 'deleted'`,
            [slug],
        )
        const row = result.rows[0]
        if (!row) throw new HTTPException(404, {message: 'project not found'})
        if (row.owner_id !== principal.accountId && !roleAtLeast(principal.role, 'operator')) {
            throw new HTTPException(403, {message: 'forbidden'})
        }
        return row
    }

    private map(row: ProjectRow): ProjectSummary {
        return {
            id: row.id,
            slug: row.slug,
            url: `https://${row.slug}.${this.domain}`,
            access: row.access_mode,
            status: row.status,
            currentVersionId: row.current_version_id,
            createdAt: row.created_at.toISOString(),
            showcase: {
                description: row.showcase_description ?? '',
                // A path is never handed out. The bytes are served by a route
                // that re-checks the caller, so a URL that leaks is inert.
                screenshotUrl: row.showcase_shot_at
                    ? `/v1/showcase/${row.slug}/screenshot.png`
                    : null,
                screenshotSource: row.showcase_shot_source ?? null,
                capturedAt: row.showcase_shot_at?.toISOString() ?? null,
                draft: row.showcase_draft ?? null,
                draftAt: row.showcase_draft_at?.toISOString() ?? null,
            },
            resources: {
                postgres: row.postgres_enabled,
                storage: row.storage_enabled,
                llm: row.llm_enabled,
                provisionState: row.provision_state ?? 'pending',
                provisionError: row.provision_error ?? null,
            },
            quota: {
                runtimeMemoryMiB: row.runtime_memory_mb,
                runtimeCpu: Number(row.runtime_cpu),
                postgresBytes: Number(row.database_bytes_max),
                objectBytes: Number(row.object_bytes_max),
                versions: row.version_limit,
                llmRequestsPerMinute: row.llm_rpm_max,
                llmTokensPerMinute: row.llm_tpm_max,
            },
            usage: {
                postgresBytes: Number(row.postgres_bytes ?? 0),
                objectBytes: Number(row.object_bytes ?? 0),
                measuredAt: row.measured_at?.toISOString() ?? null,
            },
        }
    }
}

function projectSelect(): string {
    return `SELECT p.*, r.postgres_bytes, r.object_bytes, r.measured_at,
                   r.provision_state, r.provision_error
            FROM projects p LEFT JOIN project_resources r ON r.project_id = p.id`
}

function versionJson(row: any, domain: string, slug: string): Record<string, unknown> {
    const id = row.id as string
    return {
        id,
        status: row.status,
        previewUrl: `https://${slug}--v-${id.replace(/-/g, '').slice(0, 10)}.${domain}`,
        artifactBytes: row.artifact_bytes === null || row.artifact_bytes === undefined ? null : Number(row.artifact_bytes),
        manifest: row.manifest ?? null,
        error: row.error_message ?? null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at ?? null,
    }
}

function deploymentJson(row: DeploymentRow, domain: string, slug: string): Record<string, unknown> {
    return {
        id: row.id,
        status: row.status,
        project: slug,
        versionId: row.version_id,
        previousVersionId: row.previous_version_id,
        url: `https://${slug}.${domain}`,
        error: row.error_message,
        createdAt: row.created_at.toISOString(),
        activatedAt: row.activated_at?.toISOString() ?? null,
    }
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value
    return `${value.slice(0, limit)}\n-- truncated at ${limit} characters; download the export for the full schema\n`
}

export async function enqueue(
    db: Pool | PoolClient,
    kind: string,
    projectId: string | null,
    versionId: string | null,
    idempotencyKey: string,
    runAfter?: Date,
): Promise<void> {
    await db.query(
        `INSERT INTO jobs (kind, project_id, version_id, idempotency_key, run_after)
         VALUES ($1,$2,$3,$4,COALESCE($5,now()))
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [kind, projectId, versionId, idempotencyKey, runAfter ?? null],
    )
}

/**
 * Enqueue a job that is allowed to run again under the same idempotency key.
 *
 * `enqueue` uses ON CONFLICT DO NOTHING, which makes a key like
 * `provision:<id>` a permanent no-op — that is why PostgreSQL could never be
 * added to a project after creation. This variant resets a job that has reached
 * one of `rerunFrom` back to queued, and leaves a queued or running job strictly
 * alone so a caller cannot disturb work in flight.
 *
 * The reset is expressed as CASE arms rather than a WHERE on DO UPDATE
 * deliberately: with a WHERE, a conflicting row that fails the predicate
 * returns no row at all, and every caller here needs the job id back whatever
 * state the job is in.
 */
export async function enqueueRerunnable(
    db: Pool | PoolClient,
    kind: string,
    projectId: string | null,
    versionId: string | null,
    idempotencyKey: string,
    rerunFrom: readonly string[] = ['succeeded', 'failed'],
): Promise<{jobId: string; status: string}> {
    const result = await db.query<{id: string; status: string}>(
        `INSERT INTO jobs (kind, project_id, version_id, idempotency_key)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (idempotency_key) DO UPDATE SET
             status        = CASE WHEN jobs.status = ANY($5) THEN 'queued' ELSE jobs.status END,
             run_after     = CASE WHEN jobs.status = ANY($5) THEN now()    ELSE jobs.run_after END,
             attempts      = CASE WHEN jobs.status = ANY($5) THEN 0        ELSE jobs.attempts END,
             locked_at     = CASE WHEN jobs.status = ANY($5) THEN NULL     ELSE jobs.locked_at END,
             locked_by     = CASE WHEN jobs.status = ANY($5) THEN NULL     ELSE jobs.locked_by END,
             finished_at   = CASE WHEN jobs.status = ANY($5) THEN NULL     ELSE jobs.finished_at END,
             error_message = CASE WHEN jobs.status = ANY($5) THEN NULL     ELSE jobs.error_message END
         RETURNING id, status`,
        [kind, projectId, versionId, idempotencyKey, [...rerunFrom]],
    )
    return {jobId: result.rows[0].id, status: result.rows[0].status}
}

export async function audit(
    db: Pool | PoolClient,
    accountId: string | null,
    projectId: string | null,
    action: string,
    metadata: unknown = {},
): Promise<void> {
    await db.query(
        `INSERT INTO audit_events (account_id, project_id, action, metadata) VALUES ($1,$2,$3,$4)`,
        [accountId, projectId, action, JSON.stringify(metadata)],
    )
}
