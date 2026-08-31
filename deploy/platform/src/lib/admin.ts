import {HTTPException} from 'hono/http-exception'
import type {Pool} from 'pg'
import type {PlatformRole, Principal} from './authn'
import {audit, effectiveProjectQuota, enqueueRerunnable, OPERATOR_PROJECT_QUOTA} from './projects'

/**
 * The operator view answers "what is the platform doing right now", and every
 * read method here serves it without returning a secret, token, or credential
 * column.
 *
 * `AdminWriteService` is the separate half that changes things. The split is
 * the point: reads are open to `operator`, writes are open to `superadmin`
 * alone, and keeping them in different classes means a new read method cannot
 * acquire write authority by being added to the wrong file.
 */
export class AdminService {
    constructor(
        private readonly pool: Pool,
        private readonly domain: string,
        private readonly operatorProjectQuota: number = OPERATOR_PROJECT_QUOTA,
    ) {}

    async overview(): Promise<Record<string, unknown>> {
        const totals = await this.pool.query<{
            accounts: string
            operators: string
            accounts_active_30d: string
            projects: string
            projects_live: string
            active_tokens: string
            postgres_bytes: string
            object_bytes: string
            postgres_bytes_max: string
            object_bytes_max: string
            versions_24h: string
            deployments_24h: string
            failed_deployments_24h: string
        }>(`
            SELECT
                (SELECT count(*) FROM accounts)::text AS accounts,
                (SELECT count(*) FROM accounts WHERE platform_role = 'operator')::text AS operators,
                (SELECT count(*) FROM accounts WHERE last_login_at > now() - interval '30 days')::text AS accounts_active_30d,
                (SELECT count(*) FROM projects WHERE status <> 'deleted')::text AS projects,
                (SELECT count(*) FROM projects WHERE status <> 'deleted' AND current_version_id IS NOT NULL)::text AS projects_live,
                (SELECT count(*) FROM personal_access_tokens
                  WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::text AS active_tokens,
                (SELECT COALESCE(sum(r.postgres_bytes), 0) FROM project_resources r
                   JOIN projects p ON p.id = r.project_id WHERE p.status <> 'deleted')::text AS postgres_bytes,
                (SELECT COALESCE(sum(r.object_bytes), 0) FROM project_resources r
                   JOIN projects p ON p.id = r.project_id WHERE p.status <> 'deleted')::text AS object_bytes,
                (SELECT COALESCE(sum(database_bytes_max), 0) FROM projects WHERE status <> 'deleted')::text AS postgres_bytes_max,
                (SELECT COALESCE(sum(object_bytes_max), 0) FROM projects WHERE status <> 'deleted')::text AS object_bytes_max,
                (SELECT count(*) FROM versions WHERE created_at > now() - interval '24 hours')::text AS versions_24h,
                (SELECT count(*) FROM deployments WHERE created_at > now() - interval '24 hours')::text AS deployments_24h,
                (SELECT count(*) FROM deployments
                  WHERE created_at > now() - interval '24 hours' AND status = 'failed')::text AS failed_deployments_24h
        `)
        const [projectStatus, runtimeState, jobStatus, host, runtimeMemory, oldestQueued] = await Promise.all([
            this.pool.query<{status: string; count: string}>(
                `SELECT status, count(*)::text AS count FROM projects GROUP BY status ORDER BY status`,
            ),
            this.pool.query<{state: string; count: string}>(
                `SELECT state, count(*)::text AS count FROM project_runtime GROUP BY state ORDER BY state`,
            ),
            this.pool.query<{status: string; count: string}>(
                `SELECT status, count(*)::text AS count FROM jobs
                 WHERE status IN ('queued','running') OR created_at > now() - interval '24 hours'
                 GROUP BY status ORDER BY status`,
            ),
            this.pool.query<HostSampleRow>(
                `SELECT worker, memory_total_bytes, memory_free_bytes, cpu_count,
                        load1, load5, load15, data_total_bytes, data_free_bytes, sampled_at
                 FROM host_samples ORDER BY sampled_at DESC LIMIT 1`,
            ),
            this.pool.query<{memory_bytes: string; memory_limit_bytes: string; containers: string; sampled_at: Date | null}>(
                `SELECT COALESCE(sum(s.memory_bytes), 0)::text AS memory_bytes,
                        COALESCE(sum(s.memory_limit_bytes), 0)::text AS memory_limit_bytes,
                        count(*)::text AS containers,
                        max(s.sampled_at) AS sampled_at
                 FROM runtime_samples s
                 JOIN project_runtime r ON r.project_id = s.project_id AND r.version_id = s.version_id
                 WHERE r.state = 'running'`,
            ),
            this.pool.query<{created_at: Date | null}>(
                `SELECT min(created_at) AS created_at FROM jobs WHERE status = 'queued' AND run_after <= now()`,
            ),
        ])
        const row = totals.rows[0]
        const memory = runtimeMemory.rows[0]
        return {
            accounts: {
                total: Number(row.accounts),
                operators: Number(row.operators),
                activeLast30Days: Number(row.accounts_active_30d),
                activeTokens: Number(row.active_tokens),
            },
            projects: {
                total: Number(row.projects),
                deployed: Number(row.projects_live),
                byStatus: countMap(projectStatus.rows, 'status'),
            },
            runtimes: {
                byState: countMap(runtimeState.rows, 'state'),
                sampledContainers: Number(memory?.containers ?? 0),
                memoryBytes: Number(memory?.memory_bytes ?? 0),
                memoryLimitBytes: Number(memory?.memory_limit_bytes ?? 0),
                sampledAt: memory?.sampled_at?.toISOString() ?? null,
            },
            storage: {
                postgresBytes: Number(row.postgres_bytes),
                postgresBytesMax: Number(row.postgres_bytes_max),
                objectBytes: Number(row.object_bytes),
                objectBytesMax: Number(row.object_bytes_max),
            },
            delivery: {
                versionsLast24Hours: Number(row.versions_24h),
                deploymentsLast24Hours: Number(row.deployments_24h),
                failedDeploymentsLast24Hours: Number(row.failed_deployments_24h),
            },
            jobs: {
                byStatus: countMap(jobStatus.rows, 'status'),
                oldestQueuedAt: oldestQueued.rows[0]?.created_at?.toISOString() ?? null,
            },
            host: hostSample(host.rows[0]),
        }
    }

