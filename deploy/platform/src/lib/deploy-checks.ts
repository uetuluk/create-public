import type {SiteManifest} from './manifest'

/**
 * Pure checks the executor runs around build and deploy.
 *
 * They live here rather than inline so each one is testable without a Docker
 * daemon or a database. Every one of them exists because the platform
 * previously failed silently in the corresponding case: a deployment that
 * activated without applying its migrations, a build that discarded the
 * author's generated function, a `migrations/` directory nothing ever looked
 * at.
 */

export type MigrationGateInput = {
    postgresEnabled: boolean
    hasDatabaseBlock: boolean
    migrationUser: string | null
    secretEnc: string | null
}

/**
 * Decides whether a version declaring migrations may be activated.
 *
 * The predecessor was a four-way `&&` guarding the *apply* step, so a project
 * whose provisioning had not finished skipped its migrations without a word and
 * the deployment still reported active. The runtime then failed with
 * `relation "..." does not exist` and nothing in the build log, the deployment
 * status, or the logs pointed at the cause.
 *
 * Returns `'apply'` or `'skip'`, and throws when migrations were declared but
 * cannot run — the caller must not activate in that case.
 */
export function assertDeployableMigrations(input: MigrationGateInput): 'apply' | 'skip' {
    if (!input.hasDatabaseBlock) return 'skip'
    if (!input.postgresEnabled) {
        throw new Error(
            'this version declares database.migrations but the project has PostgreSQL disabled; ' +
                'enable it (POST /v1/projects/<slug>/resources, or the enable_project_resources MCP tool) ' +
                'and deploy again',
        )
    }
    if (!input.migrationUser || !input.secretEnc) {
        throw new Error(
            'database provisioning has not finished for this project, so migrations cannot be applied; ' +
                'check resources.provisionState on the project and deploy again once it reads "ready"',
        )
    }
    return 'apply'
}

/**
 * Human-readable account of what a migration directory actually contains.
 *
 * `.sql` discovery is deliberately non-recursive and case-sensitive, which is
 * easy to trip over; when it finds nothing this explains why rather than
 * quietly applying zero files.
 */
export function describeMigrationSet(entries: readonly string[], sqlFiles: readonly string[]): string {
    if (sqlFiles.length) {
        return `found ${sqlFiles.length} migration file(s): ${sqlFiles.join(', ')}`
    }
    let message =
        'the configured migration directory contains no .sql files at its top level ' +
        '(the search is not recursive and the extension is case-sensitive)'
    const nearMisses = entries.filter(entry => /\.sql$/i.test(entry) && !entry.endsWith('.sql'))
    if (nearMisses.length) message += `; these differ only in case: ${nearMisses.join(', ')}`
    message += entries.length ? `; it contains: ${entries.join(', ')}` : '; it is empty'
    return message
}

/**
 * Finds SQL migrations the manifest never declared.
 *
 * The manifest schema already rejects `database` without `resources.postgres`,
 * but it cannot see the filesystem, so the opposite mistake — shipping a
 * `migrations/` directory and forgetting the `database` block — was completely
 * silent. Returns the offending directory, or null.
 */
export function detectStrayMigrations(relativePaths: readonly string[], manifest: SiteManifest): string | null {
    if (manifest.database) return null
    for (const raw of relativePaths) {
        const path = raw.replace(/^\.\//, '')
        if (!/\.sql$/i.test(path)) continue
        const parts = path.split('/')
        if (parts.some(part => part === 'node_modules' || part === '.git')) continue
        const index = parts.findIndex(part => part.toLowerCase() === 'migrations')
        // Only shallow directories: a `migrations` folder buried inside a
        // dependency or a fixture tree is not a deployment mistake.
        if (index === -1 || index > 2) continue
        return parts.slice(0, index + 1).join('/')
    }
    return null
}

/**
 * The install step that runs before `build.command`.
 *
 * `npm ci` used to be prefixed unconditionally whenever a root package.json
 * existed, with no way to opt out and a mandatory lockfile, which made a
 * project that installs its own way impossible to build.
 */
export function installPrefix(build: SiteManifest['build'], hasPackageJson: boolean): string {
    if (!build) return ''
    if (build.install === false) return ''
    if (typeof build.install === 'string') return `${build.install} && `
    return hasPackageJson ? 'npm ci && ' : ''
}

/**
 * Arguments for the `pg_dump` that produces a project database export.
 *
 * The password is deliberately absent: it travels in PGPASSWORD, because argv
 * is world-readable through `docker inspect` and the process table.
 */
export function pgDumpArgs(input: {
    host: string
    port: number
    user: string
    database: string
    schemaOnly: boolean
    outputPath: string
}): string[] {
    if (!input.outputPath.startsWith('/output/')) {
        throw new Error(`pg_dump output must stay under /output, got ${input.outputPath}`)
    }
    return [
        'pg_dump',
        `--host=${input.host}`,
        `--port=${input.port}`,
        `--username=${input.user}`,
        `--dbname=${input.database}`,
        // The dump is for the author to restore anywhere, not to recreate this
        // platform's role grants, which are managed by provisioning.
        '--no-owner',
        '--no-privileges',
        '--quote-all-identifiers',
        ...(input.schemaOnly ? ['--schema-only'] : []),
        '--format=plain',
        '--compress=6',
        `--file=${input.outputPath}`,
    ]
}

/** Whether a lockfile is mandatory, given the manifest's install choice. */
export function requiresLockfile(build: SiteManifest['build'], hasPackageJson: boolean): boolean {
    return hasPackageJson && Boolean(build) && build!.install === undefined
}
