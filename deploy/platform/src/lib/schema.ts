import type {Pool, PoolClient} from 'pg'

export const PLATFORM_DB = '_platform'

export async function ensureDatabase(adminPool: Pool): Promise<void> {
    const found = await adminPool.query<{datname: string}>(
        `SELECT datname FROM pg_database WHERE datname = $1`,
        [PLATFORM_DB],
    )
    if (!found.rowCount) await adminPool.query(`CREATE DATABASE "${PLATFORM_DB}"`)
    await restrictControlDatabaseConnect(adminPool)
}

/**
 * PostgreSQL grants CONNECT on every database to PUBLIC by default. Project
 * databases revoke it during provisioning, but the control and maintenance
 * databases did not, so any project runtime role could open `_platform` and
 * read pg_catalog: the full control-plane schema plus every project's database
 * and role names. Table data and DDL were already denied; this closes the
 * remaining reconnaissance surface.
 */
export async function restrictControlDatabaseConnect(adminPool: Pool): Promise<void> {
    const owner = await adminPool.query<{current_user: string}>(`SELECT current_user`)
    const admin = owner.rows[0].current_user
    for (const database of [PLATFORM_DB, 'postgres', 'template1']) {
        const present = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [database])
        if (!present.rowCount) continue
        await adminPool.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`)
        await adminPool.query(`GRANT CONNECT ON DATABASE "${database}" TO "${admin.replace(/"/g, '""')}"`)
    }
}

/**
 * Ordered, append-only. Every migration after the baseline must be written so
 * that running it against a database created from the current baseline is a
 * no-op, because a fresh install gets the final shape from the baseline and
 * then runs the later migrations anyway.
 */
export const MIGRATIONS: Array<{version: number; name: string; apply: (client: PoolClient) => Promise<void>}> = [
    {
        version: 1,
        name: 'sites-v2-audited-baseline',
        apply: async client => {
            await createIdentitySchema(client)
            await createProjectSchema(client)
            await createDeliverySchema(client)
            await createOperationsSchema(client)
        },
    },
    {version: 2, name: 'agent-trial-remediation', apply: applyAgentTrialRemediation},
    {version: 3, name: 'http-probe-results', apply: createProbeSchema},
    {version: 4, name: 'monitoring-and-alerts', apply: createMonitoringSchema},
    {version: 5, name: 'operator-observability', apply: createObservabilitySchema},
    {version: 6, name: 'managed-llm-binding', apply: addManagedLlmBinding},
    {version: 7, name: 'public-site-reviews', apply: addSiteReviews},
    {version: 8, name: 'showcase-tier', apply: addShowcaseTier},
    {version: 9, name: 'superadmin-tier', apply: addSuperadminTier},
    {version: 10, name: 'site-visit-analytics', apply: addSiteVisitAnalytics},
]

/**
 * Schema v2 deliberately uses new table names instead of mutating the
 * Teenybase-era users/instances tables. That keeps the final legacy snapshot
 * recoverable until the operator explicitly runs the retirement procedure.
 */
export async function applySchema(pool: Pool): Promise<void> {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('ritsdev-schema-migrations'))`)
        await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`)
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version     INT PRIMARY KEY,
                name        TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `)
        const applied = new Set<number>(
            (await client.query<{version: number}>(`SELECT version FROM schema_migrations`)).rows.map(r => r.version),
        )
        for (const migration of MIGRATIONS) {
            if (applied.has(migration.version)) continue
            await migration.apply(client)
            await client.query(
                `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
                [migration.version, migration.name],
            )
        }
        await client.query('COMMIT')
    } catch (error) {
        await client.query('ROLLBACK')
        throw error
    } finally {
        client.release()
    }
}