    async accounts(): Promise<Record<string, unknown>[]> {
        const result = await this.pool.query<{
            id: string
            email: string
            display_name: string
            platform_role: PlatformRole
            project_quota: number
            created_at: Date
            last_login_at: Date | null
            projects: string
            deleting_projects: string
            active_tokens: string
            token_last_used_at: Date | null
            postgres_bytes: string
            object_bytes: string
        }>(`
            SELECT a.id, a.email, a.display_name, a.platform_role, a.project_quota,
                   a.created_at, a.last_login_at,
                   count(p.id) FILTER (WHERE p.status NOT IN ('deleted'))::text AS projects,
                   count(p.id) FILTER (WHERE p.status = 'deleting')::text AS deleting_projects,
                   COALESCE(sum(r.postgres_bytes) FILTER (WHERE p.status <> 'deleted'), 0)::text AS postgres_bytes,
                   COALESCE(sum(r.object_bytes) FILTER (WHERE p.status <> 'deleted'), 0)::text AS object_bytes,
                   (SELECT count(*) FROM personal_access_tokens t
                     WHERE t.account_id = a.id AND t.revoked_at IS NULL
                       AND (t.expires_at IS NULL OR t.expires_at > now()))::text AS active_tokens,
                   (SELECT max(t.last_used_at) FROM personal_access_tokens t WHERE t.account_id = a.id) AS token_last_used_at
            FROM accounts a
            LEFT JOIN projects p ON p.owner_id = a.id
            LEFT JOIN project_resources r ON r.project_id = p.id
            GROUP BY a.id
            ORDER BY a.last_login_at DESC NULLS LAST, a.created_at DESC
        `)
        return result.rows.map(row => ({
            id: row.id,
            email: row.email,
            name: row.display_name,
            role: row.platform_role,
            // The limit that actually binds, which for an operator is the floor
            // rather than the column. Reporting the column here would show an
            // operator "5 / 3" in the one view meant to answer whether an
            // account has room. `quotaColumn` keeps the stored number visible,
            // since it is still what identifies an account somebody raised.
            quota: effectiveProjectQuota(row, this.operatorProjectQuota),
            quotaColumn: row.project_quota,
            projects: Number(row.projects),
            projectsPendingDeletion: Number(row.deleting_projects),
            activeTokens: Number(row.active_tokens),
            usage: {
                postgresBytes: Number(row.postgres_bytes),
                objectBytes: Number(row.object_bytes),
            },
            createdAt: row.created_at.toISOString(),
            lastLoginAt: row.last_login_at?.toISOString() ?? null,
            tokenLastUsedAt: row.token_last_used_at?.toISOString() ?? null,
        }))
    }

