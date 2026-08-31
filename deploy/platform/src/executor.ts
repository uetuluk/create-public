import {execFile} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {
    cp,
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises'
import {cpus, freemem, loadavg, tmpdir, totalmem} from 'node:os'
import {basename, join, relative, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {pipeline} from 'node:stream/promises'
import {promisify} from 'node:util'
import jwt from 'jsonwebtoken'
import {Pool, type PoolClient} from 'pg'
import {
    dayBefore,
    visitDay,
    VISITOR_PRUNE_SQL,
    VISITOR_RETENTION_DAYS,
    VISIT_PRUNE_SQL,
    VISIT_RETENTION_DAYS,
} from './lib/analytics'
import {deploymentFromEnv, type DeploymentConfig} from './lib/deployment'
import {renderBudget, runtimeBudget, type RenderBudget, type RuntimeBudget} from './lib/budgets'
import {
    bootNonce,
    CLAIM_LOCK_SQL,
    CLAIM_SELECT_SQL,
    CLAIM_UPDATE_SQL,
    executorConcurrency,
    heavyConcurrency,
    HEAVY_KINDS,
    HEAVY_RUNNING_SQL,
    leaseSeconds,
    MAX_JOB_SECONDS,
    RELEASE_LEASES_SQL,
    RENEW_LEASE_SQL,
    renewIntervalMs,
    shutdownGraceMs,
    SWEEP_LEASES_SQL,
    TERMINAL_FAILURE_SQL,
    TERMINAL_SUCCESS_SQL,
    workerId,
    type JobKind,
} from './lib/job-claim'
import {diskUsage} from './lib/host-metrics'
import {Mutex} from './lib/mutex'
import {base64Url, SecretBox} from './lib/crypto'
import {
    assertDeployableMigrations,
    describeMigrationSet,
    detectStrayMigrations,
    installPrefix,
    pgDumpArgs,
    requiresLockfile,
} from './lib/deploy-checks'
import {siteManifestSchema, type SiteManifest} from './lib/manifest'
import type {ProbeRequest} from './lib/probe'
import {enqueue, isNetworkReachable} from './lib/projects'
import {provisionPlan, type ResourceRow} from './lib/provisioning'
import {annotateRenderDiagnostics} from './lib/render-diagnostics'
import {
    bodyDigest,
    REVIEW_AUDIENCE_PATH,
    REVIEW_TOKEN_HEADER,
    SHOWCASE_DESCRIPTION_AUDIENCE_PATH,
    signReviewToken,
} from './lib/review-token'
import {PLATFORM_DB} from './lib/schema'
import {
    EVIDENCE_MAX_FORMS,
    EVIDENCE_MAX_INPUTS,
    EVIDENCE_MAX_ORIGINS,
    EVIDENCE_TEXT_LIMIT,
    siteEvidenceFrom,
} from './lib/site-evidence'
import {parseModelVerdict, reviewSite, type SiteEvidence, reviewTermsFromEnv, type ReviewTerms} from './lib/site-review'

const execFileP = promisify(execFile)

type Job = {
    id: string
    kind: JobKind
    project_id: string | null
    version_id: string | null
    deployment_id: string | null
    attempts: number
}

export class Executor {
    private readonly bootNonce = bootNonce()
    /** Slot 0's identity; additional slots are minted in runWorker. */
    private readonly workerId = workerId(0, this.bootNonce)
    private readonly platformPool: Pool
    private readonly adminPool: Pool
    private readonly secretBox: SecretBox
    private stopped = false
    /** Serialises Docker network create/remove/connect across concurrent jobs. */
    private readonly networkMutex = new Mutex()
    /** Serialises `mc`, which mutates shared client state per invocation. */
    private readonly storageMutex = new Mutex()
    /** Jobs currently held by this process, by job id → owning worker id. */
    private readonly inFlight = new Map<string, string>()

    /** This installation's identity, derived once. */
    private readonly deployment: DeploymentConfig
    /** Built-in brands plus whatever this installation is impersonated as. */
    private readonly reviewTerms: ReviewTerms

    constructor(private readonly env: NodeJS.ProcessEnv) {
        this.deployment = deploymentFromEnv(env)
        this.reviewTerms = reviewTermsFromEnv(env)
        const adminUrl = required(env, 'PLATFORM_ADMIN_DATABASE_URL')
        const sessionSecret = required(env, 'PLATFORM_SESSION_SECRET')
        const encryptionSecret = required(env, 'SECRET_ENCRYPTION_KEY')
        if (Buffer.byteLength(sessionSecret) < 32 || Buffer.byteLength(encryptionSecret) < 32) {
            throw new Error('platform session and encryption secrets must each be at least 32 bytes')
        }
        if (sessionSecret === encryptionSecret) {
            throw new Error('SECRET_ENCRYPTION_KEY must be independent from PLATFORM_SESSION_SECRET')
        }
        // Sized from the worker count: each worker can hold a client across the
        // claim transaction or a deploy's activation transaction, and
        // housekeeping plus the lease renewal timers need headroom on top.
        // connectionTimeoutMillis matters as much as the size — without it an
        // exhausted pool waits forever, which is a silent hang rather than an
        // error.
        const concurrency = executorConcurrency(env)
        this.adminPool = new Pool({
            connectionString: adminUrl,
            max: Math.max(4, concurrency + 2),
            connectionTimeoutMillis: 10_000,
        })
        this.platformPool = new Pool({
            connectionString: swapDatabase(adminUrl, PLATFORM_DB),
            max: Math.max(8, concurrency * 3 + 4),
            connectionTimeoutMillis: 10_000,
        })
        this.secretBox = new SecretBox(encryptionSecret)
    }

    async run(): Promise<void> {
        const concurrency = executorConcurrency(this.env)
        console.log(`[executor] started as ${this.workerId} with ${concurrency} worker(s)`)
        const workers = Array.from({length: concurrency}, (_, index) => this.runWorker(index))
        await Promise.all([...workers, this.runHousekeeping(), this.runHeartbeat()])
    }

    private async runWorker(index: number): Promise<void> {
        const worker = workerId(index, this.bootNonce)
        while (!this.stopped) {
            let job: Job | null = null
            try {
                job = await this.claim(worker)
            } catch (error) {
                console.error('[executor] claim failed', errorText(error))
            }
            if (!job) {
                // Jittered so N workers do not wake together and contend for
                // the claim lock in lockstep.
                await sleep(750 + Math.floor(Math.random() * 250))
                continue
            }
            await this.execute(job, worker)
        }
    }

    private async runHousekeeping(): Promise<void> {
        while (!this.stopped) {
            await this.housekeeping().catch(error => console.error('[executor] housekeeping failed', error))
            const interval = Number(this.env.EXECUTOR_HOUSEKEEPING_MS ?? 60_000)
            for (let waited = 0; waited < interval && !this.stopped; waited += 500) await sleep(500)
        }
    }

    /**
     * On its own timer rather than riding on housekeeping, whose serial
     * `docker logs` pass over every running runtime can approach the 120-second
     * staleness window the compose healthcheck uses. It also has to keep
     * beating through a shutdown drain so the container is not marked unhealthy
     * while it is deliberately finishing work.
     */
    private async runHeartbeat(): Promise<void> {
        const heartbeat = this.env.EXECUTOR_HEARTBEAT_FILE ?? '/tmp/executor-heartbeat'
        const interval = Number(this.env.EXECUTOR_HEARTBEAT_MS ?? 15_000)
        while (!this.stopped || this.inFlight.size) {
            await writeFile(heartbeat, String(Date.now()), {mode: 0o600}).catch(() => undefined)
            for (let waited = 0; waited < interval; waited += 500) {
                if (this.stopped && !this.inFlight.size) return
                await sleep(500)
            }
        }
    }

    /**
     * Stops claiming, lets in-flight work finish, and hands back anything that
     * did not settle in time rather than leaving it to time out.
     */
    async close(): Promise<void> {
        this.stopped = true
        const deadline = Date.now() + shutdownGraceMs(this.env)
        while (this.inFlight.size && Date.now() < deadline) {
            await sleep(250)
        }
        if (this.inFlight.size) {
            const ids = [...this.inFlight.keys()]
            console.error(`[executor] requeueing ${ids.length} job(s) still running at shutdown`)
            await this.platformPool.query(RELEASE_LEASES_SQL, [ids]).catch(error =>
                console.error('[executor] could not requeue in-flight jobs', errorText(error)))
        }
        await Promise.all([this.platformPool.end(), this.adminPool.end()])
    }

    async runOnce(): Promise<boolean> {
        const job = await this.claim()
        if (!job) return false
        await this.execute(job)
        return true
    }

    private async claim(worker = this.workerId): Promise<Job | null> {
        const lease = leaseSeconds(this.env)
        const heavyLimit = heavyConcurrency(this.env)
        const client = await this.platformPool.connect()
        try {
            await client.query('BEGIN')
            // Must precede every read of `jobs`: see CLAIM_LOCK_SQL for why
            // SKIP LOCKED alone does not serialise the per-project exclusion.
            const lock = await client.query<{locked: boolean}>(CLAIM_LOCK_SQL)
            if (!lock.rows[0]?.locked) {
                await client.query('ROLLBACK')
                return null
            }
            const heavy = await client.query<{running: number}>(HEAVY_RUNNING_SQL, [[...HEAVY_KINDS], lease])
            const heavySlotFree = heavy.rows[0].running < heavyLimit
            const result = await client.query<Job>(CLAIM_SELECT_SQL, [[...HEAVY_KINDS], lease, heavySlotFree])
            const job = result.rows[0]
            if (!job) {
                await client.query('COMMIT')
                return null
            }
            await client.query(CLAIM_UPDATE_SQL, [job.id, worker])
            await client.query('COMMIT')
            this.inFlight.set(job.id, worker)
            return job
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    }

    /**
     * Keeps a job's lease alive while it genuinely runs, and stops once the job
     * exceeds the maximum runtime for its kind — at which point the sweeper is
     * meant to take it back.
     */
    private startLeaseRenewal(job: Job, worker: string): {stop: () => void; lost: () => boolean} {
        const deadline = Date.now() + MAX_JOB_SECONDS[job.kind] * 1000
        let lost = false
        const timer = setInterval(() => {
            if (Date.now() > deadline) return
            this.platformPool.query(RENEW_LEASE_SQL, [job.id, worker])
                .then(result => {
                    if (result.rowCount === 0) {
                        lost = true
                        console.error(`[executor] lease lost for ${job.kind} ${job.id}; another worker owns it`)
                    }
                })
                .catch(error => console.error('[executor] lease renewal failed', errorText(error)))
        }, renewIntervalMs(this.env))
        timer.unref?.()
        return {stop: () => clearInterval(timer), lost: () => lost}
    }

    private async execute(job: Job, worker = this.workerId): Promise<void> {
        const lease = this.startLeaseRenewal(job, worker)
        try {
            switch (job.kind) {
                case 'provision_project': await this.provisionProject(job); break
                case 'build_version': await this.buildVersion(job); break
                case 'deploy_version': await this.deployVersion(job); break
                case 'start_runtime': await this.startRuntime(job); break
                case 'stop_runtime': await this.stopRuntime(job); break
                case 'delete_project': await this.deleteProject(job); break
                case 'measure_usage': await this.measureUsage(job); break
                case 'render_version': await this.renderVersion(job); break
                case 'export_database': await this.exportDatabase(job); break
                case 'probe_version': await this.probeVersion(job); break
                case 'review_site': await this.reviewPublicSite(job); break
                case 'capture_showcase': await this.captureShowcase(job); break
            }
            const done = await this.platformPool.query(TERMINAL_SUCCESS_SQL, [job.id, worker])
            if (done.rowCount === 0) await this.reportLostTerminal(job, 'succeeded')
        } catch (error) {
            const message = errorText(error)
            console.error(`[executor] ${job.kind} ${job.id} failed: ${message}`)
            const retry = job.attempts < 2 && !['build_version', 'deploy_version', 'render_version', 'export_database', 'probe_version'].includes(job.kind)
            const marked = await this.platformPool.query(
                TERMINAL_FAILURE_SQL,
                [job.id, worker, retry ? 'queued' : 'failed', message],
            )
            if (marked.rowCount === 0) {
                await this.reportLostTerminal(job, 'failed')
                // Deliberately skip failSubject. If the lease was reclaimed,
                // another worker now owns this job, and marking its version or
                // deployment failed would corrupt work that is still running.
                return
            }
            await this.failSubject(job, message)
        } finally {
            lease.stop()
            this.inFlight.delete(job.id)
        }
    }

    /**
     * A terminal update that matched no row means either the job row is gone —
     * which `delete_project` does to itself, since deleting the project cascades
     * to its jobs — or the lease was reclaimed and someone else owns it now.
     * The two need telling apart: the first is success, the second is not.
     */
    private async reportLostTerminal(job: Job, outcome: string): Promise<void> {
        const present = await this.platformPool.query(`SELECT status, locked_by FROM jobs WHERE id = $1`, [job.id])
        if (present.rowCount === 0) {
            console.log(`[executor] ${job.kind} ${job.id} ${outcome}; job row already removed with its project`)
            return
        }
        console.error(
            `[executor] ${job.kind} ${job.id} ${outcome} but the lease was lost to ` +
                `${present.rows[0].locked_by}; terminal update ignored`,
        )
    }

    private async provisionProject(job: Job): Promise<void> {
        if (!job.project_id) throw new Error('project job missing project_id')
        const result = await this.platformPool.query<{
            id: string
            slug: string
            database_name: string
            postgres_enabled: boolean
            storage_enabled: boolean
            object_bytes_max: string
        }>(`SELECT id, slug, database_name, postgres_enabled, storage_enabled, object_bytes_max FROM projects WHERE id = $1`, [job.project_id])
        const project = result.rows[0]
        if (!project) throw new Error('project not found')
        const suffix = project.id.replace(/-/g, '').slice(0, 20)
        const runtimeUser = `rt_${suffix}`
        const migrationUser = `mg_${suffix}`
        const writeRole = `wr_${suffix}`
        const bucket = `site-${project.id}`
        const storageAccess = `r${project.id.replace(/-/g, '').slice(0, 19)}`

        // A project that predates the resources row, or whose creation was
        // interrupted, still has to be provisionable.
        await this.platformPool.query(
            `INSERT INTO project_resources (project_id) VALUES ($1) ON CONFLICT (project_id) DO NOTHING`,
            [project.id],
        )
        const existing = await this.platformPool.query<ResourceRow>(
            `SELECT database_runtime_user, database_migration_user, database_secret_enc,
                    storage_bucket, storage_access_key, storage_secret_enc
             FROM project_resources WHERE project_id = $1`,
            [project.id],
        )
        const plan = provisionPlan(project, existing.rows[0] ?? null, {
            runtimeUser,
            migrationUser,
            bucket,
            storageAccess,
        })

        // Reusing the stored passwords matters: this job is re-runnable now, and
        // rotating them would invalidate the credentials already injected into a
        // running runtime container.
        const storedDatabase = plan.reuseDatabaseCredentials
            ? JSON.parse(this.secretBox.decrypt(existing.rows[0]!.database_secret_enc!)) as {
                runtimePassword: string
                migrationPassword: string
                writeRole: string
            }
            : null
        const runtimePassword = storedDatabase?.runtimePassword ?? base64Url(32)
        const migrationPassword = storedDatabase?.migrationPassword ?? base64Url(32)

        if (plan.provisionPostgres) {
            await this.ensureRole(writeRole, null, false)
            await this.ensureRole(migrationUser, migrationPassword, true, undefined, plan.reuseDatabaseCredentials)
            await this.ensureRole(runtimeUser, runtimePassword, true, 5, plan.reuseDatabaseCredentials)
            const database = await this.adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [project.database_name])
            if (!database.rowCount) {
                await this.adminPool.query(
                    `CREATE DATABASE ${ident(project.database_name)} OWNER ${ident(migrationUser)}`,
                )
            }
            const projectPool = new Pool({connectionString: swapDatabase(required(this.env, 'PLATFORM_ADMIN_DATABASE_URL'), project.database_name), max: 1})
            try {
                await projectPool.query(`REVOKE ALL ON DATABASE ${ident(project.database_name)} FROM PUBLIC`)
                await projectPool.query(`GRANT CONNECT ON DATABASE ${ident(project.database_name)} TO ${ident(runtimeUser)}`)
                await projectPool.query(`GRANT ${ident(writeRole)} TO ${ident(runtimeUser)}`)
                await projectPool.query(`GRANT USAGE ON SCHEMA public TO ${ident(runtimeUser)}`)
                // USAGE only, never CREATE: migrations are the platform's DDL
                // path, so schema changes stay versioned, checksummed in
                // _ritsdev_migrations, and reversible with the deployment.
                // Redundant on PostgreSQL 15+, but stated where someone
                // debugging "permission denied for schema public" will look.
                await projectPool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
                await projectPool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(migrationUser)} IN SCHEMA public GRANT SELECT ON TABLES TO ${ident(runtimeUser)}`)
                await projectPool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(migrationUser)} IN SCHEMA public GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO ${ident(writeRole)}`)
                await projectPool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(migrationUser)} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${ident(writeRole)}`)
                await projectPool.query(`ALTER ROLE ${ident(runtimeUser)} SET statement_timeout = '60s'`)
                await projectPool.query(`ALTER ROLE ${ident(runtimeUser)} SET idle_in_transaction_session_timeout = '30s'`)
                await projectPool.query(`ALTER ROLE ${ident(runtimeUser)} SET temp_file_limit = '64MB'`)
                await projectPool.query(`ALTER ROLE ${ident(runtimeUser)} SET work_mem = '4MB'`)
                // temp_file_limit is superuser-only, so the migration role
                // cannot raise it with SET LOCAL inside its own transaction.
                // Pin it here, where the admin connection can, exactly as the
                // runtime role above.
                await projectPool.query(`ALTER ROLE ${ident(migrationUser)} SET temp_file_limit = '64MB'`)
            } finally {
                await projectPool.end()
            }
        }

        const storageSecret = plan.reuseStorageCredentials
            ? this.secretBox.decrypt(existing.rows[0]!.storage_secret_enc!)
            : base64Url(30)
        if (plan.provisionStorage) {
            await this.provisionBucket(bucket, storageAccess, storageSecret, Number(project.object_bytes_max))
        }

        await this.platformPool.query(
            `UPDATE project_resources
             SET database_runtime_user = $2, database_migration_user = $3, database_secret_enc = $4,
                 storage_bucket = $5, storage_access_key = $6, storage_secret_enc = $7, measured_at = now(),
                 provision_state = 'ready', provision_error = NULL, provisioned_at = now()
             WHERE project_id = $1`,
            [
                project.id,
                plan.provisionPostgres ? runtimeUser : null,
                plan.provisionPostgres ? migrationUser : null,
                plan.provisionPostgres ? this.secretBox.encrypt(JSON.stringify({runtimePassword, migrationPassword, writeRole})) : null,
                plan.provisionStorage ? bucket : null,
                plan.provisionStorage ? storageAccess : null,
                plan.provisionStorage ? this.secretBox.encrypt(storageSecret) : null,
            ],
        )
        // Never demote a project that is live but over quota.
        await this.platformPool.query(
            `UPDATE projects SET status = 'ready', updated_at = now()
             WHERE id = $1 AND status IN ('provisioning', 'failed')`,
            [project.id],
        )
        // A runtime started before this resource existed has no DATABASE_URL or
        // S3 credentials in its environment, and the environment is fixed at
        // `docker run` time. Retire it so the next request starts a container
        // that can see them.
        if (plan.addsResource) await this.removeRuntime(project.id)
        await this.log(project.id, null, 'executor', 'info', 'project resources provisioned')
    }

    private async buildVersion(job: Job): Promise<void> {
        if (!job.project_id || !job.version_id) throw new Error('build job missing identifiers')
        const result = await this.platformPool.query<{
            slug: string
            archive_path: string
            source_revision_id: string
            postgres_enabled: boolean
            storage_enabled: boolean
            llm_enabled: boolean
        }>(
            `SELECT p.slug, p.postgres_enabled, p.storage_enabled, p.llm_enabled,
                    s.archive_path, v.source_revision_id
             FROM versions v
             JOIN projects p ON p.id = v.project_id
             JOIN source_revisions s ON s.id = v.source_revision_id
             WHERE v.id = $1 AND v.project_id = $2`,
            [job.version_id, job.project_id],
        )
        const row = result.rows[0]
        if (!row) throw new Error('version source not found')
        await this.platformPool.query(`UPDATE versions SET status = 'building', error_message = NULL WHERE id = $1`, [job.version_id])
        const workRoot = resolve(this.env.DATA_ROOT ?? '/data', 'work')
        await mkdir(workRoot, {recursive: true, mode: 0o700})
        const work = await mkdtemp(join(workRoot, 'build-'))
        // Staged outside the uploaded tree on purpose. Preparing the output
        // directory inside `work` would delete the author's own files whenever
        // build.output names a directory they shipped prebuilt, and the build
        // would then succeed while serving nothing.
        const staging = await mkdtemp(join(workRoot, 'output-'))
        // Disk-backed npm cache: see runNodeBuild for why it is not a tmpfs.
        const cache = await mkdtemp(join(workRoot, 'npmcache-'))
        let buildNetwork: string | null = null
        let incoming: string | null = null
        try {
            const listing = await exec('tar', ['-tzf', row.archive_path, '--quoting-style=escape'], 60_000)
            validateArchiveListing(listing)
            const headers = await exec('tar', ['-tvzf', row.archive_path, '--quoting-style=escape'], 60_000)
            validateArchiveHeaders(headers)
            await exec('tar', ['-xzf', row.archive_path, '-C', work, '--no-same-owner', '--no-same-permissions'], 60_000)
            await rejectSymlinks(work)
            if (await directoryBytes(work) > 256 * 1024 * 1024) {
                throw new Error('expanded source exceeds 256 MiB')
            }
            const manifestPath = join(work, 'ritsdev.site.json')
            const manifest = siteManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
            if (manifest.resources.postgres && !row.postgres_enabled) {
                throw new Error(
                    'manifest requests PostgreSQL but this project does not have it. Add it with ' +
                        'POST /v1/projects/<slug>/resources {"postgres":true}, the enable_project_resources ' +
                        'MCP tool, or `ritsdev resources <slug> --postgres`, then build again.',
                )
            }
            if (manifest.resources.storage && !row.storage_enabled) {
                throw new Error(
                    'manifest requests object storage but this project does not have it. Add it with ' +
                        'POST /v1/projects/<slug>/resources {"storage":true}, the enable_project_resources ' +
                        'MCP tool, or `ritsdev resources <slug> --storage`, then build again.',
                )
            }
            if (manifest.resources.llm && !row.llm_enabled) {
                throw new Error(
                    'manifest requests the managed LLM binding but this project does not have it. Add it with ' +
                        'POST /v1/projects/<slug>/resources {"llm":true}, the enable_project_resources ' +
                        'MCP tool, or `ritsdev resources <slug> --llm`, then build again.',
                )
            }
            const hasPackageJson = await exists(join(work, 'package.json'))
            if (requiresLockfile(manifest.build, hasPackageJson) && !await exists(join(work, 'package-lock.json'))) {
                throw new Error(
                    'package-lock.json is required when package.json exists, so builds are reproducible. ' +
                        'Set build.install in ritsdev.site.json to your own install command, or to false to ' +
                        'skip installing, if you do not want `npm ci`.',
                )
            }
            // Function code is served from the uploaded tree, never from build
            // output, so a missing entrypoint is a mistake we can name now
            // instead of a Deno "Module not found" during dependency caching.
            if (manifest.functions && !await exists(within(work, manifest.functions.entrypoint))) {
                throw new Error(
                    `functions.entrypoint "${manifest.functions.entrypoint}" is not in the uploaded source. ` +
                        'Functions are served from the archive you upload, not from build output: anything ' +
                        'your build command generates is discarded with the build workspace. Ship the ' +
                        'entrypoint and everything it statically imports in the archive.',
                )
            }
            const stray = detectStrayMigrations(listing.split('\n').filter(Boolean), manifest)
            if (stray) {
                throw new Error(
                    `found SQL migrations under "${stray}" but ritsdev.site.json declares no database.migrations. ` +
                        'They would never be applied and your tables would not exist at runtime.',
                )
            }
            if (manifest.database) {
                const migrations = within(work, manifest.database.migrations)
                if (!await exists(migrations) || !(await stat(migrations)).isDirectory()) {
                    throw new Error('configured migration directory does not exist')
                }
                const entries = (await readdir(migrations)).sort()
                if (!entries.filter(file => file.endsWith('.sql')).length) {
                    throw new Error(describeMigrationSet(entries, []))
                }
            }
            if (manifest.build || manifest.functions) {
                buildNetwork = await this.createBuildNetwork(job.id)
            }
            if (manifest.build) {
                await this.runNodeBuild(work, staging, cache, manifest, buildNetwork!, job.project_id, job.version_id)
            }

            const artifactFinal = resolve(this.env.ARTIFACT_ROOT ?? '/data/artifacts', job.project_id, job.version_id)
            // Assembled beside the live tree and renamed into place, so a second
            // build of the same version can never delete the first one's output
            // half-way through. A crashed build leaves an .incoming.* directory
            // that housekeeping sweeps.
            const artifactRoot = `${artifactFinal}.incoming.${job.id}`
            incoming = artifactRoot
            await rm(artifactRoot, {recursive: true, force: true})
            await mkdir(artifactRoot, {recursive: true, mode: 0o700})
            if (manifest.build) {
                const outputStat = await stat(staging)
                if (!outputStat.isDirectory()) throw new Error('build output is not a directory')
                if (!(await readdir(staging)).length) {
                    throw new Error(`build produced no files in ${manifest.build.output}`)
                }
                await cp(staging, join(artifactRoot, 'static'), {recursive: true, force: true})
                const staticBytes = await directoryBytes(join(artifactRoot, 'static'))
                if (staticBytes > 100 * 1024 * 1024) throw new Error('static build exceeds 100 MiB')
            }
            if (manifest.functions) {
                await cp(work, join(artifactRoot, 'source'), {
                    recursive: true,
                    filter: path => {
                        const relative = path.slice(work.length).replace(/^\/+/, '')
                        return !relative.startsWith('.git')
                            && !relative.startsWith('node_modules')
                            && !relative.split('/').some(part => part.startsWith('.env'))
                    },
                })
                const wrapperDir = join(artifactRoot, 'runtime')
                await mkdir(wrapperDir, {recursive: true})
                await writeFile(join(wrapperDir, 'main.ts'), runtimeWrapper(manifest.functions.entrypoint), {mode: 0o600})
                await this.cacheDeno(artifactRoot, manifest.functions.entrypoint, buildNetwork!)
            } else if (manifest.database) {
                const migrations = within(work, manifest.database.migrations)
                const target = within(join(artifactRoot, 'source'), manifest.database.migrations)
                await mkdir(resolve(target, '..'), {recursive: true})
                await cp(migrations, target, {recursive: true, force: true})
            }
            await publishArtifactPermissions(artifactRoot)
            await rm(artifactFinal, {recursive: true, force: true})
            await rename(artifactRoot, artifactFinal)
            incoming = null
            const artifactBytes = await directoryBytes(artifactFinal)
            await this.platformPool.query(
                `UPDATE versions
                 SET status = 'ready', manifest = $2, artifact_path = $3, artifact_bytes = $4,
                     finished_at = now(), error_message = NULL
                 WHERE id = $1`,
                [job.version_id, JSON.stringify(manifest), artifactFinal, artifactBytes],
            )
            await this.pruneVersions(job.project_id)
            await this.log(job.project_id, job.version_id, 'build', 'info', `build completed (${artifactBytes} bytes)`)
        } finally {
            if (buildNetwork) await this.removeBuildNetwork(buildNetwork)
            await rm(work, {recursive: true, force: true})
            await rm(staging, {recursive: true, force: true})
            await rm(cache, {recursive: true, force: true})
            if (incoming) await rm(incoming, {recursive: true, force: true})
        }
    }

    private async deployVersion(job: Job): Promise<void> {
        if (!job.project_id || !job.version_id || !job.deployment_id) throw new Error('deployment job missing identifiers')
        await this.platformPool.query(`UPDATE deployments SET status = 'deploying' WHERE id = $1`, [job.deployment_id])
        const result = await this.platformPool.query<{
            database_name: string
            postgres_enabled: boolean
            database_bytes_max: string
            project_status: string
            access_mode: string
            artifact_path: string
            manifest: SiteManifest
            database_migration_user: string | null
            database_secret_enc: string | null
        }>(
            `SELECT p.database_name, p.postgres_enabled, p.database_bytes_max,
                    p.status AS project_status, p.access_mode, v.artifact_path, v.manifest,
                    r.database_migration_user, r.database_secret_enc
             FROM projects p JOIN versions v ON v.project_id = p.id
             LEFT JOIN project_resources r ON r.project_id = p.id
             WHERE p.id = $1 AND v.id = $2 AND v.status = 'ready'`,
            [job.project_id, job.version_id],
        )
        const row = result.rows[0]
        if (!row) throw new Error('ready version not found')
        if (row.project_status === 'storage_exceeded') {
            throw new Error('project database or object storage quota is exceeded')
        }
        // Throws when migrations were declared but cannot run. That has to
        // happen before the activation transaction below, so the previous
        // version stays live instead of a broken one being promoted over it.
        const gate = assertDeployableMigrations({
            postgresEnabled: row.postgres_enabled,
            hasDatabaseBlock: Boolean(row.manifest.database),
            migrationUser: row.database_migration_user,
            secretEnc: row.database_secret_enc,
        })
        if (gate === 'apply') {
            const credentials = JSON.parse(this.secretBox.decrypt(row.database_secret_enc!)) as {migrationPassword: string}
            await this.applyMigrations(
                row.database_name,
                row.database_migration_user!,
                credentials.migrationPassword,
                within(row.artifact_path, `source/${row.manifest.database!.migrations}`),
                Number(row.database_bytes_max),
                job.project_id,
                job.version_id,
            )
            if (row.manifest.functions) await this.warnOnEmptySchema(job, row)
        }
        const client = await this.platformPool.connect()
        try {
            await client.query('BEGIN')
            await client.query(`UPDATE projects SET current_version_id = $1, updated_at = now() WHERE id = $2`, [job.version_id, job.project_id])
            await client.query(
                `UPDATE deployments SET status = 'active', activated_at = now(), error_message = NULL WHERE id = $1`,
                [job.deployment_id],
            )
            await client.query(
                `UPDATE deployments SET status = 'failed', error_message = 'superseded'
                 WHERE project_id = $1 AND status = 'active' AND id <> $2`,
                [job.project_id, job.deployment_id],
            )
            await client.query(
                `INSERT INTO project_runtime (project_id, version_id, state)
                 VALUES ($1,$2,'stopped')
                 ON CONFLICT (project_id, version_id)
                 DO UPDATE SET state = 'stopped', endpoint = NULL, proxy_secret_enc = NULL`,
                [job.project_id, job.version_id],
            )
            await client.query('COMMIT')
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
        await this.removeRuntime(job.project_id)
        await this.log(job.project_id, job.version_id, 'deploy', 'info', 'version activated')

        // A new version of a site anyone on the network can reach is a new page
        // to review. Owner-only projects are skipped: they are reachable by
        // exactly one authenticated person, and reviewing them spends inference
        // on a shared proxy for no one's benefit.
        //
        // Enqueued after the commit and swallowed on failure, deliberately.
        // Inside the transaction, a jobs constraint the deployed schema has not
        // caught up with would roll back an activation that had otherwise
        // succeeded — trading a live deployment for a review nobody asked for.
        if (isNetworkReachable(row.access_mode)) {
            await enqueue(
                this.platformPool,
                'review_site',
                job.project_id,
                job.version_id,
                `review:${job.project_id}:${job.version_id}`,
                // A minute behind the deploy. The review runs a browser and
                // takes the single heavy slot on a two-core host; the runtime
                // start and the author's own first look come first.
                new Date(Date.now() + 60_000),
            ).catch(error => console.error('[executor] could not enqueue site review', errorText(error)))
        }
        // A listed project's card should show what it serves now, not what it
        // served two deploys ago, so the capture follows every activation.
        //
        // Thirty seconds behind the review rather than beside it: both are
        // renders, they contend for the same single heavy slot, and queueing
        // them together only decides which of the two waits. This ordering puts
        // the security check first.
        if (row.access_mode === 'showcase') {
            await enqueue(
                this.platformPool,
                'capture_showcase',
                job.project_id,
                job.version_id,
                `showcase:${job.project_id}:${job.version_id}`,
                new Date(Date.now() + 90_000),
            ).catch(error => console.error('[executor] could not enqueue showcase capture', errorText(error)))
        }
    }

    private async startRuntime(job: Job): Promise<void> {
        if (!job.project_id) throw new Error('runtime job missing project_id')
        const result = await this.platformPool.query<{
            slug: string
            current_version_id: string
            runtime_memory_mb: number
            runtime_cpu: string
            database_name: string
            postgres_enabled: boolean
            storage_enabled: boolean
            artifact_path: string
            manifest: SiteManifest
            database_runtime_user: string | null
            database_secret_enc: string | null
            storage_bucket: string | null
            storage_access_key: string | null
            storage_secret_enc: string | null
            llm_enabled: boolean
            llm_key_enc: string | null
            llm_key_expires_at: Date | null
        }>(
            `SELECT p.slug, p.current_version_id, p.runtime_memory_mb, p.runtime_cpu,
                    p.database_name, p.postgres_enabled, p.storage_enabled, p.llm_enabled,
                    v.artifact_path, v.manifest,
                    r.database_runtime_user, r.database_secret_enc,
                    r.storage_bucket, r.storage_access_key, r.storage_secret_enc,
                    r.llm_key_enc, r.llm_key_expires_at
             FROM projects p JOIN versions v ON v.id = COALESCE($2, p.current_version_id)
             JOIN project_resources r ON r.project_id = p.id
             WHERE p.id = $1`,
            [job.project_id, job.version_id],
        )
        const row = result.rows[0]
        if (!row?.manifest.functions) throw new Error('deployed version has no functions')
        await this.platformPool.query(
            `INSERT INTO project_runtime (project_id, version_id, state)
             VALUES ($1,COALESCE($2::uuid,$3::uuid),'starting')
             ON CONFLICT (project_id, version_id)
             DO UPDATE SET state = 'starting', endpoint = NULL, proxy_secret_enc = NULL, error_message = NULL`,
            [job.project_id, job.version_id, row.current_version_id],
        )
        const activeVersionId = job.version_id ?? row.current_version_id
        const name = runtimeName(job.project_id, activeVersionId)
        // start_runtime is retried 30 seconds after a failure, and this removal
        // is the retry's first act. Without capturing first, the second attempt
        // destroys the first attempt's output — including the stack trace of
        // whatever made it fail.
        await this.captureContainerLogs(job.project_id, activeVersionId, name)
        await docker(['rm', '-f', name], 30_000, true)
        const network = await this.ensureRuntimeNetwork(job.project_id)
        const proxySecret = base64Url(32)
        const environment: Record<string, string> = {
            RITSDEV_PROJECT_ID: job.project_id,
            PORT: '8787',
            DENO_DIR: '/app/deno-dir',
            HOME: '/tmp',
        }
        if (row.postgres_enabled && row.database_secret_enc && row.database_runtime_user) {
            const credentials = JSON.parse(this.secretBox.decrypt(row.database_secret_enc)) as {runtimePassword: string}
            const pgbouncerHost = this.env.PGBOUNCER_HOST ?? 'pgbouncer'
            environment.DATABASE_URL = postgresUrl(row.database_runtime_user, credentials.runtimePassword, pgbouncerHost, 6432, row.database_name)
        }
        if (row.storage_enabled && row.storage_bucket && row.storage_access_key && row.storage_secret_enc) {
            environment.S3_ENDPOINT = this.env.STORAGE_PUBLIC_ENDPOINT ?? 'http://rustfs:9000'
            environment.S3_BUCKET = row.storage_bucket
            environment.S3_ACCESS_KEY_ID = row.storage_access_key
            environment.S3_SECRET_ACCESS_KEY = this.secretBox.decrypt(row.storage_secret_enc)
            environment.S3_REGION = this.env.STORAGE_REGION ?? 'us-east-1'
        }
        if (row.llm_enabled) {
            // An expired or missing key would otherwise surface to the developer
            // as an opaque 401 from inside their own fetch handling. The executor
            // cannot mint a replacement — it has no egress — so the most useful
            // thing it can do is say so plainly in the project's own logs.
            if (!row.llm_key_enc) {
                await this.log(job.project_id, activeVersionId, 'runtime', 'error',
                    'LLM binding is enabled but no key is provisioned; recreate the project or contact the operator')
            } else {
                const expiresAt = row.llm_key_expires_at ? new Date(row.llm_key_expires_at) : null
                if (expiresAt && expiresAt.getTime() <= Date.now()) {
                    await this.log(job.project_id, activeVersionId, 'runtime', 'error',
                        `LLM key expired at ${expiresAt.toISOString()}; calls to LLM_BASE_URL will return 401 until it is reissued`)
                } else if (expiresAt && expiresAt.getTime() - Date.now() < 7 * 86_400_000) {
                    await this.log(job.project_id, activeVersionId, 'runtime', 'warn',
                        `LLM key expires at ${expiresAt.toISOString()}`)
                }
                environment.LLM_BASE_URL = this.env.LLM_BASE_URL ?? ''
                environment.LLM_API_KEY = this.secretBox.decrypt(row.llm_key_enc)
                environment.LLM_MODEL = this.env.LLM_MODEL ?? 'Qwen3-30B-A3B-AWQ'
            }
        }
        const secrets = await this.platformPool.query<{name: string; value_enc: string}>(
            `SELECT name, value_enc FROM project_secrets WHERE project_id = $1`,
            [job.project_id],
        )
        for (const secret of secrets.rows) environment[secret.name] = this.secretBox.decrypt(secret.value_enc)
        // Platform-owned authentication must win over user-defined project
        // secrets, including a project secret with this reserved name.
        environment.RITSDEV_PROXY_SECRET = proxySecret
        const args = [
            'run', '-d', '--name', name,
            '--network', network,
            '--memory', `${row.runtime_memory_mb}m`,
            '--cpus', String(row.runtime_cpu),
            '--pids-limit', '128',
            '--user', this.env.RUNTIME_USER ?? '65532:65532',
            '--read-only',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges',
            '--restart', 'no',
            '--label', `ritsdev.project=${job.project_id}`,
            '--label', `ritsdev.version=${activeVersionId}`,
            ...dockerLogOptions(5),
            '--mount', `type=bind,src=${this.hostPath(row.artifact_path)},dst=/app,readonly`,
        ]
        for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`)
        // The official image entrypoint already invokes the Deno executable.
        args.push(
            this.env.DENO_RUNTIME_IMAGE ?? 'denoland/deno:2.9.4@sha256:c777b4b225501a61074837e90a826a58f99124837824023cd60334b1e2374498',
            'run', '--cached-only', '--no-prompt', '--allow-net',
            `--allow-env=${Object.keys(environment).join(',')}`,
            '--allow-read=/app',
            '/app/runtime/main.ts',
        )
        await docker(args, 60_000)
        const endpoint = `http://${name}:8787`
        await waitForContainerHttp(name, runtimeBudget(this.env))
        await this.platformPool.query(
            `UPDATE project_runtime
             SET state = 'running', endpoint = $2, proxy_secret_enc = $3,
                 last_seen_at = now(), last_started_at = now(), error_message = NULL
             WHERE project_id = $1 AND version_id = $4`,
            [job.project_id, endpoint, this.secretBox.encrypt(proxySecret), activeVersionId],
        )
    }

    private async stopRuntime(job: Job): Promise<void> {
        if (!job.project_id || !job.version_id) throw new Error('stop job missing identifiers')
        const name = runtimeName(job.project_id, job.version_id)
        await docker(['stop', '--time', '10', name], 30_000, true)
        await this.captureContainerLogs(job.project_id, job.version_id, name)
        await this.platformPool.query(
            `UPDATE project_runtime
             SET state = 'stopped', endpoint = NULL, proxy_secret_enc = NULL
             WHERE project_id = $1 AND version_id = $2`,
            [job.project_id, job.version_id],
        )
    }

    private async renderVersion(job: Job): Promise<void> {
        if (!job.project_id || !job.version_id) throw new Error('render job missing identifiers')
        const result = await this.platformPool.query<{slug: string}>(
            `SELECT slug FROM projects WHERE id = $1`,
            [job.project_id],
        )
        if (!result.rowCount) throw new Error('project not found')
        const renderRoot = resolve(this.env.RENDER_ROOT ?? '/data/renders')
        await mkdir(renderRoot, {recursive: true, mode: 0o700})
        const screenshot = resolve(renderRoot, `${job.id}.png`)
        const diagnostics = resolve(renderRoot, `${job.id}.json`)

        const render = await this.renderPage({
            projectId: job.project_id,
            versionId: job.version_id,
            slug: result.rows[0].slug,
            screenshotPath: screenshot,
            logSource: 'render',
        })
        const parsed = render.diagnostics
        await this.platformPool.query(
            `INSERT INTO render_results (job_id, project_id, version_id, screenshot_path, diagnostics)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (job_id) DO UPDATE
             SET screenshot_path = EXCLUDED.screenshot_path, diagnostics = EXCLUDED.diagnostics, created_at = now()`,
            [job.id, job.project_id, job.version_id, render.screenshot ? screenshot : null, JSON.stringify(parsed)],
        )
        await writeFile(diagnostics, JSON.stringify(parsed), {mode: 0o600})
        const console_ = Array.isArray(parsed.console) ? parsed.console : []
        if (console_.length || parsed.error) {
            await this.log(job.project_id, job.version_id, 'render', parsed.error ? 'error' : 'info',
                JSON.stringify({status: parsed.status, error: parsed.error, console: console_}).slice(0, 20_000))
        }
        if (render.containerError) throw render.containerError
        if (!render.screenshot) throw new Error(`render produced no screenshot: ${String(parsed.error ?? 'unknown error')}`)
    }

    /**
     * Renders one version in the Playwright container and returns what it
     * wrote.
     *
     * Shared by `render_version`, which is a user asking to see their page, and
     * by `review_site`, which nobody asked for. Both need the identical trust
     * path — the short-lived render token bound to {host, project, version} that
     * the gateway verifies and strips — so it exists once.
     *
     * `logSource` is null for work the author did not request. A line in
     * `project_logs` is visible to them, and a review that announces itself in
     * the author's own log stream both puzzles an innocent author and tells an
     * adversary exactly when to behave.
     */
    private async renderPage(options: {
        projectId: string
        versionId: string
        slug: string
        screenshotPath: string | null
        logSource: string | null
        /** Defaults to the whole document; false takes the 1440x1000 viewport. */
        fullPage?: boolean
    }): Promise<{diagnostics: Record<string, unknown>; screenshot: boolean; containerError: unknown}> {
        const domain = this.deployment.domain
        const previewHost = `${options.slug}--v-${options.versionId.replace(/-/g, '').slice(0, 10)}.${domain}`
        const publicBaseUrl = (this.env.PUBLIC_BASE_URL ?? `https://${domain}`).replace(/\/+$/, '')
        const renderToken = jwt.sign({
            typ: 'render',
            host: previewHost,
            project: options.projectId,
            version: options.versionId,
        }, required(this.env, 'PLATFORM_SESSION_SECRET'), {
            algorithm: 'HS256',
            issuer: publicBaseUrl,
            audience: `${publicBaseUrl}/internal/render`,
            expiresIn: '2m',
        })
        const budget = renderBudget(this.env)

        // Wake the function before the browser navigates. Without this the very
        // first preview of any function-backed site raced a 40-90 second cold
        // start against the navigation timeout and reliably lost; the second
        // render then worked, which made it look intermittent.
        let prewarm: string | null = null
        const manifest = await this.platformPool.query<{manifest: SiteManifest}>(
            `SELECT manifest FROM versions WHERE id = $1 AND project_id = $2`,
            [options.versionId, options.projectId],
        )
        if (manifest.rows[0]?.manifest?.functions) {
            try {
                await this.ensureRuntimeStarted(options.projectId, options.versionId)
            } catch (error) {
                // Navigate anyway: static assets still render, and the failure
                // is far more useful reported alongside the page diagnostics
                // than as a bare job error.
                prewarm = errorText(error)
                if (options.logSource) {
                    await this.log(options.projectId, options.versionId, options.logSource, 'warn',
                        `pre-warm failed: ${prewarm}`)
                }
            }
        }

        const workRoot = resolve(this.env.DATA_ROOT ?? '/data', 'work')
        await mkdir(workRoot, {recursive: true, mode: 0o700})
        const temp = await mkdtemp(join(workRoot, 'render-'))
        let containerError: unknown = null
        try {
            await chmod(temp, 0o777)
            try {
                await docker([
                    'run', '--rm',
                    // ritsdev-render:local is produced by `docker compose
                    // build`, which stamps com.docker.compose.project onto the
                    // image, and a container inherits its image's labels. So
                    // this container arrives claiming to be a platform service
                    // of this compose project, and with --rm and no --name it
                    // is eventually caught mid-exit and reads as a service that
                    // has just died. That nearly aborted a capacity run for an
                    // outage that never happened. An explicit --label overrides
                    // the inherited one; clearing it is the honest value,
                    // because compose did not create this container.
                    '--label', 'com.docker.compose.project=',
                    '--label', 'ritsdev.role=render',
                    '--network', this.env.RENDER_NETWORK ?? 'ritsdev_render',
                    '--memory', '768m', '--cpus', '1', '--pids-limit', '256',
                    '--user', '1000:1000',
                    '--read-only',
                    '--tmpfs', '/tmp:rw,nosuid,size=256m',
                    '--shm-size', '256m',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                    ...dockerLogOptions(2),
                    '--env', `TARGET_URL=${this.env.GATEWAY_INTERNAL_URL ?? 'http://gateway:3001'}`,
                    '--env', `TARGET_HOST=${previewHost}`,
                    '--env', `RENDER_TOKEN=${renderToken}`,
                    '--env', 'HOME=/tmp',
                    '--mount', `type=bind,src=${this.hostPath(temp)},dst=/output`,
                    this.env.PLAYWRIGHT_IMAGE ?? 'mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948',
                    'node', '-e', renderScript(budget, {fullPage: options.fullPage}),
                ], budget.containerMs)
            } catch (error) {
                containerError = error
            }
            // Whatever the container managed to produce is worth keeping. The
            // previous version exited before writing diagnostics.json on a
            // navigation timeout, so the console output that would have
            // explained the failure was thrown away with the container.
            const shot = await exists(join(temp, 'screenshot.png'))
            if (shot && options.screenshotPath) await cp(join(temp, 'screenshot.png'), options.screenshotPath)
            const report = await readFile(join(temp, 'diagnostics.json'), 'utf8').catch(() => null)
            const parsed = report ? JSON.parse(report) as Record<string, unknown> : {}
            // Before anything stores or logs it: the render path emits one
            // console error of its own that the author cannot act on.
            annotateRenderDiagnostics(parsed)
            if (containerError && !parsed.error) parsed.error = errorText(containerError)
            if (prewarm) parsed.prewarmError = prewarm
            return {diagnostics: parsed, screenshot: shot, containerError}
        } finally {
            await rm(temp, {recursive: true, force: true})
        }
    }

    /**
     * Reviews the page a project at `network` access serves to strangers, and
     * records a verdict. It never changes what is served.
     *
     * The whole job is best-effort by construction. A render that fails, a
     * model that is not configured, a model that cannot be reached, an answer
     * that does not parse — each of those still records a review, at the verdict
     * the static signals reached on their own. The one outcome that must never
     * occur is a review that reads `clean` because its evidence went missing.
     */
    private async reviewPublicSite(job: Job): Promise<void> {
        if (!job.project_id) throw new Error('review job missing project_id')
        const result = await this.platformPool.query<{
            slug: string
            access_mode: string
            current_version_id: string | null
        }>(
            `SELECT slug, access_mode, current_version_id FROM projects
             WHERE id = $1 AND status NOT IN ('deleting', 'deleted')`,
            [job.project_id],
        )
        const project = result.rows[0]
        // Every one of these is a race with an ordinary user action between the
        // enqueue and the claim, and each means the same thing: there is no
        // longer a public page here to review.
        if (!project) return
        if (!isNetworkReachable(project.access_mode)) {
            console.log(`[executor] site review skipped for ${job.project_id}: access is ${project.access_mode}`)
            return
        }
        if (!project.current_version_id) return
        if (job.version_id && job.version_id !== project.current_version_id) {
            console.log(`[executor] site review skipped for ${project.slug}: a newer version is live`)
            return
        }
        const versionId = project.current_version_id

        const render = await this.renderPage({
            projectId: job.project_id,
            versionId,
            slug: project.slug,
            // No screenshot is kept. An operator who wants to see a flagged page
            // renders the version through the ordinary API, where the operator
            // role already reaches every project.
            screenshotPath: null,
            logSource: null,
        })
        // A failed render is not an error here. It is a page that did not
        // answer, which `staticSignals` reports as evidence it never got.
        const domain = this.deployment.domain
        const evidence = siteEvidenceFrom(render.diagnostics, {
            slug: project.slug,
            // The host a visitor uses, not the internal one the render reached.
            // Every form action and asset origin is judged against this.
            host: `${project.slug}.${domain}`,
        })
        const verdict = parseModelVerdict(await this.modelOpinion(job.project_id, versionId, evidence))
        const review = reviewSite(evidence, verdict, this.reviewTerms)

        await this.platformPool.query(
            `INSERT INTO site_reviews
                (project_id, version_id, host, level, signals, model_level, model_reason, model_unavailable, summary)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
                job.project_id, versionId, evidence.host, review.level, JSON.stringify(review.signals),
                review.modelLevel, review.modelReason, review.modelUnavailable, review.summary,
            ],
        )
        console.log(`[executor] site review ${project.slug}: ${review.level}`
            + `${review.modelUnavailable ? ' (no model opinion)' : ''}`)
    }

    /**
     * Produces the two things a gallery card needs: a picture and a draft.
     *
     * Its own job kind rather than an extra step inside `review_site`, even
     * though both render the same page a minute apart. The review is a security
     * control with properties that were argued for one at a time — it keeps no
     * screenshot, it writes nothing into the author's log, and it runs whether
     * or not anyone asked. This runs only because an owner asked to be listed,
     * it exists to produce an image and some copy, and its output is the
     * author's to see. Folding a feature into a control is how the control
     * quietly loses the properties it was given.
     *
     * Everything here is best-effort. A failed render leaves the previous card
     * image in place, which is a stale picture rather than a missing one, and
     * the listing itself never depended on either.
     */
    private async captureShowcase(job: Job): Promise<void> {
        if (!job.project_id) throw new Error('showcase job missing project_id')
        const result = await this.platformPool.query<{
            slug: string
            access_mode: string
            current_version_id: string | null
            showcase_shot_source: string | null
        }>(
            `SELECT slug, access_mode, current_version_id, showcase_shot_source FROM projects
             WHERE id = $1 AND status NOT IN ('deleting', 'deleted')`,
            [job.project_id],
        )
        const project = result.rows[0]
        // The same races `reviewPublicSite` guards, meaning the same thing:
        // between the enqueue and the claim there stopped being a listed page.
        if (!project) return
        if (project.access_mode !== 'showcase') {
            console.log(`[executor] showcase capture skipped for ${job.project_id}: access is ${project.access_mode}`)
            return
        }
        if (!project.current_version_id) return
        if (job.version_id && job.version_id !== project.current_version_id) {
            console.log(`[executor] showcase capture skipped for ${project.slug}: a newer version is live`)
            return
        }
        const versionId = project.current_version_id

        const showcaseRoot = resolve(this.env.SHOWCASE_ROOT ?? '/data/showcase')
        await mkdir(showcaseRoot, {recursive: true, mode: 0o700})
        const shot = resolve(showcaseRoot, `${job.project_id}.png`)
        // An owner who uploaded their own picture chose it on purpose, so a
        // later deploy must not quietly replace it. The render still runs: the
        // page has changed, and the description draft is worth refreshing even
        // when the image is not.
        const keepUploaded = project.showcase_shot_source === 'uploaded'

        const render = await this.renderPage({
            projectId: job.project_id,
            versionId,
            slug: project.slug,
            screenshotPath: keepUploaded ? null : shot,
            // Silent, like the review. A card image being refreshed is platform
            // housekeeping and says nothing an author can act on; a line about
            // it in their own log stream is noise at best.
            logSource: null,
            // The viewport, not the document. A card is a fixed rectangle.
            fullPage: false,
        })

        if (render.screenshot && !keepUploaded) {
            await this.platformPool.query(
                `UPDATE projects
                 SET showcase_shot_path = $1, showcase_shot_source = 'captured',
                     showcase_shot_at = now(), updated_at = now()
                 WHERE id = $2 AND access_mode = 'showcase'`,
                [shot, job.project_id],
            )
        } else if (!render.screenshot) {
            console.warn(`[executor] showcase capture produced no screenshot for ${project.slug}`)
        }

        const domain = this.deployment.domain
        const evidence = siteEvidenceFrom(render.diagnostics, {
            slug: project.slug,
            host: `${project.slug}.${domain}`,
        })
        const summary = await this.showcaseDraft(job.project_id, versionId, evidence)
        if (summary) {
            // Into the draft column, never into showcase_description. The text
            // came out of a model that read a page written by the person asking
            // to be advertised; the only thing that puts words on another
            // user's screen is their owner choosing them.
            await this.platformPool.query(
                `UPDATE projects SET showcase_draft = $1, showcase_draft_at = now() WHERE id = $2`,
                [summary, job.project_id],
            )
        }
        console.log(`[executor] showcase capture ${project.slug}:`
            + ` ${render.screenshot ? (keepUploaded ? 'image kept' : 'image updated') : 'no image'},`
            + ` ${summary ? 'draft updated' : 'no draft'}`)
    }

    /**
     * Asks the control plane to draft a description, for the same reason
     * `modelOpinion` does: this process has the Docker socket and no egress.
     *
     * Null for every failure. A card with no draft costs its owner a sentence
     * they were always free to write themselves.
     */
    private async showcaseDraft(projectId: string, versionId: string, evidence: SiteEvidence): Promise<string | null> {
        const domain = this.deployment.domain
        const publicBaseUrl = (this.env.PUBLIC_BASE_URL ?? `https://${domain}`).replace(/\/+$/, '')
        const internalUrl = (this.env.PLATFORM_INTERNAL_URL ?? 'http://platform:3000').replace(/\/+$/, '')
        const body = JSON.stringify(evidence)
        const token = signReviewToken(required(this.env, 'PLATFORM_SESSION_SECRET'), publicBaseUrl, {
            project: projectId,
            version: versionId,
            digest: bodyDigest(body),
        }, SHOWCASE_DESCRIPTION_AUDIENCE_PATH)
        try {
            const response = await fetch(`${internalUrl}${SHOWCASE_DESCRIPTION_AUDIENCE_PATH}`, {
                method: 'POST',
                headers: {'content-type': 'application/json', [REVIEW_TOKEN_HEADER]: token},
                body,
                signal: AbortSignal.timeout(180_000),
            })
            if (!response.ok) {
                console.warn(`[executor] showcase description call returned ${response.status}`)
                return null
            }
            const parsed = await response.json() as {summary?: unknown}
            return typeof parsed.summary === 'string' && parsed.summary ? parsed.summary : null
        } catch (error) {
            console.warn(`[executor] showcase description call failed: ${errorText(error)}`)
            return null
        }
    }

    /**
     * Asks the control plane what the model makes of a page.
     *
     * The executor cannot ask the proxy itself: it is attached only to
     * `data-control` and `storage-control`, both internal, so it has no egress —
     * which is deliberate, because it holds the Docker socket. The control plane
     * has the egress and the credential that mints keys, so it makes the call
     * and returns the raw answer for this side to parse.
     *
     * Returns null for every failure. A missing opinion is not an approval, and
     * `reviewSite` treats it as the absence it is.
     */
    private async modelOpinion(projectId: string, versionId: string, evidence: SiteEvidence): Promise<string | null> {
        const domain = this.deployment.domain
        const publicBaseUrl = (this.env.PUBLIC_BASE_URL ?? `https://${domain}`).replace(/\/+$/, '')
        const internalUrl = (this.env.PLATFORM_INTERNAL_URL ?? 'http://platform:3000').replace(/\/+$/, '')
        const body = JSON.stringify(evidence)
        const token = signReviewToken(required(this.env, 'PLATFORM_SESSION_SECRET'), publicBaseUrl, {
            project: projectId,
            version: versionId,
            digest: bodyDigest(body),
        })
        try {
            const response = await fetch(`${internalUrl}${REVIEW_AUDIENCE_PATH}`, {
                method: 'POST',
                headers: {'content-type': 'application/json', [REVIEW_TOKEN_HEADER]: token},
                body,
                // Generous: the far side may retry a 5xx from the shared proxy
                // twice before giving up, and this is background work.
                signal: AbortSignal.timeout(180_000),
            })
            if (!response.ok) {
                console.warn(`[executor] site review model call returned ${response.status}`)
                return null
            }
            const parsed = await response.json() as {raw?: unknown}
            return typeof parsed.raw === 'string' ? parsed.raw : null
        } catch (error) {
            console.warn(`[executor] site review model call failed: ${errorText(error)}`)
            return null
        }
    }

    /**
     * Performs one HTTP request against a version's private host and records
     * the response.
     *
     * Deployed sites resolve only on the private network, so there was no way
     * to exercise an endpoint from outside it: the reporting agent resorted to
     * injecting a fetch() into index.html at build time and reading the result
     * out of server-side logs. This is the same trust path the renderer uses —
     * a short-lived token bound to {host, project, version}, which the gateway
     * verifies and strips — except that the caller supplies only a path, never
     * a host, so the tool cannot be aimed anywhere else.
     */
    private async probeVersion(job: Job): Promise<void> {
        if (!job.project_id || !job.version_id) throw new Error('probe job missing identifiers')
        const stored = await this.platformPool.query<{request: ProbeRequest}>(
            `SELECT request FROM probe_results WHERE job_id = $1`,
            [job.id],
        )
        if (!stored.rowCount) throw new Error('probe request not found')
        const request = stored.rows[0].request
        const result = await this.platformPool.query<{slug: string; manifest: SiteManifest}>(
            `SELECT p.slug, v.manifest FROM projects p JOIN versions v ON v.project_id = p.id
             WHERE p.id = $1 AND v.id = $2 AND v.status = 'ready'`,
            [job.project_id, job.version_id],
        )
        if (!result.rowCount) throw new Error('ready version not found')
        const {slug, manifest} = result.rows[0]

        let coldStart = false
        if (manifest.functions) {
            const before = await this.platformPool.query<{state: string}>(
                `SELECT state FROM project_runtime WHERE project_id = $1 AND version_id = $2`,
                [job.project_id, job.version_id],
            )
            coldStart = before.rows[0]?.state !== 'running'
            await this.ensureRuntimeStarted(job.project_id, job.version_id)
        }

        const domain = this.deployment.domain
        const previewHost = `${slug}--v-${job.version_id.replace(/-/g, '').slice(0, 10)}.${domain}`
        const publicBaseUrl = (this.env.PUBLIC_BASE_URL ?? `https://${domain}`).replace(/\/+$/, '')
        const token = jwt.sign({
            typ: 'render',
            host: previewHost,
            project: job.project_id,
            version: job.version_id,
        }, required(this.env, 'PLATFORM_SESSION_SECRET'), {
            algorithm: 'HS256',
            issuer: publicBaseUrl,
            audience: `${publicBaseUrl}/internal/render`,
            expiresIn: '2m',
        })
        const base = this.env.GATEWAY_INTERNAL_URL ?? 'http://gateway:3001'
        const started = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 120_000)
        try {
            const response = await fetch(`${base}${request.path}`, {
                method: request.method,
                headers: {
                    ...request.headers,
                    'x-ritsdev-render-host': previewHost,
                    'x-ritsdev-render-token': token,
                },
                body: request.body ?? undefined,
                redirect: 'manual',
                signal: controller.signal,
            })
            const raw = Buffer.from(await response.arrayBuffer())
            const limit = 256 * 1024
            const headers: Record<string, string> = {}
            response.headers.forEach((value, key) => {headers[key] = value})
            await this.platformPool.query(
                `UPDATE probe_results SET response = $2 WHERE job_id = $1`,
                [job.id, JSON.stringify({
                    status: response.status,
                    headers,
                    body: raw.subarray(0, limit).toString('utf8'),
                    bodyBytes: raw.length,
                    truncated: raw.length > limit,
                    durationMs: Date.now() - started,
                    coldStart,
                })],
            )
        } finally {
            clearTimeout(timer)
        }
    }

    /**
     * Dumps a project database to a file the owner can download.
     *
     * Runs `pg_dump` from the pinned PostgreSQL image through the Docker
     * socket, the same way builds, dependency caches, and renders are already
     * run — the executor image itself carries no PostgreSQL client. The
     * connection goes directly to PostgreSQL rather than through PgBouncer,
     * whose transaction pooling breaks pg_dump's consistent snapshot.
     */
    private async exportDatabase(job: Job): Promise<void> {
        if (!job.project_id) throw new Error('export job missing project_id')
        const request = await this.platformPool.query<{include_data: boolean}>(
            `SELECT include_data FROM database_exports WHERE job_id = $1`,
            [job.id],
        )
        if (!request.rowCount) throw new Error('export request not found')
        const includeData = request.rows[0].include_data
        const result = await this.platformPool.query<{
            database_name: string
            postgres_enabled: boolean
            slug: string
            database_migration_user: string | null
            database_secret_enc: string | null
        }>(
            `SELECT p.database_name, p.postgres_enabled, p.slug,
                    r.database_migration_user, r.database_secret_enc
             FROM projects p LEFT JOIN project_resources r ON r.project_id = p.id
             WHERE p.id = $1`,
            [job.project_id],
        )
        const row = result.rows[0]
        if (!row) throw new Error('project not found')
        if (!row.postgres_enabled) throw new Error('project has no PostgreSQL database')
        if (!row.database_migration_user || !row.database_secret_enc) {
            throw new Error('database provisioning has not finished for this project')
        }
        const credentials = JSON.parse(this.secretBox.decrypt(row.database_secret_enc)) as {migrationPassword: string}
        const maxBytes = readPositiveInt(this.env, 'DATABASE_EXPORT_MAX_BYTES', 256 * 1024 * 1024)

        const dumpRoot = resolve(this.env.DUMP_ROOT ?? '/data/dumps')
        await mkdir(dumpRoot, {recursive: true, mode: 0o750})
        const uid = this.env.PLATFORM_UID ?? '1000'
        const gid = this.env.PLATFORM_GID ?? '1000'
        // pg_dump writes straight into the dump directory as the platform
        // account, with umask 027, so the file is created 0640 and already
        // owned by the account that serves the download. The executor cannot
        // fix this afterwards: it holds CAP_DAC_OVERRIDE only, so chown and
        // chmod on a file it does not own are both refused, and widening its
        // capabilities for a copy step is not worth it. It writes under a
        // .partial name so a failed dump never looks like a finished one.
        const partial = `${job.id}.partial`
        const target = resolve(dumpRoot, `${job.id}.sql.gz`)
        const produced = resolve(dumpRoot, partial)
        try {
            await docker([
                'run', '--rm',
                '--network', this.env.DATA_NETWORK ?? 'ritsdev_data_control',
                '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
                '--read-only',
                '--tmpfs', '/tmp:rw,nosuid,size=64m',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                ...dockerLogOptions(1),
                // In the environment, never in argv: the command line is
                // readable through docker inspect and the process table.
                '--env', `PGPASSWORD=${credentials.migrationPassword}`,
                '--env', 'PGCONNECT_TIMEOUT=10',
                '--env', 'PGOPTIONS=-c statement_timeout=280000',
                '--mount', `type=bind,src=${this.hostPath(dumpRoot)},dst=/output`,
                '--user', `${uid}:${gid}`,
                '--entrypoint', 'sh',
                this.env.PG_DUMP_IMAGE ?? 'postgres:16.9-alpine',
                '-c',
                // umask, so the dump is created 0640 rather than 0644: it holds
                // tenant rows and must not be world-readable.
                `umask 027; exec ${pgDumpArgs({
                    host: this.env.POSTGRES_HOST ?? 'postgres',
                    port: 5432,
                    user: row.database_migration_user,
                    database: row.database_name,
                    schemaOnly: !includeData,
                    outputPath: `/output/${partial}`,
                }).map(shellQuote).join(' ')}`,
            ], 300_000)

            const size = (await stat(produced)).size
            if (size > maxBytes) {
                throw new Error(
                    `the export is ${size} bytes, over the ${maxBytes}-byte limit; ` +
                        'request a schema-only export, or ask an operator to raise DATABASE_EXPORT_MAX_BYTES',
                )
            }
            // Streamed: a dump may be up to DATABASE_EXPORT_MAX_BYTES (256 MiB)
            // and this container runs under a 512 MiB limit.
            const digest = await sha256File(produced)
            // rename rather than copy: it preserves the ownership pg_dump gave
            // the file, which is the whole point of writing it here directly.
            await rename(produced, target)
            // A schema-only dump is small and contains no tenant rows, so it can
            // be returned inline; a full dump never is.
            const schemaSql = includeData ? null : await gunzipText(target).catch(() => null)
            await this.platformPool.query(
                `UPDATE database_exports
                 SET file_path = $2, size_bytes = $3, sha256 = $4, schema_sql = $5, error_message = NULL
                 WHERE job_id = $1`,
                [job.id, target, size, digest, schemaSql],
            )
            await this.log(job.project_id, null, 'export', 'info',
                `database export ready (${includeData ? 'full' : 'schema only'}, ${size} bytes)`)
        } finally {
            await rm(produced, {force: true})
        }
    }

    /**
     * Starts the runtime for a specific version and waits for health, unless it
     * is already running and answering.
     */
    private async ensureRuntimeStarted(projectId: string, versionId: string): Promise<void> {
        const state = await this.platformPool.query<{state: string}>(
            `SELECT state FROM project_runtime WHERE project_id = $1 AND version_id = $2`,
            [projectId, versionId],
        )
        if (state.rows[0]?.state === 'running') {
            const healthy = await docker(runtimeHealthCommand(runtimeName(projectId, versionId)), 3_000, true)
            if (healthy !== null) {
                // Only the gateway marks traffic, so an executor-internal
                // pre-warm is otherwise invisible to the idle sweep.
                await this.platformPool.query(
                    `UPDATE project_runtime SET last_seen_at = now() WHERE project_id = $1 AND version_id = $2`,
                    [projectId, versionId],
                )
                return
            }
        }
        const synthetic: Job = {
            id: randomUUID(),
            kind: 'start_runtime',
            project_id: projectId,
            version_id: versionId,
            deployment_id: null,
            attempts: 0,
        }
        try {
            await this.startRuntime(synthetic)
        } catch (error) {
            // This call bypasses the job dispatcher, so nothing else would run
            // failSubject for it — and that is what captures the container
            // output before the container is destroyed. Without this, a
            // function that dies at module scope during a pre-warm leaves no
            // stack trace at all, which is the exact failure this round set out
            // to fix.
            await this.failSubject(synthetic, errorText(error)).catch(() => {})
            throw error
        }
    }

    private async measureUsage(job: Job): Promise<void> {
        if (!job.project_id) throw new Error('usage job missing project_id')
        const result = await this.platformPool.query<{
            database_name: string
            postgres_enabled: boolean
            database_bytes_max: string
            storage_bucket: string | null
            write_role: string | null
        }>(
            `SELECT p.database_name, p.postgres_enabled, p.database_bytes_max, r.storage_bucket,
                    (r.database_secret_enc IS NOT NULL)::text AS write_role
             FROM projects p JOIN project_resources r ON r.project_id = p.id
             WHERE p.id = $1`,
            [job.project_id],
        )
        const project = result.rows[0]
        if (!project) return
        const database = project.postgres_enabled
            ? await this.adminPool.query<{size: string}>(`SELECT pg_database_size($1)::text AS size`, [project.database_name])
            : {rows: []}
        const postgresBytes = Number(database.rows[0]?.size ?? 0)
        let objectBytes = 0
        if (project.storage_bucket) {
            const output = await this.mc(['du', '--json', `rustfs/${project.storage_bucket}`], true)
            for (const line of output.split('\n')) {
                try {
                    const parsed = JSON.parse(line)
                    objectBytes = Math.max(objectBytes, Number(parsed.size ?? 0))
                } catch { /* ignore mc progress */ }
            }
        }
        await this.platformPool.query(
            `UPDATE project_resources SET postgres_bytes = $2, object_bytes = $3, measured_at = now() WHERE project_id = $1`,
            [job.project_id, postgresBytes, objectBytes],
        )
        const credentials = await this.platformPool.query<{database_secret_enc: string | null}>(
            `SELECT database_secret_enc FROM project_resources WHERE project_id = $1`,
            [job.project_id],
        )
        if (project.postgres_enabled && credentials.rows[0]?.database_secret_enc) {
            const decoded = JSON.parse(this.secretBox.decrypt(credentials.rows[0].database_secret_enc)) as {writeRole: string}
            const runtime = await this.platformPool.query<{database_runtime_user: string}>(
                `SELECT database_runtime_user FROM project_resources WHERE project_id = $1`,
                [job.project_id],
            )
            if (postgresBytes >= Number(project.database_bytes_max)) {
                await this.adminPool.query(`REVOKE ${ident(decoded.writeRole)} FROM ${ident(runtime.rows[0].database_runtime_user)}`)
                await this.adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [project.database_name])
                await this.platformPool.query(`UPDATE projects SET status = 'storage_exceeded' WHERE id = $1`, [job.project_id])
            } else {
                await this.adminPool.query(`GRANT ${ident(decoded.writeRole)} TO ${ident(runtime.rows[0].database_runtime_user)}`)
                await this.platformPool.query(`UPDATE projects SET status = 'ready' WHERE id = $1 AND status = 'storage_exceeded'`, [job.project_id])
            }
        }
    }

    private async deleteProject(job: Job): Promise<void> {
        if (!job.project_id) throw new Error('delete job missing project_id')
        const result = await this.platformPool.query<{
            database_name: string
            database_runtime_user: string | null
            database_migration_user: string | null
            storage_bucket: string | null
            storage_access_key: string | null
            database_secret_enc: string | null
        }>(
            `SELECT p.database_name, r.database_runtime_user, r.database_migration_user,
                    r.storage_bucket, r.storage_access_key, r.database_secret_enc
             FROM projects p JOIN project_resources r ON r.project_id = p.id
             WHERE p.id = $1 AND p.purge_after <= now()`,
            [job.project_id],
        )
        const row = result.rows[0]
        if (!row) throw new Error('project purge is not due')
        await this.platformPool.query(
            `UPDATE projects SET status = 'deleted', updated_at = now() WHERE id = $1 AND status = 'deleting'`,
            [job.project_id],
        )
        await this.removeRuntime(job.project_id)
        await this.adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [row.database_name])
        await this.adminPool.query(`DROP DATABASE IF EXISTS ${ident(row.database_name)}`)
        if (row.database_runtime_user) await this.adminPool.query(`DROP ROLE IF EXISTS ${ident(row.database_runtime_user)}`)
        if (row.database_migration_user) await this.adminPool.query(`DROP ROLE IF EXISTS ${ident(row.database_migration_user)}`)
        if (row.database_secret_enc) {
            const decoded = JSON.parse(this.secretBox.decrypt(row.database_secret_enc)) as {writeRole?: string}
            if (decoded.writeRole) await this.adminPool.query(`DROP ROLE IF EXISTS ${ident(decoded.writeRole)}`)
        }
        if (row.storage_bucket) await this.mc(['rb', '--force', `rustfs/${row.storage_bucket}`], true)
        if (row.storage_access_key) await this.mc(['admin', 'user', 'remove', 'rustfs', row.storage_access_key], true)
        await rm(resolve(this.env.SOURCE_ROOT ?? '/data/sources', job.project_id), {recursive: true, force: true})
        await rm(resolve(this.env.ARTIFACT_ROOT ?? '/data/artifacts', job.project_id), {recursive: true, force: true})
        if (row.storage_access_key) {
            await this.mc(['admin', 'policy', 'remove', 'rustfs', `policy-${row.storage_access_key}`], true)
        }
        const renders = await this.platformPool.query<{job_id: string; screenshot_path: string | null}>(
            `SELECT job_id, screenshot_path FROM render_results WHERE project_id = $1`,
            [job.project_id],
        )
        for (const render of renders.rows) {
            if (render.screenshot_path) await rm(render.screenshot_path, {force: true})
            await rm(resolve(this.env.RENDER_ROOT ?? '/data/renders', `${render.job_id}.json`), {force: true})
        }
        // The gallery image has no expiry of its own — it is the live picture of
        // a listed project, not a cached render — so purge is where it goes.
        // Keyed on the project id rather than on the recorded path, because a
        // row whose path was cleared can still have left the file behind.
        await rm(resolve(this.env.SHOWCASE_ROOT ?? '/data/showcase', `${job.project_id}.png`), {force: true})
        const dumps = await this.platformPool.query<{file_path: string | null}>(
            `SELECT file_path FROM database_exports WHERE project_id = $1`,
            [job.project_id],
        )
        for (const dump of dumps.rows) {
            if (dump.file_path) await rm(dump.file_path, {force: true})
        }
        await this.removeRuntimeNetwork(job.project_id)
        await this.platformPool.query(`DELETE FROM projects WHERE id = $1`, [job.project_id])
    }

    private async housekeeping(): Promise<void> {
        await this.reattachGatewayNetworks().catch(error =>
            console.error('[executor] gateway network reattach failed', errorText(error)))
        await this.platformPool.query(`
            UPDATE jobs j
            SET status = 'queued', run_after = now() + interval '10 minutes',
                locked_at = NULL, locked_by = NULL, attempts = 0
            FROM projects p
            WHERE j.project_id = p.id AND j.kind = 'delete_project'
              AND j.status = 'failed' AND p.status = 'deleted'
        `)
        // One interval for every kind. A running job renews its lease while it
        // is genuinely working, so this only reclaims work whose worker died —
        // which is why it can be minutes rather than the quarter of an hour the
        // per-kind version needed to avoid killing a slow build.
        const swept = await this.platformPool.query<{kind: string}>(SWEEP_LEASES_SQL, [leaseSeconds(this.env)])
        for (const job of swept.rows) {
            console.error(`[executor] reclaimed a ${job.kind} job whose worker stopped renewing its lease`)
        }
        // jobs is otherwise append-only, and measure_usage alone adds one row
        // per project every five minutes forever. Left to grow it degrades the
        // claim's per-project NOT EXISTS and every metrics query.
        //
        // The kind filter is load-bearing: render_results, probe_results, and
        // database_exports all reference jobs(id) ON DELETE CASCADE, so pruning
        // a succeeded render or export would delete the artifact its owner is
        // about to fetch. review_site is safe to prune for the opposite reason:
        // site_reviews deliberately holds no job reference, so the verdict
        // outlives the job that produced it.
        await this.platformPool.query(`
            DELETE FROM jobs
            WHERE status = 'succeeded' AND finished_at < now() - interval '3 days'
              AND kind IN ('measure_usage', 'start_runtime', 'stop_runtime', 'provision_project', 'review_site')
        `)
        await this.sweepIncomingArtifacts()
        // Before the idle sweep, so a row demoted here is not also handed a
        // stop_runtime job for a container that is already gone.
        await this.reconcileRuntimeState().catch(error =>
            console.error('[executor] runtime state reconcile failed', errorText(error)))
        await this.platformPool.query(
            `INSERT INTO jobs (kind, project_id, version_id, idempotency_key)
             SELECT 'stop_runtime', pr.project_id, pr.version_id,
                    'stop:' || pr.project_id || ':' || pr.version_id || ':' || date_trunc('hour', now())::text
             FROM project_runtime pr
             WHERE pr.state = 'running' AND pr.last_seen_at < now() - interval '15 minutes'
               -- Housekeeping now runs alongside jobs. A render or probe that
               -- reused a warm runtime would otherwise have it stopped out from
               -- under it while the job is still in flight.
               AND NOT EXISTS (
                   SELECT 1 FROM jobs j
                   WHERE j.project_id = pr.project_id AND j.status IN ('queued', 'running'))
             ON CONFLICT (idempotency_key) DO NOTHING`,
        )
        // The slug comes along because the metrics snapshot labels runtimes by
        // it, and this is now the only query that lists running runtimes in a
        // pass.
        const running = await this.platformPool.query<RunningRuntime>(
            `SELECT r.project_id::text AS project_id, r.version_id::text AS version_id, p.slug
             FROM project_runtime r JOIN projects p ON p.id = r.project_id
             WHERE r.state = 'running'`,
        )
        for (const runtime of running.rows) {
            const output = await dockerLogs(runtimeName(runtime.project_id, runtime.version_id), '70s')
            if (output.trim()) {
                await this.log(runtime.project_id, runtime.version_id, 'runtime', 'info', output.slice(-20_000))
            }
        }
        // Two error boundaries rather than one: the control plane's only view of
        // container health is the snapshot file, so a failed stats sweep must
        // still leave a snapshot behind. It reports no runtimes for that pass,
        // which the previous sampling failure did too.
        const readings = await this.sampleResources(running.rows).catch(error => {
            console.error('[executor] resource sampling failed', errorText(error))
            return [] as RuntimeReading[]
        })
        await this.writeMetricsSnapshot(readings).catch(error =>
            console.error('[executor] metrics snapshot failed', errorText(error)))
        await this.platformPool.query(
            `INSERT INTO jobs (kind, project_id, idempotency_key)
             SELECT 'measure_usage', id,
                    'usage:' || id || ':' ||
                    (date_trunc('hour', now()) +
                     floor(date_part('minute', now()) / 5) * interval '5 minutes')::text
             FROM projects WHERE status IN ('ready','storage_exceeded')
             ON CONFLICT (idempotency_key) DO NOTHING`,
        )
        await this.platformPool.query(`DELETE FROM oauth_login_states WHERE expires_at < now()`)
        await this.platformPool.query(`DELETE FROM oauth_consent_requests WHERE expires_at < now() OR consumed_at < now() - interval '1 day'`)
        await this.platformPool.query(`DELETE FROM oauth_authorization_codes WHERE expires_at < now()`)
        await this.platformPool.query(`DELETE FROM oauth_refresh_tokens WHERE expires_at < now() OR revoked_at < now() - interval '7 days'`)
        await this.platformPool.query(`DELETE FROM site_login_tickets WHERE expires_at < now()`)
        await this.platformPool.query(`DELETE FROM source_uploads WHERE expires_at < now()`)
        await this.platformPool.query(`DELETE FROM project_logs WHERE created_at < now() - interval '7 days'`)
        // Site analytics. The two tables have different lifetimes and the
        // difference is the privacy control: site_visitor_days holds a
        // pseudonym that can be reversed by anyone holding the key, so it goes
        // early, while site_visit_days holds counts alone and can be kept.
        //
        // The cutoff is computed here rather than in SQL, for the same reason
        // the gateway computes the bucket rather than letting PostgreSQL do it:
        // a day is a campus-local calendar day, and this container runs in UTC.
        // A prune that used CURRENT_DATE would disagree with the writer by
        // eight hours.
        const today = visitDay(new Date(), this.deployment.analyticsTimeZone)
        await this.platformPool.query(VISITOR_PRUNE_SQL, [dayBefore(today, VISITOR_RETENTION_DAYS)])
        await this.platformPool.query(VISIT_PRUNE_SQL, [dayBefore(today, VISIT_RETENTION_DAYS)])
        await this.platformPool.query(`
            WITH ranked AS (
                SELECT id,
                       SUM(octet_length(message) + 256)
                       OVER (PARTITION BY project_id ORDER BY id DESC) AS retained_bytes
                FROM project_logs
            )
            DELETE FROM project_logs l USING ranked r
            WHERE l.id = r.id AND r.retained_bytes > 10485760
        `)
        const expiredRenders = await this.platformPool.query<{job_id: string; screenshot_path: string | null}>(
            `WITH expired AS (
                 DELETE FROM render_results
                 WHERE created_at < now() - interval '24 hours'
                 RETURNING job_id, screenshot_path
             ), reset_jobs AS (
                 UPDATE jobs j
                 SET status = 'failed', error_message = 'render result expired', finished_at = now()
                 FROM expired e
                 -- Only a finished render's result can expire. render_version
                 -- reuses one job row per version, so without this a re-run in
                 -- flight would be marked failed underneath itself.
                 WHERE j.id = e.job_id AND j.status = 'succeeded'
                 RETURNING j.id
             )
             SELECT job_id, screenshot_path FROM expired`,
        )
        for (const render of expiredRenders.rows) {
            if (render.screenshot_path) await rm(render.screenshot_path, {force: true})
            await rm(resolve(this.env.RENDER_ROOT ?? '/data/renders', `${render.job_id}.json`), {force: true})
        }
        // Database dumps hold tenant data, so they are removed from disk as soon
        // as their download window closes rather than being left to accumulate.
        const expiredExports = await this.platformPool.query<{file_path: string | null}>(
            `DELETE FROM database_exports WHERE expires_at < now() RETURNING file_path`,
        )
        for (const dump of expiredExports.rows) {
            if (dump.file_path) await rm(dump.file_path, {force: true})
        }
    }

    /**
     * The control plane has no Docker socket and no view of the host, so the
     * operator page would otherwise have to guess at live resource use. The
     * executor already runs a housekeeping pass every minute and is the only
     * component that can read both, so it records the latest reading here.
     *
     * This is the only sweep in a pass. The metrics snapshot used to run its
     * own, one `docker stats` plus one `docker inspect` per runtime, which is
     * 2N docker invocations a minute on a two-core host on top of this one.
     * Housekeeping running long is a heartbeat risk — the executor's health
     * check fails once its heartbeat file is 120 seconds stale — so both
     * consumers now read the batched sweep below and the returned readings are
     * what `writeMetricsSnapshot` publishes.
     */
    private async sampleResources(running: RunningRuntime[]): Promise<RuntimeReading[]> {
        const containers = new Map(running.map(row => [runtimeName(row.project_id, row.version_id), row]))
        let readings: RuntimeReading[] = []
        if (containers.size) {
            const names = [...containers.keys()]
            const stats = await docker(
                ['stats', '--no-stream', '--format', '{{json .}}', ...names],
                60_000,
                true,
            )
            // OOMKilled is not in `docker stats` and it is what the runtime_oom
            // alert is built on, so it needs an inspect. Batched over every
            // runtime it costs one more invocation for the whole pass instead
            // of one per runtime.
            const oom = await dockerInspectPartial(['inspect', '-f', '{{.Name}} {{.State.OOMKilled}}', ...names], 30_000)
            readings = runtimeReadings(containers, stats, oom)
            for (const reading of readings) {
                await this.platformPool.query(
                    `INSERT INTO runtime_samples
                     (project_id, version_id, memory_bytes, memory_limit_bytes, cpu_percent, sampled_at)
                     VALUES ($1,$2,$3,$4,$5,now())
                     ON CONFLICT (project_id, version_id) DO UPDATE
                     SET memory_bytes = EXCLUDED.memory_bytes,
                         memory_limit_bytes = EXCLUDED.memory_limit_bytes,
                         cpu_percent = EXCLUDED.cpu_percent,
                         sampled_at = EXCLUDED.sampled_at`,
                    [reading.projectId, reading.versionId, reading.memoryBytes, reading.memoryLimitBytes, reading.cpuPercent],
                )
            }
        }
        await this.platformPool.query(
            `DELETE FROM runtime_samples s
             WHERE NOT EXISTS (
                 SELECT 1 FROM project_runtime r
                 WHERE r.project_id = s.project_id AND r.version_id = s.version_id
                   AND r.state = 'running'
             )`,
        )
        const load = loadavg()
        const disk = await diskUsage(this.env.DATA_ROOT ?? '/data')
        await this.platformPool.query(
            `INSERT INTO host_samples
             (worker, memory_total_bytes, memory_free_bytes, cpu_count, load1, load5, load15,
              data_total_bytes, data_free_bytes, sampled_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
             ON CONFLICT (worker) DO UPDATE
             SET memory_total_bytes = EXCLUDED.memory_total_bytes,
                 memory_free_bytes = EXCLUDED.memory_free_bytes,
                 cpu_count = EXCLUDED.cpu_count,
                 load1 = EXCLUDED.load1, load5 = EXCLUDED.load5, load15 = EXCLUDED.load15,
                 data_total_bytes = EXCLUDED.data_total_bytes,
                 data_free_bytes = EXCLUDED.data_free_bytes,
                 sampled_at = EXCLUDED.sampled_at`,
            [
                this.workerId, totalmem(), freemem(), cpus().length,
                load[0].toFixed(2), load[1].toFixed(2), load[2].toFixed(2),
                disk?.totalBytes ?? null, disk?.freeBytes ?? null,
            ],
        )
        return readings
    }

    private async applyMigrations(
        database: string,
        user: string,
        password: string,
        directory: string,
        maxBytes: number,
        projectId: string,
        versionId: string,
    ): Promise<void> {
        if (!await exists(directory) || !(await stat(directory)).isDirectory()) {
            throw new Error('configured migration directory is missing from the artifact')
        }
        const pool = new Pool({
            connectionString: postgresUrl(user, password, this.env.POSTGRES_HOST ?? 'postgres', 5432, database),
            max: 1,
            query_timeout: 65_000,
        })
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS _ritsdev_migrations (
                    filename TEXT PRIMARY KEY,
                    checksum TEXT NOT NULL,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            `)
            const entries = (await readdir(directory)).sort()
            const files = entries.filter(file => file.endsWith('.sql'))
            // Applying nothing used to be indistinguishable from applying
            // everything: no log line, no error, and an active deployment.
            await this.log(projectId, versionId, 'migrate', 'info', describeMigrationSet(entries, files))
            if (!files.length) throw new Error(describeMigrationSet(entries, files))
            if (files.length > 100) throw new Error('at most 100 migration files are allowed')
            const migrationDeadline = Date.now() + 10 * 60_000
            let applied = 0
            let alreadyPresent = 0
            for (const filename of files) {
                if (Date.now() >= migrationDeadline) throw new Error('migration set exceeded the 10-minute deadline')
                const sql = await readFile(join(directory, filename), 'utf8')
                const checksum = createHash('sha256').update(sql).digest('hex')
                const existing = await pool.query<{checksum: string}>(`SELECT checksum FROM _ritsdev_migrations WHERE filename = $1`, [filename])
                if (existing.rowCount) {
                    if (existing.rows[0].checksum !== checksum) throw new Error(`migration changed after application: ${filename}`)
                    alreadyPresent += 1
                    await this.log(projectId, versionId, 'migrate', 'info', `skipped ${filename} (already applied, checksum matches)`)
                    continue
                }
                const startedAt = Date.now()
                const client = await pool.connect()
                try {
                    await client.query('BEGIN')
                    const remainingMs = Math.max(1, Math.min(60_000, migrationDeadline - Date.now()))
                    for (const guard of migrationSessionGuards(remainingMs)) await client.query(guard)
                    await client.query(sql)
                    const usage = await client.query<{bytes: string}>(
                        `SELECT pg_database_size(current_database())::text AS bytes`,
                    )
                    if (Number(usage.rows[0].bytes) > maxBytes) {
                        throw new Error(`migration would exceed the ${maxBytes}-byte database quota`)
                    }
                    await client.query(`INSERT INTO _ritsdev_migrations (filename, checksum) VALUES ($1,$2)`, [filename, checksum])
                    await client.query('COMMIT')
                    applied += 1
                    await this.log(projectId, versionId, 'migrate', 'info', `applied ${filename} (${Date.now() - startedAt}ms)`)
                } catch (error) {
                    await client.query('ROLLBACK')
                    throw error
                } finally {
                    client.release()
                }
            }
            await this.log(
                projectId,
                versionId,
                'migrate',
                'info',
                `migrations: ${applied} applied, ${alreadyPresent} already present`,
            )
        } finally {
            await pool.end()
        }
    }

    /**
     * A version with both functions and a database whose schema is empty after
     * migrations is about to fail every request with `relation ... does not
     * exist`. Say so at deploy time rather than leaving it to be discovered
     * through a 500 with no explanation.
     */
    private async warnOnEmptySchema(job: Job, row: {database_name: string; database_migration_user: string | null; database_secret_enc: string | null}): Promise<void> {
        if (!row.database_migration_user || !row.database_secret_enc) return
        const credentials = JSON.parse(this.secretBox.decrypt(row.database_secret_enc)) as {migrationPassword: string}
        const pool = new Pool({
            connectionString: postgresUrl(
                row.database_migration_user,
                credentials.migrationPassword,
                this.env.POSTGRES_HOST ?? 'postgres',
                5432,
                row.database_name,
            ),
            max: 1,
            query_timeout: 10_000,
        })
        try {
            const count = await pool.query<{tables: string}>(
                `SELECT count(*)::text AS tables FROM pg_tables
                 WHERE schemaname = 'public' AND tablename <> '_ritsdev_migrations'`,
            )
            if (Number(count.rows[0].tables) === 0) {
                await this.log(
                    job.project_id!,
                    job.version_id,
                    'migrate',
                    'warn',
                    'migrations applied but schema public contains no tables; the site database role cannot ' +
                        'create objects, so a function that expects a table will fail with ' +
                        '`relation "..." does not exist`. Put your DDL in the directory named by ' +
                        'database.migrations in ritsdev.site.json.',
                )
            }
        } catch {
            // Advisory only: never fail a deployment because the warning could
            // not be computed.
        } finally {
            await pool.end().catch(() => {})
        }
    }

    private async runNodeBuild(
        work: string,
        staging: string,
        cache: string,
        manifest: SiteManifest,
        network: string,
        projectId: string,
        versionId: string,
    ): Promise<void> {
        const command = `${installPrefix(manifest.build, await exists(join(work, 'package.json')))}${manifest.build!.command}`
        const name = `rits-build-${randomUUID().replace(/-/g, '').slice(0, 20)}`
        // `staging` lives outside the uploaded tree. The workspace is a
        // size-capped tmpfs that vanishes when the container exits, so the
        // output is copied out from inside the container instead; `docker cp`
        // after exit silently yields an empty directory.
        assertStagingOutsideSource(work, staging)
        const workspaceMb = readPositiveInt(this.env, 'BUILD_WORKSPACE_MB', 1024)
        const memoryMb = readPositiveInt(this.env, 'BUILD_MEMORY_MB', 2048)
        const tmpMb = readPositiveInt(this.env, 'BUILD_TMP_MB', 256)
        try {
            const output = await dockerCombined([
                'run', '--name', name,
                '--network', network,
                '--memory', `${memoryMb}m`, '--cpus', '1', '--pids-limit', '256',
                '--read-only',
                '--tmpfs', `/tmp:rw,noexec,nosuid,size=${tmpMb}m`,
                '--tmpfs', `/workspace:rw,exec,nosuid,size=${workspaceMb}m`,
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                ...dockerLogOptions(5),
                '--env', 'HTTPS_PROXY=http://build-proxy:3128',
                '--env', 'https_proxy=http://build-proxy:3128',
                '--env', 'npm_config_https_proxy=http://build-proxy:3128',
                // Node's global fetch ignores the proxy environment entirely
                // without this, so a build script that calls fetch() failed with
                // EAI_AGAIN while npm — which reads the same variables itself —
                // worked. No HTTP_PROXY: build-proxy only permits CONNECT to 443,
                // so plain HTTP would fail more confusingly, not less.
                '--env', 'NODE_USE_ENV_PROXY=1',
                '--env', 'NO_PROXY=',
                // npm's cache used to land on a 64 MiB tmpfs that also counted
                // against the container's memory limit, so any non-trivial
                // dependency tree died with ENOSPC while the host had ~150 GB
                // free. It is disk-backed now and no longer competes with the
                // build's own heap.
                '--env', 'npm_config_cache=/npm-cache',
                '--env', 'HOME=/tmp',
                '--mount', `type=bind,src=${this.hostPath(work)},dst=/source,readonly`,
                '--mount', `type=bind,src=${this.hostPath(staging)},dst=/out`,
                '--mount', `type=bind,src=${this.hostPath(cache)},dst=/npm-cache`,
                '--workdir', '/workspace',
                this.env.NODE_BUILD_IMAGE ?? 'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd',
                '/bin/sh', '-lc', nodeBuildScript(command, manifest.build!.output),
            ], 5 * 60_000)
            if (output.trim()) await this.log(projectId, versionId, 'build', 'info', output.slice(-20_000))
            await rejectSymlinks(staging)
        } catch (error) {
            const text = errorText(error)
            if (/ENOSPC|no space left/i.test(text)) {
                throw new Error(
                    `${text}\nThe build workspace is a ${workspaceMb} MiB tmpfs holding your source, ` +
                        'node_modules, and build output together. Raise BUILD_WORKSPACE_MB on the platform ' +
                        'or reduce what the build writes.',
                )
            }
            throw error
        } finally {
            await docker(['rm', '-f', name], 30_000, true)
        }
    }

    private async cacheDeno(artifactRoot: string, entrypoint: string, network: string): Promise<void> {
        const cache = join(artifactRoot, 'deno-dir')
        await mkdir(cache, {recursive: true})
        const name = `rits-cache-${randomUUID().replace(/-/g, '').slice(0, 20)}`
        try {
            await docker([
                'run', '--name', name,
                '--network', network,
                '--memory', '768m', '--cpus', '1', '--pids-limit', '256',
                '--read-only',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
                // Written straight into the artifact tree. A tmpfs here is
                // discarded when the container exits, so the later `docker cp`
                // copied nothing and every dependency then failed the
                // --cached-only runtime.
                '--mount', `type=bind,src=${this.hostPath(cache)},dst=/deno-dir`,
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                ...dockerLogOptions(5),
                '--env', 'DENO_DIR=/deno-dir',
                '--env', 'HOME=/tmp',
                '--env', 'HTTPS_PROXY=http://build-proxy:3128',
                '--env', 'https_proxy=http://build-proxy:3128',
                '--env', 'NO_PROXY=',
                '--mount', `type=bind,src=${this.hostPath(join(artifactRoot, 'source'))},dst=/app/source,readonly`,
                this.env.DENO_RUNTIME_IMAGE ?? 'denoland/deno:2.9.4@sha256:c777b4b225501a61074837e90a826a58f99124837824023cd60334b1e2374498',
                'deno', 'cache', `file:///app/source/${entrypoint}`,
            ], 5 * 60_000)
        } finally {
            await docker(['rm', '-f', name], 30_000, true)
        }
    }

    // Every Docker network mutation goes through one mutex. Concurrent jobs
    // otherwise probe the same candidate subnet, and the housekeeping gateway
    // reattach can re-add an endpoint to a network delete_project is removing,
    // which makes `network rm` fail with "has active endpoints".
    private async createBuildNetwork(jobId: string): Promise<string> {
        return await this.networkMutex.run(() => this.createBuildNetworkLocked(jobId))
    }

    private async removeBuildNetwork(network: string): Promise<void> {
        await this.networkMutex.run(() => this.removeBuildNetworkLocked(network))
    }

    private async reattachGatewayNetworks(): Promise<void> {
        await this.networkMutex.run(() => this.reattachGatewayNetworksLocked())
    }

    private async ensureRuntimeNetwork(projectId: string): Promise<string> {
        return await this.networkMutex.run(() => this.ensureRuntimeNetworkLocked(projectId))
    }

    private async removeRuntimeNetwork(projectId: string): Promise<void> {
        await this.networkMutex.run(() => this.removeRuntimeNetworkLocked(projectId))
    }

    private async createBuildNetworkLocked(jobId: string): Promise<string> {
        const network = `ritsdev-build-${jobId.replace(/-/g, '').slice(0, 20)}`
        await createNetworkFromPool({
            network,
            seed: jobId,
            pool: required(this.env, 'BUILD_NETWORK_POOL'),
            childPrefix: dynamicNetworkPrefix(this.env),
            bridge: `rtb${jobId.replace(/-/g, '').slice(0, 12)}`,
            label: `ritsdev.build=${jobId}`,
            internal: true,
        })
        await connectNetwork(network, required(this.env, 'BUILD_PROXY_CONTAINER'), 'build-proxy')
        return network
    }

    private async removeBuildNetworkLocked(network: string): Promise<void> {
        await disconnectNetwork(network, required(this.env, 'BUILD_PROXY_CONTAINER'))
        await docker(['network', 'rm', network], 30_000, true)
    }

    private async ensureRole(
        name: string,
        password: string | null,
        login: boolean,
        connectionLimit?: number,
        keepPassword = false,
    ): Promise<void> {
        const found = await this.adminPool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [name])
        if (!found.rowCount) {
            const loginSql = login ? `LOGIN PASSWORD ${literal(password ?? '')}` : 'NOLOGIN'
            const limitSql = connectionLimit ? ` CONNECTION LIMIT ${connectionLimit}` : ''
            await this.adminPool.query(`CREATE ROLE ${ident(name)} ${loginSql}${limitSql}`)
        } else if (login && keepPassword) {
            // The stored credential is still the live one and may already be
            // inside a running container's environment; re-set everything except
            // the password.
            const limitSql = connectionLimit ? ` CONNECTION LIMIT ${connectionLimit}` : ''
            await this.adminPool.query(`ALTER ROLE ${ident(name)} LOGIN${limitSql}`)
        } else if (login) {
            const limitSql = connectionLimit ? ` CONNECTION LIMIT ${connectionLimit}` : ''
            await this.adminPool.query(`ALTER ROLE ${ident(name)} LOGIN PASSWORD ${literal(password ?? '')}${limitSql}`)
        } else {
            await this.adminPool.query(`ALTER ROLE ${ident(name)} NOLOGIN`)
        }
    }

    private async provisionBucket(bucket: string, access: string, secret: string, quotaBytes: number): Promise<void> {
        await this.mc(['mb', '--ignore-existing', `rustfs/${bucket}`])
        const temp = await mkdtemp(join(tmpdir(), 'rits-policy-'))
        try {
            const policyName = `policy-${access}`
            const policyFile = join(temp, 'policy.json')
            await writeFile(policyFile, JSON.stringify({
                Version: '2012-10-17',
                Statement: [{
                    Effect: 'Allow',
                    Action: ['s3:GetBucketLocation', 's3:ListBucket'],
                    Resource: [`arn:aws:s3:::${bucket}`],
                }, {
                    Effect: 'Allow',
                    Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
                    Resource: [`arn:aws:s3:::${bucket}/*`],
                }],
            }))
            await this.mc(['admin', 'user', 'remove', 'rustfs', access], true)
            await this.mc(['admin', 'policy', 'remove', 'rustfs', policyName], true)
            await this.mc(['admin', 'user', 'add', 'rustfs', access, secret])
            await this.mc(['admin', 'policy', 'create', 'rustfs', policyName, policyFile])
            await this.mc(['admin', 'policy', 'attach', 'rustfs', policyName, '--user', access])
            await this.mc(['quota', 'set', `--size=${quotaBytes}`, `rustfs/${bucket}`])
        } finally {
            await rm(temp, {recursive: true, force: true})
        }
    }

    /**
     * Runs an `mc` command with per-invocation credentials. Serialised because
     * `mc` still writes bookkeeping into its config directory.
     */
    private async mc(args: string[], ignoreMissing = false): Promise<string> {
        const configDir = this.env.MC_CONFIG_DIR ?? '/tmp/mc'
        return await this.storageMutex.run(() => mc(args, ignoreMissing, mcEnv(this.env, configDir)))
    }

    /**
     * Publishes what only this process can see: container health and per-runtime
     * resource use, both of which need the Docker socket. The control plane
     * reads the file when it is scraped.
     *
     * A file rather than an HTTP endpoint on the executor, because that would
     * mean a new listener, a new port, and a new authentication story for a
     * process that deliberately has none. Staleness is itself an alert, so a
     * dead executor is visible rather than silently absent.
     *
     * The runtime figures arrive from `sampleResources`' single batched sweep
     * rather than being sampled again here; this method issues no per-runtime
     * docker call of its own.
     */
    private async writeMetricsSnapshot(readings: RuntimeReading[]): Promise<void> {
        const target = resolve(this.env.EXECUTOR_METRICS_FILE ?? '/data/metrics/executor.json')
        await mkdir(resolve(target, '..'), {recursive: true, mode: 0o755})

        const services: Array<{name: string; running: boolean; health: string; restarts: number}> = []
        // Scoped to this compose project. Without the value, the filter also
        // matches the retired legacy stack and any unrelated project on the
        // host, every one of which is legitimately stopped and would look like
        // a service outage.
        const project = this.env.COMPOSE_PROJECT_NAME ?? 'ritsdev'
        // The label alone does not mean compose created the container.
        // `docker compose build` stamps it onto the images it builds and a
        // container inherits its image's labels, so anything the executor runs
        // from a compose-built image arrives wearing it. container-number is
        // set by compose on the container and is never an image label, so it
        // answers the question actually being asked.
        const listed = await docker(
            ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`,
                '--format', '{{.Names}}\t{{.Label "com.docker.compose.container-number"}}'],
            30_000, true,
        ).catch(() => '')
        const foreign: string[] = []
        for (const line of listed.split('\n').map(entry => entry.trim()).filter(Boolean)) {
            const [name, containerNumber] = line.split('\t')
            if (!name) continue
            if (!containerNumber?.trim()) {
                foreign.push(name)
                continue
            }
            // Never inspect cloudflared: its tunnel token is in the command line.
            if (/cloudflared/.test(name)) continue
            // One-shot init containers exit successfully by design.
            if (/-data-init/.test(name)) continue
            const state = await docker(
                ['inspect', '-f', '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}', name],
                15_000, true,
            ).catch(() => '')
            const [running, health, restarts] = state.trim().split(/\s+/)
            if (!running) continue
            services.push({name, running: running === 'true', health: health ?? 'none', restarts: Number(restarts ?? 0)})
        }
        if (foreign.length) {
            // Loud rather than silent: under the fix nothing should ever land
            // here, and if a future compose stopped setting container-number
            // this would drop every service instead, which is a monitoring
            // outage that would otherwise look like a quiet, healthy platform.
            console.error(`[executor] ignored ${foreign.length} container(s) carrying this compose project's `
                + `label that compose did not create: ${foreign.join(', ')}`)
        }

        const runtimes = readings.map(reading => ({
            slug: reading.slug,
            cpuPercent: reading.cpuPercent,
            memoryBytes: reading.memoryBytes,
            pids: reading.pids,
            oomKilled: reading.oomKilled,
        }))

        const body = JSON.stringify({
            writtenAt: Date.now(),
            concurrency: executorConcurrency(this.env),
            workersBusy: this.inFlight.size,
            services,
            runtimes,
        })
        // Written via a temp file and renamed so a scrape never reads a half
        // written document.
        const temp = `${target}.tmp`
        await writeFile(temp, body, {mode: 0o644})
        await rename(temp, target)
    }

    /**
     * Removes staging trees left behind by a build that died before its rename.
     * An hour is far longer than the five-minute build timeout, so this can
     * never race a build that is still assembling one.
     */
    private async sweepIncomingArtifacts(): Promise<void> {
        const root = resolve(this.env.ARTIFACT_ROOT ?? '/data/artifacts')
        const projects = await readdir(root, {withFileTypes: true}).catch(() => [])
        for (const project of projects) {
            if (!project.isDirectory()) continue
            const projectRoot = join(root, project.name)
            for (const entry of await readdir(projectRoot).catch(() => [])) {
                if (!entry.includes('.incoming.')) continue
                const path = join(projectRoot, entry)
                const info = await stat(path).catch(() => null)
                if (!info || Date.now() - info.mtimeMs < 60 * 60_000) continue
                await rm(path, {recursive: true, force: true})
                console.log(`[executor] removed abandoned build staging tree ${path}`)
            }
        }
    }

    private async pruneVersions(projectId: string): Promise<void> {
        const result = await this.platformPool.query<{artifact_path: string; source_revision_id: string}>(
            `WITH doomed AS (
                SELECT v.id
                FROM versions v JOIN projects p ON p.id = v.project_id
                WHERE v.project_id = $1 AND v.id <> p.current_version_id
                  AND NOT EXISTS (
                      SELECT 1 FROM deployments d
                      WHERE d.version_id = v.id AND d.status IN ('queued', 'deploying')
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM jobs j
                      WHERE j.version_id = v.id AND j.status IN ('queued', 'running')
                  )
                ORDER BY v.created_at DESC
                OFFSET (
                    SELECT GREATEST(version_limit - CASE WHEN current_version_id IS NULL THEN 0 ELSE 1 END, 0)
                    FROM projects WHERE id = $1
                )
             )
             DELETE FROM versions v USING doomed
             WHERE v.id = doomed.id
             RETURNING v.artifact_path, v.source_revision_id`,
            [projectId],
        )
        for (const row of result.rows) {
            if (row.artifact_path) await rm(row.artifact_path, {recursive: true, force: true})
            const source = await this.platformPool.query<{archive_path: string}>(
                `DELETE FROM source_revisions s
                 WHERE s.id = $1 AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.source_revision_id = s.id)
                 RETURNING s.archive_path`,
                [row.source_revision_id],
            )
            if (source.rows[0]?.archive_path) await rm(source.rows[0].archive_path, {force: true})
        }
    }

    /**
     * Puts `project_runtime` back in step with the containers that exist.
     *
     * The table records what the platform believes about Docker, and until this
     * pass nothing ever checked. Runtimes run with `--restart no`, so a host
     * reboot, a Docker daemon restart, or an OOM kill leaves every row reading
     * `running` with an endpoint that resolves to nothing. That is unrecoverable
     * on its own: the gateway's wake gate keys off `state`, so a `running` row
     * never cold-starts, and the idle sweep that would have reclaimed it keys off
     * `last_seen_at`, which every visit refreshes. The site 502s for ever and
     * visiting it is what keeps it that way.
     *
     * Demoting the row to `stopped` costs nothing when it is wrong — the next
     * request cold-starts a runtime that was going to be reused — and is the only
     * thing that heals a whole host without waiting for someone to visit each
     * site in turn.
     */
    private async reconcileRuntimeState(): Promise<void> {
        // Deliberately not tolerant: `docker()` only forgives "no such
        // container", so an unreachable daemon throws here and the caller skips
        // the pass. Treating that as "nothing is running" would demote every
        // healthy runtime on the host at once.
        const listed = await docker(
            ['ps', '--filter', 'label=ritsdev.project', '--format',
                '{{.Label "ritsdev.project"}} {{.Label "ritsdev.version"}}'],
            30_000,
        )
        const live = parseRuntimeContainers(listed)
        const demoted = await this.platformPool.query<{project_id: string; version_id: string}>(
            `UPDATE project_runtime pr
             SET state = 'stopped', endpoint = NULL, proxy_secret_enc = NULL
             WHERE pr.state = 'running'
               AND NOT EXISTS (
                   SELECT 1 FROM unnest($1::uuid[], $2::uuid[]) AS live(project_id, version_id)
                   WHERE live.project_id = pr.project_id AND live.version_id = pr.version_id)
               -- A start in flight has already written 'running' from
               -- startRuntime's own update, or is about to; the same guard the
               -- idle sweep uses keeps this pass off a project mid-job.
               AND NOT EXISTS (
                   SELECT 1 FROM jobs j
                   WHERE j.project_id = pr.project_id AND j.status IN ('queued', 'running'))
             RETURNING pr.project_id::text AS project_id, pr.version_id::text AS version_id`,
            [live.map(entry => entry.projectId), live.map(entry => entry.versionId)],
        )
        for (const row of demoted.rows) {
            console.error(
                `[executor] runtime ${row.project_id}/${row.version_id} was recorded running with no container; ` +
                    'marked stopped so the next request cold-starts it',
            )
        }
    }

    private async removeRuntime(projectId: string): Promise<void> {
        const listed = await docker(['ps', '-aq', '--filter', `label=ritsdev.project=${projectId}`], 30_000, true)
        for (const container of listed.split('\n').filter(Boolean)) {
            const versionId = (await docker([
                'inspect', '--format', '{{ index .Config.Labels "ritsdev.version" }}', container,
            ], 30_000, true)).trim()
            if (versionId) await this.captureContainerLogs(projectId, versionId, container)
            await docker(['rm', '-f', container], 30_000, true)
        }
        await this.platformPool.query(
            `UPDATE project_runtime SET state = 'stopped', endpoint = NULL, proxy_secret_enc = NULL WHERE project_id = $1`,
            [projectId],
        )
    }

    /**
     * A recreated gateway loses every per-project network it was attached to,
     * while the runtimes keep running on those networks. Docker DNS then fails
     * with EAI_AGAIN and every function returns 502, and nothing repairs it,
     * because the runtime is still recorded as running so no cold start fires.
     * Reattaching here means a gateway restart heals within one housekeeping
     * pass instead of taking every deployed function down until it is redeployed.
     */
    private async reattachGatewayNetworksLocked(): Promise<void> {
        const gateway = required(this.env, 'GATEWAY_CONTAINER')
        const listed = await docker(
            ['network', 'ls', '--filter', 'label=ritsdev.project', '--format', '{{.Name}} {{.Label "ritsdev.project"}}'],
            30_000, true,
        )
        // Only networks whose project is still live. Reattaching the gateway to
        // a network that delete_project is tearing down leaves an active
        // endpoint on it, and `network rm` then fails.
        const live = await this.platformPool.query<{id: string}>(
            `SELECT id::text FROM projects WHERE status NOT IN ('deleting', 'deleted')`,
        )
        const liveIds = new Set(live.rows.map(row => row.id))
        for (const line of listed.split('\n').map(entry => entry.trim()).filter(Boolean)) {
            const [network, projectId] = line.split(/\s+/)
            if (!network) continue
            if (projectId && !liveIds.has(projectId)) continue
            await connectNetwork(network, gateway, 'gateway').catch(error =>
                console.error(`[executor] could not reattach ${gateway} to ${network}`, errorText(error)))
        }
    }

    private async ensureRuntimeNetworkLocked(projectId: string): Promise<string> {
        const network = runtimeNetworkName(projectId)
        const found = await docker(['network', 'inspect', network], 30_000, true)
        if (!found) {
            await createNetworkFromPool({
                network,
                seed: projectId,
                pool: required(this.env, 'RUNTIME_NETWORK_POOL'),
                childPrefix: dynamicNetworkPrefix(this.env),
                bridge: `rtp${projectId.replace(/-/g, '').slice(0, 12)}`,
                label: `ritsdev.project=${projectId}`,
                internal: false,
            })
        }
        await connectNetwork(network, required(this.env, 'GATEWAY_CONTAINER'), 'gateway')
        await connectNetwork(network, required(this.env, 'PGBOUNCER_CONTAINER'), 'pgbouncer')
        await connectNetwork(network, required(this.env, 'RUSTFS_CONTAINER'), 'rustfs')
        return network
    }

    private async removeRuntimeNetworkLocked(projectId: string): Promise<void> {
        const network = runtimeNetworkName(projectId)
        for (const container of [
            required(this.env, 'GATEWAY_CONTAINER'),
            required(this.env, 'PGBOUNCER_CONTAINER'),
            required(this.env, 'RUSTFS_CONTAINER'),
        ]) {
            await disconnectNetwork(network, container)
        }
        try {
            await docker(['network', 'rm', network], 30_000, true)
        } catch (error) {
            // "has active endpoints" means something reattached between the
            // disconnects and the removal. Disconnect again and retry once
            // rather than adding it to the ignore list, which would silently
            // leak the network and its subnet out of the pool.
            if (!/has active endpoints/i.test(errorText(error))) throw error
            for (const container of [
                required(this.env, 'GATEWAY_CONTAINER'),
                required(this.env, 'PGBOUNCER_CONTAINER'),
                required(this.env, 'RUSTFS_CONTAINER'),
            ]) {
                await disconnectNetwork(network, container)
            }
            await docker(['network', 'rm', network], 30_000, true)
        }
    }

    private async captureContainerLogs(projectId: string, versionId: string, container: string): Promise<void> {
        const output = await dockerLogs(container)
        if (!output.trim()) return
        await this.log(projectId, versionId, 'runtime', 'info', output.slice(-20_000))
    }

    private hostPath(containerPath: string): string {
        const dataRoot = resolve(this.env.DATA_ROOT ?? '/data')
        const absolute = resolve(containerPath)
        const rel = relative(dataRoot, absolute)
        if (!rel || rel.startsWith('..') || rel.startsWith('/')) {
            throw new Error(`dynamic Docker mount must be under ${dataRoot}`)
        }
        return resolve(required(this.env, 'DATA_HOST_ROOT'), rel)
    }

    private async failSubject(job: Job, message: string): Promise<void> {
        if (job.kind === 'build_version' && job.version_id) {
            await this.platformPool.query(`UPDATE versions SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1`, [job.version_id, message])
        }
        if (job.kind === 'deploy_version' && job.deployment_id) {
            await this.platformPool.query(`UPDATE deployments SET status = 'failed', error_message = $2 WHERE id = $1`, [job.deployment_id, message])
        }
        if (job.kind === 'provision_project' && job.project_id) {
            // Only a project that never came up is marked failed. Provisioning
            // is re-runnable now, and a failed attempt to add a resource must
            // not take a healthy live project down with it.
            await this.platformPool.query(
                `UPDATE projects SET status = 'failed', updated_at = now()
                 WHERE id = $1 AND status = 'provisioning'`,
                [job.project_id],
            )
            await this.platformPool.query(
                `UPDATE project_resources SET provision_state = 'failed', provision_error = $2 WHERE project_id = $1`,
                [job.project_id, message.slice(0, 2_000)],
            )
        }
        if (job.kind === 'start_runtime' && job.project_id) {
            let detail = message
            if (job.version_id) {
                const container = runtimeName(job.project_id, job.version_id)
                // Read the logs before destroying the container. Removing it
                // first discarded the Deno stack trace, which is why a throw at
                // module scope surfaced only as "container ... is not running"
                // with nothing to act on.
                const logs = await dockerLogs(container).catch(() => '')
                await docker(['rm', '-f', container], 30_000, true)
                if (logs.trim()) {
                    await this.log(job.project_id, job.version_id, 'runtime', 'error', logs.slice(-20_000))
                    detail = `${message}\n--- container output ---\n${logs.trim().slice(-2_000)}`
                }
            }
            await this.platformPool.query(
                `UPDATE project_runtime
                 SET state = 'failed', endpoint = NULL, proxy_secret_enc = NULL, error_message = $3
                 WHERE project_id = $1 AND version_id = $2`,
                [job.project_id, job.version_id, detail],
            )
            if (job.project_id) await this.log(job.project_id, job.version_id, job.kind, 'error', detail)
            return
        }
        if (job.project_id) await this.log(job.project_id, job.version_id, job.kind, 'error', message)
    }

    /**
     * Records a log line, dropping it if the version it belongs to is gone.
     *
     * `pruneVersions` deletes version rows and leaves their runtime containers
     * behind, still labelled with the version they were started for. When a
     * deployment tears those containers down it captures their logs first, and
     * naming a pruned version violated `project_logs_version_id_fkey` — which
     * threw *after* the activation transaction had committed, so the site was
     * already serving the new version while the deployment recorded itself as
     * failed.
     *
     * The `SELECT ... WHERE EXISTS` makes the insert a no-op instead. Losing
     * the last logs of a version nobody can look up any more costs nothing;
     * failing a deployment that already succeeded costs a great deal.
     */
    private async log(projectId: string, versionId: string | null, source: string, level: string, message: string): Promise<void> {
        await this.platformPool.query(
            PROJECT_LOG_INSERT_SQL,
            [projectId, versionId, source, level, message.slice(0, 20_000)],
        )
    }
}

