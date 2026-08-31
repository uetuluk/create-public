/**
 * Applies the real schema migrations to a scratch database and reports the
 * result. Used as a pre-flight against a copy of the live control database, so
 * a migration that would refuse to apply is found before it stops the platform
 * from starting.
 *
 * Not wired into the server: run the bundled output directly.
 *   node migration-check.js
 * with SCRATCH_DATABASE_URL pointing at the scratch copy.
 */
import {Pool} from 'pg'
import {applySchema} from '../lib/schema'

const url = process.env.SCRATCH_DATABASE_URL
if (!url) throw new Error('SCRATCH_DATABASE_URL is required')

const pool = new Pool({connectionString: url, max: 2})
const started = Date.now()
try {
    await applySchema(pool)
    const versions = await pool.query<{version: number; name: string}>(
        `SELECT version, name FROM schema_migrations ORDER BY version`,
    )
    const checks = await pool.query<{check: string; ok: boolean}>(`
        SELECT 'project_resources.provision_state' AS check, EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='project_resources' AND column_name='provision_state') AS ok
        UNION ALL SELECT 'project_resources.provision_error', EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='project_resources' AND column_name='provision_error')
        UNION ALL SELECT 'source_upload_chunks.sha256', EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='source_upload_chunks' AND column_name='sha256')
        UNION ALL SELECT 'source_uploads.last_error', EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='source_uploads' AND column_name='last_error')
        UNION ALL SELECT 'table database_exports', EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name='database_exports')
        UNION ALL SELECT 'table probe_results', EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_name='probe_results')
        UNION ALL SELECT 'jobs kind allows export_database', EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname='jobs_kind_check' AND pg_get_constraintdef(oid) LIKE '%export_database%')
        UNION ALL SELECT 'jobs kind allows probe_version', EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname='jobs_kind_check' AND pg_get_constraintdef(oid) LIKE '%probe_version%')
        UNION ALL SELECT 'provision_state constraint present', EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname='project_resources_provision_state_check')
    `)
    // Existing rows must have been given a sensible state, not left to a
    // default that would make every live project look unprovisioned.
    const states = await pool.query<{provision_state: string; count: string}>(
        `SELECT provision_state, count(*)::text AS count FROM project_resources GROUP BY 1 ORDER BY 1`,
    )
    console.log(JSON.stringify({
        elapsedMs: Date.now() - started,
        versions: versions.rows,
        checks: checks.rows,
        provisionStates: states.rows,
        allChecksPassed: checks.rows.every(row => row.ok),
    }, null, 2))
    if (!checks.rows.every(row => row.ok)) process.exitCode = 1
} finally {
    await pool.end()
}