    async projects(): Promise<Record<string, unknown>[]> {
        const result = await this.pool.query<{
            id: string
            slug: string
            status: string
            access_mode: string
            owner_email: string
            owner_name: string
            postgres_enabled: boolean
            storage_enabled: boolean
            current_version_id: string | null
            database_bytes_max: string
            object_bytes_max: string
            runtime_memory_mb: number
            runtime_cpu: string
            version_limit: number
            postgres_bytes: string | null
            object_bytes: string | null
            measured_at: Date | null
            runtime_state: string | null
            runtime_last_seen_at: Date | null
            runtime_error: string | null
            has_functions: boolean | null
            memory_bytes: string | null
            memory_limit_bytes: string | null
            cpu_percent: string | null
            sampled_at: Date | null
            versions: string
            failed_versions: string
            last_deployed_at: Date | null
            created_at: Date
            deleted_at: Date | null
            purge_after: Date | null
        }>(`
            SELECT p.id, p.slug, p.status, p.access_mode, p.postgres_enabled, p.storage_enabled,
                   p.current_version_id, p.database_bytes_max, p.object_bytes_max,
                   p.runtime_memory_mb, p.runtime_cpu, p.version_limit,
                   p.created_at, p.deleted_at, p.purge_after,
                   a.email AS owner_email, a.display_name AS owner_name,
                   r.postgres_bytes, r.object_bytes, r.measured_at,
                   rt.state AS runtime_state, rt.last_seen_at AS runtime_last_seen_at,
                   rt.error_message AS runtime_error,
                   -- Whether a runtime can exist at all. A static-only project
                   -- keeps a project_runtime row that reads 'stopped' for ever,
                   -- which the operator view rendered as an amber badge next to
                   -- a site that was serving perfectly well. Key presence is the
                   -- same test the gateway makes before it proxies to /api.
                   jsonb_exists(cv.manifest, 'functions') AS has_functions,
                   s.memory_bytes, s.memory_limit_bytes, s.cpu_percent, s.sampled_at,
                   (SELECT count(*) FROM versions v WHERE v.project_id = p.id)::text AS versions,
                   (SELECT count(*) FROM versions v WHERE v.project_id = p.id AND v.status = 'failed')::text AS failed_versions,
                   (SELECT max(d.activated_at) FROM deployments d
                     WHERE d.project_id = p.id AND d.status = 'active') AS last_deployed_at
            FROM projects p
            JOIN accounts a ON a.id = p.owner_id
            LEFT JOIN project_resources r ON r.project_id = p.id
            -- Aliased cv rather than v: the version counts above bind their own
            -- v, and a shadowed alias here would be legal and unreadable.
            LEFT JOIN versions cv ON cv.id = p.current_version_id
            LEFT JOIN LATERAL (
                SELECT pr.project_id, pr.version_id, pr.state, pr.last_seen_at, pr.error_message
                FROM project_runtime pr
                WHERE pr.project_id = p.id
                ORDER BY (pr.state = 'running') DESC, pr.last_seen_at DESC NULLS LAST
                LIMIT 1
            ) rt ON true
            LEFT JOIN runtime_samples s
                   ON s.project_id = rt.project_id AND s.version_id = rt.version_id
            WHERE p.status <> 'deleted'
            ORDER BY p.created_at DESC
        `)
        return result.rows.map(row => ({
            id: row.id,
            slug: row.slug,
            url: `https://${row.slug}.${this.domain}`,
            status: row.status,
            access: row.access_mode,
            owner: {email: row.owner_email, name: row.owner_name},
            deployed: Boolean(row.current_version_id),
            resources: {postgres: row.postgres_enabled, storage: row.storage_enabled},
            versions: {total: Number(row.versions), failed: Number(row.failed_versions)},
            quota: {
                postgresBytes: Number(row.database_bytes_max),
                objectBytes: Number(row.object_bytes_max),
                runtimeMemoryMiB: row.runtime_memory_mb,
                runtimeCpu: Number(row.runtime_cpu),
                versions: row.version_limit,
            },
            usage: {
                postgresBytes: Number(row.postgres_bytes ?? 0),
                objectBytes: Number(row.object_bytes ?? 0),
                measuredAt: row.measured_at?.toISOString() ?? null,
            },
            runtime: {
                state: row.runtime_state ?? 'stopped',
                functions: row.has_functions ?? false,
                lastSeenAt: row.runtime_last_seen_at?.toISOString() ?? null,
                error: row.runtime_error,
                memoryBytes: row.memory_bytes === null ? null : Number(row.memory_bytes),
                memoryLimitBytes: row.memory_limit_bytes === null ? null : Number(row.memory_limit_bytes),
                cpuPercent: row.cpu_percent === null ? null : Number(row.cpu_percent),
                sampledAt: row.sampled_at?.toISOString() ?? null,
            },
            createdAt: row.created_at.toISOString(),
            deletedAt: row.deleted_at?.toISOString() ?? null,
            purgeAfter: row.purge_after?.toISOString() ?? null,
            lastDeployedAt: row.last_deployed_at?.toISOString() ?? null,
        }))
    }