/**
 * Inserts a log line only when the version it names still exists.
 *
 * A plain INSERT here threw `project_logs_version_id_fkey` during a deployment
 * and failed the job *after* the activation transaction had already committed:
 * the site was serving the new version while the deployment recorded itself as
 * failed. The cause is that `pruneVersions` deletes version rows and leaves
 * their runtime containers running, still labelled with the version they were
 * started for, and tearing one down captures its logs first.
 *
 * Dropping the last logs of a version nobody can look up any more costs
 * nothing. Failing a deployment that already succeeded costs a great deal.
 */
export const PROJECT_LOG_INSERT_SQL =
    `INSERT INTO project_logs (project_id, version_id, source, level, message)
     SELECT $1,$2,$3,$4,$5
     WHERE $2::uuid IS NULL OR EXISTS (SELECT 1 FROM versions WHERE id = $2::uuid)`

export function runtimeWrapper(entrypoint: string, sourceRoot = '/app/source'): string {
    const moduleUrl = pathToFileURL(within(sourceRoot, entrypoint)).href
    // Both try/catch blocks exist to make failures legible. A throw while
    // loading the module kills the isolate before it serves anything, and the
    // platform could previously only report "container is not running"; the
    // entrypoint name and stack now reach the container output, which the
    // executor captures before removing the container.
    return `let module;
try {
  module = await import(${JSON.stringify(moduleUrl)});
} catch (error) {
  console.error("[ritsdev] failed to load function entrypoint ${entrypoint}");
  console.error(error && error.stack || String(error));
  if (error && (error.name === "NotCapable" || /requires env access|NotCapable/i.test(String(error.message)))) {
    console.error("[ritsdev] Deno.env is permission-scoped here: only the variables the platform injects, plus project secrets you declare, may be read. Declare the name with set_project_secrets, or guard the read so a missing variable does not throw at module scope.");
  }
  throw error;
}
const handler = module.default?.fetch ?? module.fetch;
if (typeof handler !== "function") throw new Error("function module must export default.fetch(request) or fetch(request)");
const proxySecret = Deno.env.get("RITSDEV_PROXY_SECRET");
if (!proxySecret) throw new Error("missing runtime proxy secret");
Deno.serve({hostname:"0.0.0.0",port:Number(Deno.env.get("PORT")??8787)}, async request => {
  const url = new URL(request.url);
  if (url.pathname === "/__ritsdev_health") return new Response("ok");
  if (request.headers.get("x-ritsdev-runtime-token") !== proxySecret) {
    return new Response("forbidden", {status:403});
  }
  const headers = new Headers(request.headers);
  headers.delete("x-ritsdev-runtime-token");
  try {
    return await handler(new Request(request, {headers}));
  } catch (error) {
    const text = error && error.message || String(error);
    console.error("[ritsdev] unhandled error in " + request.method + " " + url.pathname);
    console.error(error && error.stack || text);
    if (/permission denied for schema public/.test(text)) {
      console.error("[ritsdev] the site database role cannot create objects. Put your DDL in the " +
        "directory named by database.migrations in ritsdev.site.json; it is applied during deploy, " +
        "recorded in _ritsdev_migrations, and rolled back with the deployment if it fails.");
    }
    return new Response("Internal Server Error", {status:500});
  }
});
`
}