async function createIdentitySchema(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            google_sub      TEXT UNIQUE,
            email           TEXT NOT NULL UNIQUE,
            display_name    TEXT NOT NULL,
            avatar_url      TEXT,
            platform_role   TEXT NOT NULL DEFAULT 'user'
                CONSTRAINT accounts_platform_role_check
                CHECK (platform_role IN ('user', 'operator', 'superadmin')),
            project_quota   INT NOT NULL DEFAULT 3 CHECK (project_quota > 0),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_login_at   TIMESTAMPTZ
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS personal_access_tokens (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            token_hash      TEXT NOT NULL UNIQUE,
            token_last_four TEXT NOT NULL,
            scopes          TEXT[] NOT NULL,
            expires_at      TIMESTAMPTZ,
            last_used_at    TIMESTAMPTZ,
            revoked_at      TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS oauth_clients (
            client_id       TEXT PRIMARY KEY,
            client_name     TEXT NOT NULL,
            redirect_uris   TEXT[] NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS oauth_login_states (
            state_hash      TEXT PRIMARY KEY,
            nonce           TEXT NOT NULL,
            return_to       TEXT NOT NULL,
            expires_at      TIMESTAMPTZ NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
            code_hash       TEXT PRIMARY KEY,
            account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
            redirect_uri    TEXT NOT NULL,
            code_challenge  TEXT NOT NULL,
            scopes          TEXT[] NOT NULL,
            resource        TEXT NOT NULL,
            expires_at      TIMESTAMPTZ NOT NULL,
            consumed_at     TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS oauth_consent_requests (
            request_hash    TEXT PRIMARY KEY,
            account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
            redirect_uri    TEXT NOT NULL,
            code_challenge  TEXT NOT NULL,
            scopes          TEXT[] NOT NULL,
            resource        TEXT NOT NULL,
            state           TEXT,
            expires_at      TIMESTAMPTZ NOT NULL,
            consumed_at     TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
            token_hash      TEXT PRIMARY KEY,
            account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
            scopes          TEXT[] NOT NULL,
            resource        TEXT NOT NULL,
            expires_at      TIMESTAMPTZ NOT NULL,
            revoked_at      TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
}

async function createProjectSchema(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS projects (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            owner_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            slug                TEXT NOT NULL UNIQUE
                CHECK (slug ~ '^[a-z][a-z0-9-]{2,39}$'),
            access_mode         TEXT NOT NULL DEFAULT 'owner'
                CHECK (access_mode IN ('owner', 'network')),
            status              TEXT NOT NULL DEFAULT 'provisioning'
                CHECK (status IN ('provisioning', 'ready', 'failed', 'storage_exceeded', 'deleting', 'deleted')),
            postgres_enabled    BOOLEAN NOT NULL DEFAULT true,
            storage_enabled     BOOLEAN NOT NULL DEFAULT true,
            llm_enabled         BOOLEAN NOT NULL DEFAULT false,
            database_name       TEXT NOT NULL UNIQUE,
            database_bytes_max  BIGINT NOT NULL DEFAULT 536870912,
            object_bytes_max    BIGINT NOT NULL DEFAULT 1610612736,
            llm_rpm_max         INT NOT NULL DEFAULT 60,
            llm_tpm_max         INT NOT NULL DEFAULT 200000,
            runtime_memory_mb   INT NOT NULL DEFAULT 256,
            runtime_cpu         NUMERIC(4,2) NOT NULL DEFAULT 0.25,
            version_limit       INT NOT NULL DEFAULT 5,
            current_version_id  UUID,
            deleted_at          TIMESTAMPTZ,
            purge_after         TIMESTAMPTZ,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id)`)
    await client.query(`
        CREATE TABLE IF NOT EXISTS project_resources (
            project_id          UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            database_runtime_user TEXT,
            database_migration_user TEXT,
            database_secret_enc TEXT,
            storage_bucket      TEXT,
            storage_access_key  TEXT,
            storage_secret_enc  TEXT,
            llm_key_enc         TEXT,
            llm_key_alias       TEXT,
            llm_key_expires_at  TIMESTAMPTZ,
            postgres_bytes      BIGINT NOT NULL DEFAULT 0,
            object_bytes        BIGINT NOT NULL DEFAULT 0,
            measured_at         TIMESTAMPTZ,
            provision_state     TEXT NOT NULL DEFAULT 'pending'
                CONSTRAINT project_resources_provision_state_check
                CHECK (provision_state IN ('pending', 'ready', 'failed')),
            provision_error     TEXT,
            provisioned_at      TIMESTAMPTZ
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS project_secrets (
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name            TEXT NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
            value_enc       TEXT NOT NULL,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id, name)
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS site_login_tickets (
            ticket_hash     TEXT PRIMARY KEY,
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            return_path     TEXT NOT NULL,
            expires_at      TIMESTAMPTZ NOT NULL,
            consumed_at     TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
}

async function createDeliverySchema(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS source_revisions (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            sha256          TEXT NOT NULL,
            archive_path    TEXT NOT NULL,
            size_bytes      BIGINT NOT NULL,
            created_by      UUID NOT NULL REFERENCES accounts(id),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (project_id, sha256)
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS source_uploads (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            created_by      UUID NOT NULL REFERENCES accounts(id),
            expected_sha256 TEXT NOT NULL,
            expected_size   BIGINT NOT NULL,
            next_chunk      INT NOT NULL DEFAULT 0,
            expires_at      TIMESTAMPTZ NOT NULL,
            completed_at    TIMESTAMPTZ,
            last_error      TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS source_upload_chunks (
            upload_id       UUID NOT NULL REFERENCES source_uploads(id) ON DELETE CASCADE,
            chunk_index     INT NOT NULL,
            data            BYTEA NOT NULL,
            sha256          TEXT,
            PRIMARY KEY (upload_id, chunk_index)
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS versions (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source_revision_id UUID NOT NULL REFERENCES source_revisions(id),
            status          TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'building', 'ready', 'failed')),
            manifest        JSONB,
            artifact_path   TEXT,
            artifact_bytes  BIGINT,
            error_message   TEXT,
            created_by      UUID NOT NULL REFERENCES accounts(id),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            finished_at     TIMESTAMPTZ
        )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, created_at DESC)`)
    await client.query(`
        CREATE TABLE IF NOT EXISTS deployments (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version_id      UUID REFERENCES versions(id) ON DELETE SET NULL,
            previous_version_id UUID REFERENCES versions(id) ON DELETE SET NULL,
            created_by      UUID NOT NULL REFERENCES accounts(id),
            status          TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'deploying', 'active', 'failed')),
            error_message   TEXT,
            activated_at    TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`ALTER TABLE deployments ALTER COLUMN version_id DROP NOT NULL`)
    await client.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'deployments_version_id_fkey' AND confdeltype <> 'n'
            ) THEN
                ALTER TABLE deployments DROP CONSTRAINT deployments_version_id_fkey;
                ALTER TABLE deployments ADD CONSTRAINT deployments_version_id_fkey
                    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE SET NULL;
            END IF;
            IF EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'deployments_previous_version_id_fkey' AND confdeltype <> 'n'
            ) THEN
                ALTER TABLE deployments DROP CONSTRAINT deployments_previous_version_id_fkey;
                ALTER TABLE deployments ADD CONSTRAINT deployments_previous_version_id_fkey
                    FOREIGN KEY (previous_version_id) REFERENCES versions(id) ON DELETE SET NULL;
            END IF;
        END $$
    `)
    await client.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'projects_current_version_fk'
            ) THEN
                ALTER TABLE projects
                ADD CONSTRAINT projects_current_version_fk
                FOREIGN KEY (current_version_id) REFERENCES versions(id);
            END IF;
        END $$
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS project_runtime (
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version_id      UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
            state           TEXT NOT NULL DEFAULT 'stopped'
                CHECK (state IN ('stopped', 'starting', 'running', 'failed')),
            endpoint        TEXT,
            proxy_secret_enc TEXT,
            last_seen_at    TIMESTAMPTZ,
            last_started_at TIMESTAMPTZ,
            error_message   TEXT,
            PRIMARY KEY (project_id, version_id)
        )
    `)
    await client.query(`ALTER TABLE project_runtime ADD COLUMN IF NOT EXISTS proxy_secret_enc TEXT`)
}

async function createOperationsSchema(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS jobs (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            kind            TEXT NOT NULL
                CONSTRAINT jobs_kind_check
                CHECK (kind IN ('provision_project', 'build_version', 'deploy_version', 'start_runtime', 'stop_runtime', 'delete_project', 'measure_usage', 'render_version', 'export_database', 'probe_version')),
            project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
            version_id      UUID REFERENCES versions(id) ON DELETE CASCADE,
            deployment_id   UUID REFERENCES deployments(id) ON DELETE CASCADE,
            status          TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
            attempts        INT NOT NULL DEFAULT 0,
            idempotency_key TEXT UNIQUE,
            run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
            locked_at       TIMESTAMPTZ,
            locked_by       TEXT,
            error_message   TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            finished_at     TIMESTAMPTZ
        )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_after, created_at)`)
    await client.query(`
        CREATE TABLE IF NOT EXISTS project_logs (
            id              BIGSERIAL PRIMARY KEY,
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version_id      UUID REFERENCES versions(id) ON DELETE SET NULL,
            source          TEXT NOT NULL,
            level           TEXT NOT NULL DEFAULT 'info',
            message         TEXT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_logs_project ON project_logs(project_id, id DESC)`)
    await client.query(`
        CREATE TABLE IF NOT EXISTS audit_events (
            id              BIGSERIAL PRIMARY KEY,
            account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
            project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
            action          TEXT NOT NULL,
            metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS render_results (
            job_id          UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version_id      UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
            screenshot_path TEXT,
            diagnostics     JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await createDatabaseExportSchema(client)
    await createProbeSchema(client)
    await createMonitoringSchema(client)
}

/**
 * Alert state, its delivery log, and the operational events the backup and
 * restore jobs report into.
 *
 * Alert *rules* deliberately live in code rather than a table: they are typed,
 * reviewed with the code that evaluates them, and unit-testable. Only their
 * thresholds are runtime-configurable.
 */
async function createMonitoringSchema(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS alerts (
            id              BIGSERIAL PRIMARY KEY,
            rule            TEXT NOT NULL,
            -- '' for a host-wide rule; a project slug or service name otherwise.
            subject         TEXT NOT NULL DEFAULT '',
            state           TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'firing', 'resolved')),
            severity        TEXT NOT NULL DEFAULT 'warning'
                CHECK (severity IN ('warning', 'critical')),
            value           DOUBLE PRECISION,
            threshold       DOUBLE PRECISION,
            summary         TEXT NOT NULL DEFAULT '',
            detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
            breach_count    INT NOT NULL DEFAULT 0,
            clear_count     INT NOT NULL DEFAULT 0,
            first_breach_at TIMESTAMPTZ,
            last_eval_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            fired_at        TIMESTAMPTZ,
            resolved_at     TIMESTAMPTZ,
            notified_at     TIMESTAMPTZ,
            notify_attempts INT NOT NULL DEFAULT 0,
            UNIQUE (rule, subject)
        )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts (state, severity)`)
    await client.query(`
        CREATE TABLE IF NOT EXISTS alert_deliveries (
            id              BIGSERIAL PRIMARY KEY,
            transition      TEXT NOT NULL CHECK (transition IN ('firing', 'resolved', 'digest')),
            recipients      TEXT NOT NULL,
            subject         TEXT NOT NULL,
            body            TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
            attempts        INT NOT NULL DEFAULT 0,
            error_message   TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            sent_at         TIMESTAMPTZ
        )
    `)
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_alert_deliveries_pending
         ON alert_deliveries (status, created_at) WHERE status <> 'sent'`,
    )
    await client.query(`
        CREATE TABLE IF NOT EXISTS ops_events (
            id              BIGSERIAL PRIMARY KEY,
            kind            TEXT NOT NULL,
            status          TEXT NOT NULL,
            detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ops_events_kind ON ops_events (kind, created_at DESC)`)

    // Indexes for the aggregate queries the metrics endpoint runs, and for the
    // executor's per-project claim exclusion. Note applySchema runs everything
    // in one transaction under an advisory lock, so CREATE INDEX CONCURRENTLY
    // is not available; at current table sizes these build in milliseconds.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_recent ON jobs (created_at DESC)`)
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_jobs_running_project ON jobs (project_id) WHERE status = 'running'`,
    )
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_jobs_running_kind ON jobs (kind) WHERE status = 'running'`,
    )
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_deployments_status_created ON deployments (status, created_at DESC)`,
    )
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_project_logs_created ON project_logs (created_at DESC)`,
    )
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_versions_finished ON versions (finished_at DESC) WHERE finished_at IS NOT NULL`,
    )
}

async function createProbeSchema(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS probe_results (
            job_id          UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version_id      UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
            request         JSONB NOT NULL,
            response        JSONB,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
}

async function createDatabaseExportSchema(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS database_exports (
            job_id          UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            requested_by    UUID REFERENCES accounts(id) ON DELETE SET NULL,
            include_data    BOOLEAN NOT NULL,
            file_path       TEXT,
            size_bytes      BIGINT,
            sha256          TEXT,
            schema_sql      TEXT,
            error_message   TEXT,
            expires_at      TIMESTAMPTZ NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_database_exports_project ON database_exports(project_id, created_at DESC)`,
    )
}

