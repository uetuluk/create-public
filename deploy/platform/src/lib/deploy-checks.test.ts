import assert from 'node:assert/strict'
import test from 'node:test'
import {
    assertDeployableMigrations,
    describeMigrationSet,
    detectStrayMigrations,
    installPrefix,
    requiresLockfile,
} from './deploy-checks'
import {siteManifestSchema, type SiteManifest} from './manifest'

function manifest(extra: Record<string, unknown> = {}): SiteManifest {
    return siteManifestSchema.parse({
        schemaVersion: 1,
        build: {command: 'npm run build', output: 'dist'},
        ...extra,
    })
}

test('a version declaring migrations is never activated when they cannot run', () => {
    // The reported failure: provisioning had not finished, so the migration
    // user was NULL, migrations were skipped in silence, the deployment went
    // active, and the app failed with `relation "tasks" does not exist`.
    assert.throws(
        () => assertDeployableMigrations({
            postgresEnabled: true,
            hasDatabaseBlock: true,
            migrationUser: null,
            secretEnc: null,
        }),
        /provisioning has not finished/,
    )
    assert.throws(
        () => assertDeployableMigrations({
            postgresEnabled: true,
            hasDatabaseBlock: true,
            migrationUser: 'mg_abc',
            secretEnc: null,
        }),
        /provisioning has not finished/,
    )
    assert.throws(
        () => assertDeployableMigrations({
            postgresEnabled: false,
            hasDatabaseBlock: true,
            migrationUser: 'mg_abc',
            secretEnc: 'enc',
        }),
        /PostgreSQL disabled/,
    )
})

test('the migration gate applies or skips over every combination', () => {
    assert.equal(
        assertDeployableMigrations({postgresEnabled: true, hasDatabaseBlock: true, migrationUser: 'mg', secretEnc: 'e'}),
        'apply',
    )
    // No database block: nothing to apply, and nothing to complain about,
    // whatever the provisioning state.
    for (const postgresEnabled of [true, false]) {
        for (const migrationUser of ['mg', null]) {
            for (const secretEnc of ['e', null]) {
                assert.equal(
                    assertDeployableMigrations({postgresEnabled, hasDatabaseBlock: false, migrationUser, secretEnc}),
                    'skip',
                )
            }
        }
    }
})

test('an empty migration directory explains why nothing was found', () => {
    const message = describeMigrationSet(['README.md', 'sub'], [])
    assert.match(message, /no \.sql files at its top level/)
    assert.match(message, /not recursive/)
    assert.match(message, /README\.md, sub/)
    assert.match(describeMigrationSet([], []), /it is empty/)
})

test('a case-mismatched migration is named rather than silently ignored', () => {
    const message = describeMigrationSet(['001_init.SQL'], [])
    assert.match(message, /differ only in case: 001_init\.SQL/)
})

test('a found migration set is reported by name and count', () => {
    const message = describeMigrationSet(['001_init.sql', '002_tasks.sql'], ['001_init.sql', '002_tasks.sql'])
    assert.match(message, /found 2 migration file\(s\): 001_init\.sql, 002_tasks\.sql/)
})

test('migrations shipped without a database block are refused at build', () => {
    assert.equal(detectStrayMigrations(['migrations/001_init.sql', 'index.html'], manifest()), 'migrations')
    assert.equal(detectStrayMigrations(['db/migrations/001.sql'], manifest()), 'db/migrations')
    // Declared: not stray.
    assert.equal(
        detectStrayMigrations(
            ['migrations/001_init.sql'],
            manifest({database: {migrations: 'migrations'}, resources: {postgres: true, storage: false}}),
        ),
        null,
    )
    // A migrations folder inside a dependency is not a deployment mistake.
    assert.equal(detectStrayMigrations(['node_modules/pkg/migrations/001.sql'], manifest()), null)
    assert.equal(detectStrayMigrations(['a/b/c/d/migrations/001.sql'], manifest()), null)
    // A migrations directory carrying no SQL is not evidence of anything.
    assert.equal(detectStrayMigrations(['migrations/README.md'], manifest()), null)
})

test('npm ci stays the default and can now be replaced or skipped', () => {
    assert.equal(installPrefix(manifest().build, true), 'npm ci && ')
    assert.equal(installPrefix(manifest().build, false), '')
    assert.equal(
        installPrefix(manifest({build: {command: 'x', output: 'dist', install: false}}).build, true),
        '',
    )
    assert.equal(
        installPrefix(manifest({build: {command: 'x', output: 'dist', install: 'pnpm install'}}).build, true),
        'pnpm install && ',
    )
    assert.equal(installPrefix(undefined, true), '')
})

test('the lockfile is mandatory only while the default install is in force', () => {
    assert.equal(requiresLockfile(manifest().build, true), true)
    assert.equal(requiresLockfile(manifest().build, false), false)
    assert.equal(requiresLockfile(manifest({build: {command: 'x', output: 'd', install: false}}).build, true), false)
    assert.equal(requiresLockfile(manifest({build: {command: 'x', output: 'd', install: 'npm i'}}).build, true), false)
    // A functions-only project with a package.json never installs anything, so
    // demanding a lockfile there was pure friction.
    assert.equal(requiresLockfile(undefined, true), false)
})

test('the manifest accepts only a command string or false for install', () => {
    assert.ok(siteManifestSchema.parse({schemaVersion: 1, build: {command: 'x', output: 'd', install: false}}))
    assert.ok(siteManifestSchema.parse({schemaVersion: 1, build: {command: 'x', output: 'd', install: 'yarn'}}))
    for (const bad of [0, '', true, null]) {
        assert.throws(
            () => siteManifestSchema.parse({schemaVersion: 1, build: {command: 'x', output: 'd', install: bad}}),
            String(bad),
        )
    }
})