async function rejectSymlinks(root: string): Promise<void> {
    for (const entry of await readdir(root, {withFileTypes: true})) {
        if (entry.name.startsWith('.env')) throw new Error(`source environment files are not allowed: ${entry.name}`)
        const path = join(root, entry.name)
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error(`source symlinks are not allowed: ${entry.name}`)
        if (info.isDirectory()) await rejectSymlinks(path)
    }
}

export function validateArchiveListing(listing: string): void {
    const entries = listing.split('\n').filter(Boolean)
    if (entries.length > 10_000) throw new Error('source archive contains too many entries')
    for (const raw of entries) {
        if (raw.includes('\\') || Buffer.byteLength(raw, 'utf8') > 512) {
            throw new Error(`source archive contains an unsafe path encoding: ${raw.slice(0, 200)}`)
        }
        const path = raw.replace(/^\.\//, '')
        if (path.startsWith('/') || path.split('/').includes('..')) {
            throw new Error(`source archive path escapes project root: ${raw}`)
        }
        if (path.split('/').some(part => part.startsWith('.env'))) {
            throw new Error(`source environment files are not allowed: ${raw}`)
        }
    }
}

export function validateArchiveHeaders(listing: string): void {
    let expandedBytes = 0
    for (const raw of listing.split('\n').filter(Boolean)) {
        const match = /^([\-d])\S*\s+\S+\s+(\d+)\s+/.exec(raw)
        if (!match) {
            throw new Error(`source archive contains a link or special entry: ${raw.slice(0, 200)}`)
        }
        expandedBytes += Number(match[2])
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > 256 * 1024 * 1024) {
            throw new Error('expanded source exceeds 256 MiB')
        }
    }
}