/**
 * Remediation for the second first-user round. Every statement is written to be
 * a no-op against a database created from the current baseline.
 */
async function applyAgentTrialRemediation(client: PoolClient): Promise<void> {
    // Provisioning state lives on project_resources rather than projects.status
    // so that a failed re-provision cannot mark a healthy live project failed.
    await client.query(
        `ALTER TABLE project_resources ADD COLUMN IF NOT EXISTS provision_state TEXT NOT NULL DEFAULT 'pending'`,
    )
    await client.query(`ALTER TABLE project_resources ADD COLUMN IF NOT EXISTS provision_error TEXT`)
    await client.query(`ALTER TABLE project_resources ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ`)
    await client.query(
        `ALTER TABLE project_resources DROP CONSTRAINT IF EXISTS project_resources_provision_state_check`,
    )
    await client.query(`
        ALTER TABLE project_resources ADD CONSTRAINT project_resources_provision_state_check
        CHECK (provision_state IN ('pending', 'ready', 'failed'))
    `)
    // Existing rows predate the column: derive their state from the project.
    await client.query(`
        UPDATE project_resources r SET provision_state = CASE
            WHEN p.status = 'provisioning' THEN 'pending'
            WHEN p.status = 'failed' THEN 'failed'
            ELSE 'ready'
        END
        FROM projects p WHERE p.id = r.project_id
    `)

    await client.query(`ALTER TABLE source_upload_chunks ADD COLUMN IF NOT EXISTS sha256 TEXT`)
    await client.query(`ALTER TABLE source_uploads ADD COLUMN IF NOT EXISTS last_error TEXT`)

    await client.query(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check`)
    await client.query(`
        ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
            'provision_project', 'build_version', 'deploy_version', 'start_runtime',
            'stop_runtime', 'delete_project', 'measure_usage', 'render_version',
            'export_database', 'probe_version'
        ))
    `)

    await createDatabaseExportSchema(client)
}

/**
 * Only the executor holds a Docker socket, so the control plane cannot read
 * container or host resource use itself. The executor samples both during its
 * regular housekeeping pass and writes the latest reading here, which keeps the
 * operator view a plain read of the control database.
 */
async function createObservabilitySchema(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS runtime_samples (
            project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version_id          UUID NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
            memory_bytes        BIGINT NOT NULL,
            memory_limit_bytes  BIGINT NOT NULL,
            cpu_percent         NUMERIC(7,2) NOT NULL DEFAULT 0,
            sampled_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id, version_id)
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS host_samples (
            worker              TEXT PRIMARY KEY,
            memory_total_bytes  BIGINT NOT NULL,
            memory_free_bytes   BIGINT NOT NULL,
            cpu_count           INT NOT NULL,
            load1               NUMERIC(8,2) NOT NULL DEFAULT 0,
            load5               NUMERIC(8,2) NOT NULL DEFAULT 0,
            load15              NUMERIC(8,2) NOT NULL DEFAULT 0,
            data_total_bytes    BIGINT,
            data_free_bytes     BIGINT,
            sampled_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
}

/**
 * The columns are also declared in the v1 baseline, so a fresh install already
 * has them and every statement here is a no-op. They need their own migration
 * because `createProjectSchema` only ever runs as part of migration 1: on any
 * database that already records version 1 -- which is every deployed one --
 * putting these ALTERs there means they never execute, and the first project
 * created with the binding fails on a missing column.
 *
 * The binding is off by default so existing projects keep exactly the resources
 * they were created with; inference capacity is shared hardware, not
 * per-project storage.
 */
/**
 * One row per review of a site anyone on the network can reach.
 *
 * Append-only history rather than one row per project: a verdict that changed
 * is the interesting thing, and overwriting would lose it. `version_id` is
 * `ON DELETE SET NULL` so that pruning old versions — which happens routinely,
 * at `version_limit` — cannot erase the record that a page was once flagged.
 *
 * The model's answer is stored beside the platform's own, never merged into it.
 * `level` is the verdict, which the model can only ever have raised;
 * `model_level` is what it said; `model_unavailable` records that it said
 * nothing, which is a different fact from it having agreed.
 */
async function addSiteReviews(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS site_reviews (
            id                  BIGSERIAL PRIMARY KEY,
            project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version_id          UUID REFERENCES versions(id) ON DELETE SET NULL,
            host                TEXT NOT NULL DEFAULT '',
            level               TEXT NOT NULL DEFAULT 'review'
                CHECK (level IN ('clean', 'review', 'urgent')),
            signals             JSONB NOT NULL DEFAULT '[]'::jsonb,
            model_level         TEXT CHECK (model_level IN ('clean', 'review', 'urgent')),
            model_reason        TEXT,
            -- Defaults to true: a row written by anything that has not said
            -- otherwise has no model opinion behind it.
            model_unavailable   BOOLEAN NOT NULL DEFAULT true,
            summary             TEXT NOT NULL DEFAULT '',
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_site_reviews_project ON site_reviews (project_id, created_at DESC)`,
    )
    await client.query(
        `CREATE INDEX IF NOT EXISTS idx_site_reviews_flagged ON site_reviews (created_at DESC) WHERE level <> 'clean'`,
    )

    // The kind list is a CHECK constraint, so it cannot be extended with an
    // IF NOT EXISTS; dropping and re-adding is what migration 2 already does
    // for the same constraint, and re-adding an identical constraint on a
    // database that has this migration is a no-op it never reaches anyway.
    await client.query(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check`)
    await client.query(`
        ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
            'provision_project', 'build_version', 'deploy_version', 'start_runtime',
            'stop_runtime', 'delete_project', 'measure_usage', 'render_version',
            'export_database', 'probe_version', 'review_site'
        ))
    `)
}

async function addManagedLlmBinding(client: PoolClient): Promise<void> {
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS llm_enabled BOOLEAN NOT NULL DEFAULT false`)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS llm_rpm_max INT NOT NULL DEFAULT 60`)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS llm_tpm_max INT NOT NULL DEFAULT 200000`)
    await client.query(`ALTER TABLE project_resources ADD COLUMN IF NOT EXISTS llm_key_enc TEXT`)
    await client.query(`ALTER TABLE project_resources ADD COLUMN IF NOT EXISTS llm_key_alias TEXT`)
    await client.query(`ALTER TABLE project_resources ADD COLUMN IF NOT EXISTS llm_key_expires_at TIMESTAMPTZ`)
}