    async jobs(limit = 50): Promise<Record<string, unknown>[]> {
        const result = await this.pool.query<{
            id: string
            kind: string
            status: string
            attempts: number
            slug: string | null
            error_message: string | null
            run_after: Date
            locked_by: string | null
            created_at: Date
            finished_at: Date | null
        }>(
            `SELECT j.id, j.kind, j.status, j.attempts, j.error_message, j.run_after,
                    j.locked_by, j.created_at, j.finished_at, p.slug
             FROM jobs j LEFT JOIN projects p ON p.id = j.project_id
             ORDER BY (j.status IN ('queued','running')) DESC, j.created_at DESC
             LIMIT $1`,
            [boundedLimit(limit)],
        )
        return result.rows.map(row => ({
            id: row.id,
            kind: row.kind,
            status: row.status,
            attempts: row.attempts,
            project: row.slug,
            worker: row.locked_by,
            error: row.error_message,
            runAfter: row.run_after.toISOString(),
            createdAt: row.created_at.toISOString(),
            finishedAt: row.finished_at?.toISOString() ?? null,
        }))
    }

    async audit(limit = 50): Promise<Record<string, unknown>[]> {
        const result = await this.pool.query<{
            id: string
            action: string
            email: string | null
            slug: string | null
            metadata: unknown
            created_at: Date
        }>(
            `SELECT e.id, e.action, e.metadata, e.created_at, a.email, p.slug
             FROM audit_events e
             LEFT JOIN accounts a ON a.id = e.account_id
             LEFT JOIN projects p ON p.id = e.project_id
             ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
            [boundedLimit(limit)],
        )
        return result.rows.map(row => ({
            id: String(row.id),
            action: row.action,
            account: row.email,
            project: row.slug,
            metadata: row.metadata ?? {},
            createdAt: row.created_at.toISOString(),
        }))
    }
}

type HostSampleRow = {
    worker: string
    memory_total_bytes: string
    memory_free_bytes: string
    cpu_count: number
    load1: string
    load5: string
    load15: string
    data_total_bytes: string | null
    data_free_bytes: string | null
    sampled_at: Date
}

function hostSample(row: HostSampleRow | undefined): Record<string, unknown> | null {
    if (!row) return null
    return {
        worker: row.worker,
        memoryTotalBytes: Number(row.memory_total_bytes),
        memoryFreeBytes: Number(row.memory_free_bytes),
        memoryUsedBytes: Number(row.memory_total_bytes) - Number(row.memory_free_bytes),
        cpuCount: row.cpu_count,
        load: [Number(row.load1), Number(row.load5), Number(row.load15)],
        dataTotalBytes: row.data_total_bytes === null ? null : Number(row.data_total_bytes),
        dataFreeBytes: row.data_free_bytes === null ? null : Number(row.data_free_bytes),
        sampledAt: row.sampled_at.toISOString(),
    }
}

function countMap<K extends string>(rows: Array<Record<K, string> & {count: string}>, key: K): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row[key]] = Number(row.count)
    return counts
}

function boundedLimit(limit: number): number {
    return Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 50
}

export function parseOperatorEmails(value: string | undefined): string[] {
    if (!value) return []
    const emails = value
        .split(/[\s,;]+/)
        .map(entry => entry.trim().toLowerCase())
        .filter(entry => entry.includes('@'))
    return [...new Set(emails)].sort()
}

/**
 * `PLATFORM_OPERATOR_EMAILS` and `PLATFORM_SUPERADMIN_EMAILS` are declarative:
 * exactly the listed accounts hold each role after startup. Leaving both unset
 * changes nothing, so a host that manages roles by hand — or through the
 * superadmin write surface — is never overwritten by a deploy.
 *
 * The two lists are applied as one statement rather than two passes, because
 * two passes have an order and an order has a wrong half: promoting superadmins
 * first then demoting non-operators would strip the superadmin it had just
 * granted. An email on both lists gets the higher role; nobody named on either
 * list is demoted; everyone else lands on `user`.
 *
 * Demotion is deliberately scoped to accounts that currently hold a role. An
 * unset `PLATFORM_OPERATOR_EMAILS` with a set `PLATFORM_SUPERADMIN_EMAILS` must
 * not quietly demote every operator granted through the write surface, so the
 * empty case is "manage this tier by hand" rather than "this tier is empty".
 */
export async function syncOperators(
    pool: Pool,
    value: string | undefined,
    superadminValue?: string | undefined,
): Promise<{operators: string[]; superadmins: string[]}> {
    const superadmins = parseOperatorEmails(superadminValue)
    // An account named as both is a superadmin, and must not also be counted as
    // an operator or the demotion arm below would fight the promotion arm.
    const operators = parseOperatorEmails(value).filter(email => !superadmins.includes(email))
    if (!operators.length && !superadmins.length) return {operators, superadmins}
    await pool.query(
        `UPDATE accounts SET platform_role = CASE
             WHEN lower(email) = ANY($2) THEN 'superadmin'
             WHEN lower(email) = ANY($1) THEN 'operator'
             ELSE 'user'
         END
         WHERE lower(email) = ANY($1)
            OR lower(email) = ANY($2)
            OR (platform_role <> 'user' AND $3::boolean)`,
        [operators, superadmins, operators.length > 0],
    )
    return {operators, superadmins}
}

/** What a superadmin may set on an account. Both fields are optional; at least one must be present. */
export interface AccountPatch {
    projectQuota?: number
    role?: PlatformRole
}

/** What a superadmin may set on a project. Every field is optional. */
export interface ProjectLimitsPatch {
    runtimeMemoryMiB?: number
    runtimeCpu?: number
    postgresBytes?: number
    objectBytes?: number
    versions?: number
}

/**
 * The write half of the operator surface, open to `superadmin` alone.
 *
 * Everything here changes an account or a project the caller does not own,
 * which is why every method takes the acting principal rather than reading it
 * from ambient state: the audit row naming who made the change is not optional,
 * and a method that cannot name the actor cannot write one.
 *
 * Each change reads the row `FOR UPDATE`, compares, writes, and records the
 * before and after in the same transaction. Recording the previous value is
 * what makes the surface reversible by hand — "the quota is 40" is not enough
 * to undo a mistake, "40, and it was 3" is.
 */
export class AdminWriteService {
    constructor(private readonly pool: Pool) {}

    /**
     * Set an account's project quota, its role, or both.
     *
     * The role is deliberately restricted to `user` and `operator`. `superadmin`
     * is granted by `PLATFORM_SUPERADMIN_EMAILS` and nowhere else, which keeps
     * the tier that can rewrite every account outside the reach of the surface
     * it controls: no superadmin can mint another one, demote a peer, or demote
     * themselves through the API, so the set of people holding this power only
     * ever changes where the host's environment is edited.
     */
    async updateAccount(
        actor: Principal,
        accountId: string,
        patch: AccountPatch,
    ): Promise<Record<string, unknown>> {
        if (patch.projectQuota === undefined && patch.role === undefined) {
            throw new HTTPException(400, {message: 'nothing to change; send projectQuota, role, or both'})
        }
        if (patch.role === 'superadmin') {
            throw new HTTPException(403, {
                message: 'the superadmin role is granted by PLATFORM_SUPERADMIN_EMAILS on the host, not through this API',
            })
        }
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const found = await client.query<{
                email: string
                platform_role: PlatformRole
                project_quota: number
            }>(
                `SELECT email, platform_role, project_quota FROM accounts WHERE id = $1 FOR UPDATE`,
                [accountId],
            )
            const before = found.rows[0]
            if (!before) throw new HTTPException(404, {message: 'account not found'})
            // Reached only when a role change is asked for on a superadmin: the
            // same rule that stops one being minted stops one being unmade. A
            // quota change on a superadmin is ordinary and passes.
            if (patch.role !== undefined && before.platform_role === 'superadmin') {
                throw new HTTPException(403, {
                    message: accountId === actor.accountId
                        ? 'you cannot change your own role; edit PLATFORM_SUPERADMIN_EMAILS on the host'
                        : 'a superadmin\'s role is set by PLATFORM_SUPERADMIN_EMAILS on the host, not through this API',
                })
            }
            const quota = patch.projectQuota ?? before.project_quota
            const role = patch.role ?? before.platform_role
            const updated = await client.query<{platform_role: PlatformRole; project_quota: number}>(
                `UPDATE accounts SET platform_role = $2, project_quota = $3
                 WHERE id = $1 RETURNING platform_role, project_quota`,
                [accountId, role, quota],
            )
            await audit(client, actor.accountId, null, 'admin.account_updated', {
                account: accountId,
                email: before.email,
                ...(patch.projectQuota === undefined ? {} : {
                    projectQuota: {from: before.project_quota, to: updated.rows[0].project_quota},
                }),
                ...(patch.role === undefined ? {} : {
                    role: {from: before.platform_role, to: updated.rows[0].platform_role},
                }),
            })
            await client.query('COMMIT')
            return {
                id: accountId,
                email: before.email,
                role: updated.rows[0].platform_role,
                quotaColumn: updated.rows[0].project_quota,
                quota: effectiveProjectQuota(
                    {project_quota: updated.rows[0].project_quota, platform_role: updated.rows[0].platform_role},
                ),
            }
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    }

    /**
     * Set one project's resource limits.
     *
     * Memory and CPU are read by the executor when it creates the runtime
     * container, so a change to either does nothing to a container that is
     * already up. A cold start always recreates the container — `startRuntime`
     * does `docker rm -f` first — so the recycle is a `stop_runtime` job, and
     * the next request brings it back under the new limits. Without that, a
     * project that keeps getting traffic never sees the change: the idle sweep
     * cannot recycle a runtime somebody keeps visiting.
     *
     * The storage limits need no recycle. They are compared against measured
     * usage by the housekeeping pass, which reads the column each time.
     */
    async updateProjectLimits(
        actor: Principal,
        slug: string,
        patch: ProjectLimitsPatch,
    ): Promise<Record<string, unknown>> {
        const fields = Object.entries(patch).filter(([, value]) => value !== undefined)
        if (!fields.length) throw new HTTPException(400, {message: 'nothing to change'})
        const client = await this.pool.connect()
        let recycle: {projectId: string; versionId: string} | null = null
        try {
            await client.query('BEGIN')
            const found = await client.query<{
                id: string
                current_version_id: string | null
                runtime_memory_mb: number
                runtime_cpu: string
                database_bytes_max: string
                object_bytes_max: string
                version_limit: number
                runtime_state: string | null
            }>(
                `SELECT p.id, p.current_version_id, p.runtime_memory_mb, p.runtime_cpu,
                        p.database_bytes_max, p.object_bytes_max, p.version_limit,
                        rt.state AS runtime_state
                 FROM projects p
                 LEFT JOIN project_runtime rt ON rt.project_id = p.id AND rt.version_id = p.current_version_id
                 WHERE p.slug = $1 AND p.status <> 'deleted'
                 FOR UPDATE OF p`,
                [slug],
            )
            const before = found.rows[0]
            if (!before) throw new HTTPException(404, {message: 'project not found'})
            const next = {
                runtimeMemoryMiB: patch.runtimeMemoryMiB ?? before.runtime_memory_mb,
                runtimeCpu: patch.runtimeCpu ?? Number(before.runtime_cpu),
                postgresBytes: patch.postgresBytes ?? Number(before.database_bytes_max),
                objectBytes: patch.objectBytes ?? Number(before.object_bytes_max),
                versions: patch.versions ?? before.version_limit,
            }
            await client.query(
                `UPDATE projects
                 SET runtime_memory_mb = $2, runtime_cpu = $3,
                     database_bytes_max = $4, object_bytes_max = $5, version_limit = $6,
                     updated_at = now()
                 WHERE id = $1`,
                [before.id, next.runtimeMemoryMiB, next.runtimeCpu, next.postgresBytes, next.objectBytes, next.versions],
            )
            const runtimeChanged = next.runtimeMemoryMiB !== before.runtime_memory_mb
                || next.runtimeCpu !== Number(before.runtime_cpu)
            if (runtimeChanged && before.current_version_id && before.runtime_state === 'running') {
                recycle = {projectId: before.id, versionId: before.current_version_id}
                // Its own key, not the idle sweep's hourly one: a limit change
                // must not be swallowed by a stop already scheduled for other
                // reasons, and two limit changes in a row must each recycle.
                // Rerunnable leaves a queued or running stop alone, which is the
                // correct no-op — that job does this job's work.
                await enqueueRerunnable(
                    client,
                    'stop_runtime',
                    recycle.projectId,
                    recycle.versionId,
                    `stop:limits:${recycle.projectId}:${recycle.versionId}`,
                )
            }
            await audit(client, actor.accountId, before.id, 'admin.project_limits_updated', {
                slug,
                runtimeMemoryMiB: {from: before.runtime_memory_mb, to: next.runtimeMemoryMiB},
                runtimeCpu: {from: Number(before.runtime_cpu), to: next.runtimeCpu},
                postgresBytes: {from: Number(before.database_bytes_max), to: next.postgresBytes},
                objectBytes: {from: Number(before.object_bytes_max), to: next.objectBytes},
                versions: {from: before.version_limit, to: next.versions},
                runtimeRecycled: recycle !== null,
            })
            await client.query('COMMIT')
            return {slug, ...next, runtimeRecycled: recycle !== null}
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    }
}