async function directoryBytes(root: string): Promise<number> {
    let total = 0
    for (const entry of await readdir(root, {withFileTypes: true})) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) total += await directoryBytes(path)
        else total += (await stat(path)).size
    }
    return total
}

/**
 * Sets the mode only when it is not already right.
 *
 * `chmod` on a file you do not own needs CAP_FOWNER, and the executor drops
 * every capability except DAC_OVERRIDE — which is why it can write into a
 * directory it does not own but cannot change that directory's mode. The
 * artifact tree is exactly that case: `platform-data-init` runs
 * `chown -R $PLATFORM_UID /data` on every `docker compose up`, so any project
 * directory that predates a restart stops belonging to the executor while the
 * executor keeps being the thing that has to publish into it.
 *
 * Reading first turns the common case into a no-op, because `chown` does not
 * change modes: a directory that was already 0755 stays 0755 and needs nothing.
 * Without this, every build for every pre-existing project failed at the last
 * step with EPERM, after doing all the work.
 */
async function ensureMode(path: string, mode: number): Promise<void> {
    const current = await stat(path)
    if ((current.mode & 0o777) === mode) return
    await chmod(path, mode)
}

async function normalizeArtifactPermissions(root: string): Promise<void> {
    await ensureMode(root, 0o755)
    for (const entry of await readdir(root, {withFileTypes: true})) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) await normalizeArtifactPermissions(path)
        else await ensureMode(path, 0o644)
    }
}