/**
 * The showcase tier: a project its owner has chosen to put in the gallery on
 * the dashboard.
 *
 * `showcase` is a third value on `access_mode` rather than a flag beside it,
 * because the three form a ladder — reachable by nobody but the owner,
 * reachable by the network, reachable by the network and advertised to it —
 * and a separate flag would admit the nonsense state of an owner-only project
 * listed on everyone's home page. Everything that asks "is this reachable from
 * the network" must therefore test `<> 'owner'` rather than `= 'network'`;
 * `isNetworkReachable` in lib/projects.ts is that test, and the CHECK below is
 * what makes the third value legal.
 *
 * Two description columns, deliberately. `showcase_description` is the owner's
 * own words and is the only one the gallery ever reads. `showcase_draft` is a
 * suggestion written by a model that read the project's page — which is a page
 * written by the person who wants it promoted, so the draft is untrusted text
 * that must never reach another user's screen without its owner having chosen
 * it. Keeping them in separate columns is what makes that structural instead
 * of a matter of remembering.
 */
/**
 * Widen the role ladder with `superadmin`, the tier that may write through
 * `/v1/admin`.
 *
 * The constraint is dropped by name and re-added rather than altered in place,
 * which is the same shape `addShowcaseTier` used to widen the access ladder. A
 * database created at v1 named the constraint itself, so the DROP is written
 * `IF EXISTS` and the ADD names it explicitly: after this runs, both a fresh
 * database and a migrated one carry the same constraint under the same name.
 *
 * No row changes. Widening a CHECK cannot invalidate a value already stored,
 * and nobody holds the new role until `PLATFORM_SUPERADMIN_EMAILS` names them.
 */
