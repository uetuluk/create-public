/**
 * Decides what a provisioning run must actually do.
 *
 * provision_project was written as a create-once job: it minted fresh
 * passwords, wrote them over `project_resources`, and was enqueued under a
 * DO NOTHING idempotency key so it could never run twice. That is why
 * PostgreSQL could not be added to a project after creation.
 *
 * Making the job re-runnable means it has to be genuinely idempotent. Rotating
 * the passwords on a re-run would invalidate the credentials already handed to
 * a running runtime container, so existing credentials are reused whenever they
 * are intact and match the deterministic names derived from the project id.
 */

export type ResourceRow = {
    database_runtime_user: string | null
    database_migration_user: string | null
    database_secret_enc: string | null
    storage_bucket: string | null
    storage_access_key: string | null
    storage_secret_enc: string | null
}

export type ExpectedNames = {
    runtimeUser: string
    migrationUser: string
    bucket: string
    storageAccess: string
}

export type ProvisionPlan = {
    provisionPostgres: boolean
    /** Keep the stored passwords instead of minting new ones. */
    reuseDatabaseCredentials: boolean
    provisionStorage: boolean
    reuseStorageCredentials: boolean
    /**
     * True when this run adds a resource the project did not have. The caller
     * uses it to retire a running runtime, which was started without the
     * corresponding environment variables and would never see them otherwise.
     */
    addsResource: boolean
}

export function provisionPlan(
    project: {postgres_enabled: boolean; storage_enabled: boolean},
    resources: ResourceRow | null,
    expected: ExpectedNames,
): ProvisionPlan {
    const reuseDatabaseCredentials = Boolean(
        project.postgres_enabled &&
            resources?.database_secret_enc &&
            resources.database_runtime_user === expected.runtimeUser &&
            resources.database_migration_user === expected.migrationUser,
    )
    const reuseStorageCredentials = Boolean(
        project.storage_enabled &&
            resources?.storage_secret_enc &&
            resources.storage_bucket === expected.bucket &&
            resources.storage_access_key === expected.storageAccess,
    )
    return {
        provisionPostgres: project.postgres_enabled,
        reuseDatabaseCredentials,
        provisionStorage: project.storage_enabled,
        reuseStorageCredentials,
        addsResource:
            (project.postgres_enabled && !resources?.database_secret_enc) ||
            (project.storage_enabled && !resources?.storage_secret_enc),
    }
}