/**
 * The executor runs as root and creates the artifact tree with
 * `mkdir(..., {recursive: true, mode: 0o700})`, which also leaves the
 * per-project parent at 0700. The gateway serves static files as PLATFORM_UID,
 * so without opening that parent it cannot traverse into any artifact and every
 * static asset 404s while functions keep working, because the runtime reaches
 * its own files through a Docker bind mount instead.
 */
export async function publishArtifactPermissions(artifactRoot: string): Promise<void> {
    await normalizeArtifactPermissions(artifactRoot)
    await ensureMode(resolve(artifactRoot, '..'), 0o755)
}

function within(root: string, relative: string): string {
    const target = resolve(root, relative)
    if (!target.startsWith(resolve(root) + '/')) throw new Error('path escapes project root')
    return target
}

async function exists(path: string): Promise<boolean> {
    try { await stat(path); return true } catch { return false }
}

async function docker(args: string[], timeout = 60_000, ignoreMissing = false): Promise<string> {
    try {
        return await exec('docker', args, timeout)
    } catch (error: any) {
        if (ignoreMissing && /No such container|not found/i.test(errorText(error))) return ''
        throw error
    }
}

/**
 * `docker inspect` over several containers at once, keeping whatever it managed
 * to print.
 *
 * A container that exits mid-pass makes the whole call exit non-zero — with
 * "no such object", which is not one of the messages `docker()` forgives — while
 * still writing every container it did find to stdout. Discarding that would
 * cost the pass every runtime's OOM flag to lose one.
 */
