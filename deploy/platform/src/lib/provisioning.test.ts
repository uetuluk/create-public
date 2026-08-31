import assert from 'node:assert/strict'
import test from 'node:test'
import {provisionPlan, type ResourceRow} from './provisioning'

const names = {
    runtimeUser: 'rt_abc',
    migrationUser: 'mg_abc',
    bucket: 'site-1111',
    storageAccess: 'r1111',
}

function resources(overrides: Partial<ResourceRow> = {}): ResourceRow {
    return {
        database_runtime_user: null,
        database_migration_user: null,
        database_secret_enc: null,
        storage_bucket: null,
        storage_access_key: null,
        storage_secret_enc: null,
        ...overrides,
    }
}

test('a fresh project provisions everything and mints new credentials', () => {
    const plan = provisionPlan({postgres_enabled: true, storage_enabled: true}, resources(), names)
    assert.deepEqual(plan, {
        provisionPostgres: true,
        reuseDatabaseCredentials: false,
        provisionStorage: true,
        reuseStorageCredentials: false,
        addsResource: true,
    })
})

test('a re-run over intact resources rotates nothing', () => {
    // provision_project is re-runnable now. Rotating the passwords would
    // invalidate the credentials already injected into a live runtime, whose
    // environment is fixed at docker run time.
    const plan = provisionPlan(
        {postgres_enabled: true, storage_enabled: true},
        resources({
            database_runtime_user: names.runtimeUser,
            database_migration_user: names.migrationUser,
            database_secret_enc: 'enc',
            storage_bucket: names.bucket,
            storage_access_key: names.storageAccess,
            storage_secret_enc: 'enc',
        }),
        names,
    )
    assert.equal(plan.reuseDatabaseCredentials, true)
    assert.equal(plan.reuseStorageCredentials, true)
    assert.equal(plan.addsResource, false)
})

test('adding postgres later leaves an existing bucket untouched', () => {
    const plan = provisionPlan(
        {postgres_enabled: true, storage_enabled: true},
        resources({
            storage_bucket: names.bucket,
            storage_access_key: names.storageAccess,
            storage_secret_enc: 'enc',
        }),
        names,
    )
    assert.equal(plan.provisionPostgres, true)
    assert.equal(plan.reuseDatabaseCredentials, false, 'no database credentials exist yet')
    assert.equal(plan.reuseStorageCredentials, true, 'the bucket keeps its existing key')
    assert.equal(plan.addsResource, true, 'the running runtime has no DATABASE_URL and must be retired')
})

test('a half-written resource row is re-provisioned rather than reused', () => {
    // A secret without its user names, or names that do not match the ones
    // derived from the project id, cannot be trusted as a live credential.
    for (const row of [
        resources({database_secret_enc: 'enc'}),
        resources({database_runtime_user: 'rt_other', database_migration_user: names.migrationUser, database_secret_enc: 'enc'}),
        resources({database_runtime_user: names.runtimeUser, database_migration_user: names.migrationUser}),
    ]) {
        assert.equal(
            provisionPlan({postgres_enabled: true, storage_enabled: false}, row, names).reuseDatabaseCredentials,
            false,
        )
    }
})

test('a disabled resource is never provisioned and never counts as added', () => {
    const plan = provisionPlan({postgres_enabled: false, storage_enabled: false}, resources(), names)
    assert.equal(plan.provisionPostgres, false)
    assert.equal(plan.provisionStorage, false)
    assert.equal(plan.addsResource, false)
})

test('a missing resources row is treated as nothing provisioned', () => {
    const plan = provisionPlan({postgres_enabled: true, storage_enabled: false}, null, names)
    assert.equal(plan.provisionPostgres, true)
    assert.equal(plan.reuseDatabaseCredentials, false)
    assert.equal(plan.addsResource, true)
})