async function addSuperadminTier(client: PoolClient): Promise<void> {
    await client.query(`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_platform_role_check`)
    await client.query(`
        ALTER TABLE accounts ADD CONSTRAINT accounts_platform_role_check
        CHECK (platform_role IN ('user', 'operator', 'superadmin'))
    `)
}

async function addShowcaseTier(client: PoolClient): Promise<void> {
    await client.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_access_mode_check`)
    await client.query(`
        ALTER TABLE projects ADD CONSTRAINT projects_access_mode_check
        CHECK (access_mode IN ('owner', 'network', 'showcase'))
    `)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS showcase_description TEXT NOT NULL DEFAULT ''`)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS showcase_shot_path TEXT`)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS showcase_shot_source TEXT`)
    await client.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_showcase_shot_source_check`)
    await client.query(`
        ALTER TABLE projects ADD CONSTRAINT projects_showcase_shot_source_check
        CHECK (showcase_shot_source IS NULL OR showcase_shot_source IN ('captured', 'uploaded'))
    `)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS showcase_shot_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS showcase_draft TEXT`)
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS showcase_draft_at TIMESTAMPTZ`)
    // Partial: the gallery only ever reads showcase rows, and there are far
    // more projects than there will be listed ones.
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_projects_showcase
        ON projects (showcase_shot_at DESC NULLS LAST) WHERE access_mode = 'showcase'
    `)

    // Same drop-and-re-add as migrations 2 and 7: the kind list is a CHECK
    // constraint and cannot be extended with an IF NOT EXISTS.
    await client.query(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check`)
    await client.query(`
        ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
            'provision_project', 'build_version', 'deploy_version', 'start_runtime',
            'stop_runtime', 'delete_project', 'measure_usage', 'render_version',
            'export_database', 'probe_version', 'review_site', 'capture_showcase'
        ))
    `)
}

/**
 * Per-day visit counts for deployed sites, and the per-day set of visitors
 * behind them.
 *
 * Two tables rather than one because they have different lifetimes, and the
 * difference is the privacy control. `site_visit_days` holds counts and nothing
 * that could be tied to a person, so it is kept for as long as it is useful.
 * `site_visitor_days` holds a pseudonym and is pruned briskly. Both are pruned
 * by the executor's existing housekeeping pass.
 *
 * A note for anyone tempted to relax that: `visitor_hash` is obfuscation with a
 * secret, not anonymisation. It is an HMAC over the visitor's address and user
 * agent, and the address space is small enough to enumerate, so anyone holding
 * the key can reverse it. It is per project, so it cannot be used to follow
 * someone between projects, and it never leaves the database.
 *
 * The volume is bounded by construction: one row per project per day, and one
 * row per project per distinct visitor per day. Neither grows with traffic.
 */
async function addSiteVisitAnalytics(client: PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS site_visit_days (
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            day             DATE NOT NULL,
            views           BIGINT NOT NULL DEFAULT 0,
            api_requests    BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (project_id, day)
        )
    `)
    await client.query(`
        CREATE TABLE IF NOT EXISTS site_visitor_days (
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            day             DATE NOT NULL,
            visitor_hash    BYTEA NOT NULL,
            PRIMARY KEY (project_id, day, visitor_hash)
        )
    `)
    // The pruner deletes on `day` alone, which is not a usable prefix of either
    // primary key, so without these it would sequentially scan both tables on
    // every housekeeping pass.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_site_visitor_days_day ON site_visitor_days (day)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_site_visit_days_day ON site_visit_days (day)`)
}