async function dockerInspectPartial(args: string[], timeout: number): Promise<string> {
    try {
        return await exec('docker', args, timeout)
    } catch (error: any) {
        return typeof error?.stdout === 'string' ? error.stdout : ''
    }
}

async function dockerCombined(args: string[], timeout: number): Promise<string> {
    const {stdout, stderr} = await execFileP('docker', args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
    })
    return `${stdout}${stderr}`
}

async function dockerLogs(container: string, since?: string): Promise<string> {
    try {
        const args = ['logs', '--tail', '500']
        if (since) args.push('--since', since)
        args.push(container)
        const {stdout, stderr} = await execFileP('docker', args, {
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
            env: process.env,
        })
        return `${stdout}${stderr}`
    } catch (error) {
        if (/No such container|not found/i.test(errorText(error))) return ''
        throw error
    }
}

export interface RuntimeStatSample {
    name: string
    memoryBytes: number
    memoryLimitBytes: number
    cpuPercent: number
    pids: number
}

/** A runtime the control database believes is running. */
export interface RunningRuntime {
    project_id: string
    version_id: string
    slug: string
}

/**
 * One runtime, sampled once. `runtime_samples` and the metrics snapshot are both
 * built from these, so a pass costs one `docker stats` and one `docker inspect`
 * in total rather than a pair per runtime per consumer.
 */
