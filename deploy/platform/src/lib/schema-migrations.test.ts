import assert from 'node:assert/strict'
import {test} from 'node:test'
import {MIGRATIONS} from './schema'

/**
 * These guard a mistake that git cannot see and TypeScript cannot type.
 *
 * Two branches developed in parallel each appended "the next migration" and
 * both picked the same number. The merge was textually clean, so nothing
 * complained: `applySchema` skips any version already present in
 * `schema_migrations`, so the loser's tables were simply never created, and the
 * failure surfaced much later as a missing relation at runtime. A duplicate
 * version must fail here, in a second, rather than there.
 */
test('migration versions are unique', () => {
    const versions = MIGRATIONS.map(m => m.version)
    const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i)
    assert.deepEqual(duplicates, [], `duplicate migration version(s): ${duplicates.join(', ')}`)
})

test('migration names are unique', () => {
    const names = MIGRATIONS.map(m => m.name)
    assert.equal(new Set(names).size, names.length, 'two migrations share a name')
})

/**
 * The list is applied in array order and each version is recorded as it runs, so
 * an out-of-order or gapped entry would either be skipped on an already-migrated
 * database or applied in the wrong sequence on a fresh one.
 */
test('migration versions are contiguous and ascending from 1', () => {
    assert.deepEqual(
        MIGRATIONS.map(m => m.version),
        MIGRATIONS.map((_, index) => index + 1),
    )
})

/**
 * The list is append-only, and this is the only thing that can say so.
 *
 * Every deployed database records which versions it has applied and never runs
 * them again, so renumbering or repurposing an existing entry changes nothing
 * on any host that has already migrated while changing everything on a fresh
 * one. The two would then diverge silently. Pinning the shipped names means a
 * change to one of them fails here rather than months later on a rebuild.
 */
test('shipped migrations keep their number and their name', () => {
    const shipped = [
        [1, 'sites-v2-audited-baseline'],
        [2, 'agent-trial-remediation'],
        [3, 'http-probe-results'],
        [4, 'monitoring-and-alerts'],
        [5, 'operator-observability'],
        [6, 'managed-llm-binding'],
        [7, 'public-site-reviews'],
        [8, 'showcase-tier'],
        [9, 'superadmin-tier'],
        [10, 'site-visit-analytics'],
    ]
    assert.deepEqual(MIGRATIONS.slice(0, shipped.length).map(m => [m.version, m.name]), shipped)
    assert.ok(MIGRATIONS.length >= shipped.length, 'migrations are appended, never removed')
})