export interface RuntimeReading {
    name: string
    projectId: string
    versionId: string
    slug: string
    memoryBytes: number
    memoryLimitBytes: number
    cpuPercent: number
    pids: number
    oomKilled: boolean
}

/**
 * Joins one batched `docker stats` sweep and one batched `docker inspect` to the
 * runtimes the control database listed.
 *
 * Everything numeric comes through `parseDockerStats`, which is where the
 * leading-digit guard lives, so a container that exited mid-pass is dropped from
 * both consumers by the same check. A runtime named in `containers` but absent
 * here was not sampled; that is deliberate and better than a zero.
 */
export function runtimeReadings(
    containers: Map<string, RunningRuntime>,
    statsOutput: string | null | undefined,
    inspectOutput: string | null | undefined,
): RuntimeReading[] {
    const oomKilled = new Set<string>()
    for (const line of (inspectOutput ?? '').split('\n')) {
        // `docker inspect -f '{{.Name}} ...'` prints the name with a leading
        // slash, which `docker stats` and `docker ps` do not.
        const [name, flag] = line.trim().replace(/^\//, '').split(/\s+/)
        if (name && flag === 'true') oomKilled.add(name)
    }
    const readings: RuntimeReading[] = []
    for (const sample of parseDockerStats(statsOutput)) {
        const runtime = containers.get(sample.name)
        if (!runtime) continue
        readings.push({
            name: sample.name,
            projectId: runtime.project_id,
            versionId: runtime.version_id,
            slug: runtime.slug,
            memoryBytes: sample.memoryBytes,
            memoryLimitBytes: sample.memoryLimitBytes,
            cpuPercent: sample.cpuPercent,
            pids: sample.pids,
            oomKilled: oomKilled.has(sample.name),
        })
    }
    return readings
}

/**
 * `docker stats` prints one JSON object per container with human-readable
 * sizes: `MemUsage` is "12.34MiB / 256MiB" and `CPUPerc` is "1.23%". A
 * container that exits between the runtime query and the sample prints
 * nothing useful, so lines without both figures are skipped rather than
 * recorded as a zero-byte sample, which would read as a healthy idle runtime.
 */
export function parseDockerStats(output: string | null | undefined): RuntimeStatSample[] {
    const samples: RuntimeStatSample[] = []
    for (const line of (output ?? '').split('\n')) {
        if (!line.trim()) continue
        let parsed: {Name?: string; MemUsage?: string; CPUPerc?: string; PIDs?: string}
        try { parsed = JSON.parse(line) } catch { continue }
        const [used, limit] = (parsed.MemUsage ?? '').split('/')
        // `parseDockerSize` answers 0 for anything it cannot read, which is
        // indistinguishable from a genuinely idle runtime. A container that
        // exited mid-pass prints "-- / --", so require a leading digit before
        // trusting either figure rather than recording a dead container as
        // healthy and using no memory.
        if (!parsed.Name || !/^\s*\d/.test(used ?? '') || !/^\s*\d/.test(limit ?? '')) continue
        const cpuPercent = Number.parseFloat((parsed.CPUPerc ?? '').replace('%', ''))
        samples.push({
            name: parsed.Name,
            memoryBytes: parseDockerSize(used),
            memoryLimitBytes: parseDockerSize(limit),
            cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
            pids: Number(parsed.PIDs ?? 0) || 0,
        })
    }
    return samples
}

/**
 * Builds the environment that makes an `mc` invocation stateless.
 *
 * `mc` previously kept its alias in a shared `~/.mc/config.json` on a tmpfs, so
 * every call was a read-modify-write on one file that concurrent jobs would
 * race. MC_HOST_<alias> supplies the same alias per invocation instead, and the
 * RustFS admin credentials travel in the environment rather than argv, which is
 * readable through `docker inspect` and the process table.
 *
 * Note this does not cover every credential: `mc admin user add` still takes a
 * per-project secret as a positional argument, because the client offers no
 * environment form for it. That is pre-existing and recorded as a follow-up.
 */
export function mcEnv(env: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
    const endpoint = env.RUSTFS_ENDPOINT ?? 'http://rustfs:9000'
    const url = new URL(endpoint)
    url.username = encodeURIComponent(required(env, 'RUSTFS_ACCESS_KEY'))
    url.password = encodeURIComponent(required(env, 'RUSTFS_SECRET_KEY'))
    return {MC_HOST_rustfs: url.toString(), MC_CONFIG_DIR: configDir}
}

async function mc(args: string[], ignoreMissing = false, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
    try { return await exec('mc', ['--config-dir', extraEnv?.MC_CONFIG_DIR ?? '/tmp/mc', ...args], 60_000, extraEnv) }
    catch (error) {
        if (ignoreMissing && /not found|does not exist|nosuch|unknown user|unknown policy/i.test(errorText(error))) return ''
        throw error
    }
}

/** Parses `docker stats` memory, which reads like "12.3MiB / 256MiB". */
export function parseDockerSize(value: string): number {
    const match = /^([\d.]+)\s*([KMGT]?i?B)?/i.exec(value.trim())
    if (!match) return 0
    const scale: Record<string, number> = {
        b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
        kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
    }
    return Math.round(Number(match[1]) * (scale[(match[2] ?? 'b').toLowerCase()] ?? 1))
}

async function sha256File(path: string): Promise<string> {
    const {createReadStream} = await import('node:fs')
    const hash = createHash('sha256')
    await pipeline(createReadStream(path), hash)
    return hash.digest('hex')
}

async function exec(command: string, args: string[], timeout: number, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
    const {stdout, stderr} = await execFileP(command, args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: extraEnv ? {...process.env, ...extraEnv} : process.env,
    })
    if (stderr) console.error(`[${basename(command)}] ${stderr.trim().slice(-4000)}`)
    return stdout
}

// `deno eval` has implicit access to all permissions and rejects granular
// permission flags, so passing --allow-net here makes every health check fail
// with an argument error and leaves the runtime permanently 'failed'. The
// evaluated source is a fixed platform literal, never tenant input, and the
// container it runs in is already read-only, capability-free, and confined to
// the project network.
/**
 * The build output is prepared and bind-mounted read-write. If it were placed
 * inside the uploaded tree it would delete the author's own files whenever
 * build.output names a directory they shipped prebuilt, and the deployment
 * would still report success while serving nothing.
 */
export function parseNetworkList(output: string | null | undefined): string[] {
    return (output ?? '').split('\n').map(value => value.trim()).filter(Boolean)
}

const RUNTIME_LABEL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The (project, version) pairs that still have a live runtime container.
 *
 * Both labels have to be present and have to parse as UUIDs. The pairs go
 * straight into a `uuid[]` comparison, so one container labelled by hand — or a
 * `docker ps` line for an image that predates the labels — would fail the cast
 * and take the whole reconcile with it. That is the pass a stuck runtime depends
 * on, so it drops what it cannot read rather than refusing to run.
 */
export function parseRuntimeContainers(
    output: string | null | undefined,
): Array<{projectId: string; versionId: string}> {
    const pairs: Array<{projectId: string; versionId: string}> = []
    for (const line of parseNetworkList(output)) {
        const [projectId, versionId] = line.split(/\s+/)
        if (RUNTIME_LABEL_UUID.test(projectId ?? '') && RUNTIME_LABEL_UUID.test(versionId ?? '')) {
            pairs.push({projectId, versionId})
        }
    }
    return pairs
}

export function assertStagingOutsideSource(work: string, staging: string): void {
    const source = resolve(work)
    const target = resolve(staging)
    if (target === source || target.startsWith(`${source}/`)) {
        throw new Error(`build staging must not live inside the uploaded source: ${target}`)
    }
}

// Only USERSET parameters belong here. The migration role is deliberately not a
// superuser, so a SUSET parameter such as temp_file_limit raises "permission
// denied to set parameter" and fails the whole migration; those limits are
// pinned to the role during provisioning instead.
export function migrationSessionGuards(remainingMs: number): string[] {
    return [
        `SET LOCAL statement_timeout = '${remainingMs}ms'`,
        `SET LOCAL lock_timeout = '5s'`,
        `SET LOCAL idle_in_transaction_session_timeout = '65s'`,
        `SET LOCAL work_mem = '4MB'`,
    ]
}

// The final copy runs inside the container so the size-capped tmpfs workspace
// is still mounted; `docker cp` from an exited container cannot see it.
/**
 * The Playwright program the render container runs.
 *
 * Two properties matter and both were previously absent. It waits for `load`
 * rather than `networkidle`, because a page that polls, streams, or holds a
 * websocket never reaches network idle and so always hit the timeout however
 * warm the runtime was. And it writes `/output/diagnostics.json` on every path,
 * so a navigation failure still returns the console output and page errors that
 * explain it — the previous version threw before writing the file, discarding
 * exactly the evidence the caller needed.
 *
 * It also collects the `evidence` block a site review reads: the title, the
 * visible text, every form, and the origins the page loaded scripts and images
 * from. Three details there are load-bearing rather than incidental.
 *
 * Forms report their `action` **attribute**, not the resolved `form.action`
 * property. The render reaches the site as `http://gateway:3001`, so the
 * property resolves every relative action against that internal origin, and a
 * site's own login would arrive looking like it posts somewhere else — which is
 * the one signal that is otherwise almost never wrong. The attribute is what
 * the author wrote, and the reviewer resolves it against the public host.
 *
 * Origins exclude that same internal origin for the same reason: everything the
 * page loads from itself arrives as `gateway:3001`, and counting those as
 * third-party assets would flag every page with a stylesheet.
 *
 * They are recorded when the request is *made*, not when it succeeds. The
 * render container's only egress is a filtering proxy, so an attempt to load
 * from an external host may well fail — and the attempt is the evidence.
 */
/**
 * `fullPage` is the caller's, because the two consumers want different
 * pictures of the same page. A preview the author asked for should show the
 * whole document, however long it is. A gallery thumbnail must be one fixed
 * shape, and a full-page shot of a long landing page is a 1440x9000 strip that
 * a card can only render as a sliver of its header or a smear.
 */
export function renderScript(budget: RenderBudget, options: {fullPage?: boolean} = {}): string {
    const fullPage = options.fullPage !== false
    return `
const {chromium}=require('playwright');
const fs=require('fs');
(async()=>{
const logs=[];
const origins=new Set();
let status=null,error=null,settled=false;
let evidence={title:'',text:'',truncated:false,forms:[],origins:[]};
const browser=await chromium.launch({headless:true,proxy:{server:'http://build-proxy:3128',bypass:'gateway,127.0.0.1,localhost'}});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.route('**/*',async route=>{const headers={...route.request().headers()};const url=new URL(route.request().url());if(url.hostname==='gateway'&&url.port==='3001'){headers['x-ritsdev-render-host']=process.env.TARGET_HOST;headers['x-ritsdev-render-token']=process.env.RENDER_TOKEN;}else{delete headers['x-ritsdev-render-token'];delete headers['x-ritsdev-render-host'];const kind=route.request().resourceType();if((kind==='script'||kind==='image')&&origins.size<${EVIDENCE_MAX_ORIGINS})origins.add(url.origin);}await route.continue({headers});});
page.on('console',m=>logs.push({type:m.type(),text:m.text()}));
page.on('pageerror',e=>logs.push({type:'pageerror',text:e.message}));
try{
  const response=await page.goto(process.env.TARGET_URL,{waitUntil:'load',timeout:${budget.navigationMs}});
  status=response&&response.status();
  settled=await page.waitForLoadState('networkidle',{timeout:${budget.settleMs}}).then(()=>true,()=>false);
}catch(e){error=String(e&&e.message||e);}
try{
  evidence=await page.evaluate(limits=>{
    const text=((document.body&&document.body.innerText)||'').replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim();
    const forms=Array.from(document.forms).slice(0,limits.forms).map(form=>({
      action:form.getAttribute('action')||'',
      method:(form.getAttribute('method')||'get').toLowerCase(),
      inputs:Array.from(form.querySelectorAll('input,select,textarea')).slice(0,limits.inputs)
        .map(field=>(field.getAttribute('type')||field.tagName).toLowerCase()),
    }));
    return {title:document.title||'',text:text.slice(0,limits.text),truncated:text.length>limits.text,forms:forms,origins:[]};
  },{text:${EVIDENCE_TEXT_LIMIT},forms:${EVIDENCE_MAX_FORMS},inputs:${EVIDENCE_MAX_INPUTS}});
}catch(e){logs.push({type:'pageerror',text:'evidence collection failed: '+String(e&&e.message||e)});}
evidence.origins=Array.from(origins);
try{await page.screenshot({path:'/output/screenshot.png',fullPage:${fullPage}});}catch(e){if(!error)error=String(e&&e.message||e);}
fs.writeFileSync('/output/diagnostics.json',JSON.stringify({status,error,settled,console:logs,evidence}));
await browser.close();
process.exit(error?1:0);
})().catch(e=>{
  try{fs.writeFileSync('/output/diagnostics.json',JSON.stringify({status:null,error:String(e&&e.message||e),settled:false,console:[],evidence:null}));}catch{}
  console.error(e);
  process.exit(1);
});`
}

/**
 * Docker log options for a launched container.
 *
 * `max-file=1` is not a valid choice: the local driver compresses rotated
 * files, and compression cannot be enabled with a single file, so the container
 * fails to start with an error about the logging driver rather than anything to
 * do with the workload. That has now cost two separate debugging sessions, so
 * the floor of 2 is enforced here instead of being repeated at each call site.
 */
/**
 * Single-quotes an argument for `sh -c`. Only used to re-assemble an argument
 * list the platform itself constructed, never anything a tenant supplies.
 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

export function dockerLogOptions(maxSizeMb: number, maxFiles = 2): string[] {
    if (!Number.isInteger(maxFiles) || maxFiles < 2) {
        throw new Error(`docker local log driver needs max-file >= 2 for compression, got ${maxFiles}`)
    }
    return [
        '--log-driver', 'local',
        '--log-opt', `max-size=${maxSizeMb}m`,
        '--log-opt', `max-file=${maxFiles}`,
    ]
}

export function nodeBuildScript(command: string, output: string): string {
    return `cp -a /source/. /workspace/ && ${command} && cp -a /workspace/${output}/. /out/`
}

export function runtimeHealthCommand(container: string): string[] {
    return [
        'exec', container,
        'deno', 'eval',
        `const r=await fetch("http://127.0.0.1:8787/__ritsdev_health");if(!r.ok)Deno.exit(1)`,
    ]
}

export function containerStateCommand(container: string): string[] {
    return ['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', container]
}

/**
 * Parses `docker inspect` state output. Returns null while the container is
 * still running, or the exit code once it has stopped.
 */
export function parseContainerExit(output: string): number | null {
    const match = /^(true|false)\s+(-?\d+)/.exec(output.trim())
    if (!match || match[1] === 'true') return null
    return Number(match[2])
}

async function waitForContainerHttp(container: string, budget: RuntimeBudget): Promise<void> {
    const deadline = Date.now() + budget.healthMs
    let last = ''
    while (Date.now() < deadline) {
        try {
            await docker(runtimeHealthCommand(container), budget.healthProbeMs)
            return
        } catch (error) {
            last = errorText(error)
        }
        // A throw at module scope kills the isolate immediately, and the health
        // probe then reports only "container is not running" for the whole
        // budget. Detecting the dead container turns that into a fast, specific
        // failure — which matters more now the budget is 90s, and keeps the
        // single-threaded executor free for other work.
        const exit = parseContainerExit(await docker(containerStateCommand(container), 10_000, true))
        if (exit !== null) {
            throw new Error(
                `runtime container exited with code ${exit} before serving a request; ` +
                    'this is usually an exception at module scope in the function entrypoint. ' +
                    'The container output is recorded in the project logs.',
            )
        }
        await sleep(budget.healthPollMs)
    }
    throw new Error(`runtime did not become healthy within ${budget.healthMs}ms: ${last}`)
}

function ident(value: string): string {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error(`unsafe PostgreSQL identifier: ${value}`)
    return `"${value}"`
}

function literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

function swapDatabase(url: string, database: string): string {
    const parsed = new URL(url)
    parsed.pathname = `/${database}`
    return parsed.toString()
}

function postgresUrl(user: string, password: string, host: string, port: number, database: string): string {
    const url = new URL('postgres://placeholder')
    url.username = user
    url.password = password
    url.hostname = host
    url.port = String(port)
    url.pathname = `/${database}`
    return url.toString()
}

function runtimeName(projectId: string, versionId: string): string {
    return `rits-site-${projectId.replace(/-/g, '').slice(0, 12)}-${versionId.replace(/-/g, '').slice(0, 12)}`
}

function runtimeNetworkName(projectId: string): string {
    return `ritsdev-project-${projectId.replace(/-/g, '').slice(0, 20)}`
}

type NetworkPoolOptions = {
    network: string
    seed: string
    pool: string
    childPrefix: number
    bridge: string
    label: string
    internal: boolean
}

async function createNetworkFromPool(options: NetworkPoolOptions): Promise<void> {
    for (const subnet of networkSubnetCandidates(options.pool, options.childPrefix, options.seed)) {
        const args = [
            'network', 'create',
            '--driver', 'bridge',
            '--subnet', subnet,
            '--opt', `com.docker.network.bridge.name=${options.bridge}`,
            '--label', options.label,
        ]
        if (options.internal) args.push('--internal')
        args.push(options.network)
        try {
            await docker(args, 30_000)
            return
        } catch (error) {
            const detail = errorText(error)
            if (/already exists/i.test(detail)) {
                const found = await docker(['network', 'inspect', options.network], 30_000, true)
                if (found) return
            }
            if (/overlap|address pool/i.test(detail)) continue
            throw error
        }
    }
    throw new Error(`no unused Docker subnet remains in ${options.pool}`)
}

function dynamicNetworkPrefix(env: NodeJS.ProcessEnv): number {
    const value = Number(env.DYNAMIC_NETWORK_PREFIX ?? 28)
    if (!Number.isInteger(value) || value < 24 || value > 29) {
        throw new Error('DYNAMIC_NETWORK_PREFIX must be an integer from 24 through 29')
    }
    return value
}

export function networkSubnetCandidates(pool: string, childPrefix: number, seed: string): string[] {
    const [address, prefixText, extra] = pool.split('/')
    const prefix = Number(prefixText)
    if (extra !== undefined || !Number.isInteger(prefix) || prefix < 8 || prefix > 29) {
        throw new Error(`invalid IPv4 network pool: ${pool}`)
    }
    if (!Number.isInteger(childPrefix) || childPrefix < prefix || childPrefix > 29) {
        throw new Error(`invalid child prefix /${childPrefix} for ${pool}`)
    }
    const base = ipv4ToNumber(address)
    const poolSize = 2 ** (32 - prefix)
    if (base % poolSize !== 0) throw new Error(`network pool is not CIDR-aligned: ${pool}`)
    const childSize = 2 ** (32 - childPrefix)
    const count = poolSize / childSize
    if (count > 4096) throw new Error(`network pool has too many candidate subnets: ${pool}`)
    const start = createHash('sha256').update(seed).digest().readUInt32BE(0) % count
    return Array.from({length: count}, (_, offset) => {
        const index = (start + offset) % count
        return `${numberToIpv4(base + index * childSize)}/${childPrefix}`
    })
}

function ipv4ToNumber(address: string): number {
    const octets = address.split('.')
    if (octets.length !== 4) throw new Error(`invalid IPv4 address: ${address}`)
    const values = octets.map(value => Number(value))
    if (values.some((value, index) =>
        !/^(0|[1-9][0-9]{0,2})$/.test(octets[index]) ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 255
    )) throw new Error(`invalid IPv4 address: ${address}`)
    return values.reduce((result, value) => result * 256 + value, 0)
}

function numberToIpv4(value: number): string {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** 32) {
        throw new Error(`invalid IPv4 integer: ${value}`)
    }
    return [
        Math.floor(value / 2 ** 24),
        Math.floor(value / 2 ** 16) % 256,
        Math.floor(value / 2 ** 8) % 256,
        value % 256,
    ].join('.')
}

async function connectNetwork(network: string, container: string, alias: string): Promise<void> {
    try {
        await docker(['network', 'connect', '--alias', alias, network, container], 30_000)
    } catch (error) {
        if (!/already exists|endpoint with name .* exists/i.test(errorText(error))) throw error
    }
}

async function disconnectNetwork(network: string, container: string): Promise<void> {
    try {
        await docker(['network', 'disconnect', '-f', network, container], 30_000)
    } catch (error) {
        if (!/not connected|no such network|not found/i.test(errorText(error))) throw error
    }
}

async function gunzipText(path: string): Promise<string> {
    const {gunzip} = await import('node:zlib')
    const compressed = await readFile(path)
    return await new Promise<string>((resolveText, rejectText) => {
        gunzip(compressed, (error, result) => error ? rejectText(error) : resolveText(result.toString('utf8')))
    })
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const raw = env[key]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}`)
    return value
}

function required(env: NodeJS.ProcessEnv, key: string): string {
    const value = env[key]
    if (!value) throw new Error(`missing required env: ${key}`)
    return value
}

function errorText(error: unknown): string {
    const value = error as {message?: string; stderr?: string; stdout?: string}
    return String(value?.stderr || value?.stdout || value?.message || error).slice(-20_000)
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const executor = new Executor(process.env)
    const shutdown = async () => {
        await executor.close()
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    executor.run().catch(error => {
        console.error(error)
        process.exit(1)
    })
}
