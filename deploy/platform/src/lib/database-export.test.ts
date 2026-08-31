import assert from 'node:assert/strict'
import test from 'node:test'
import {ALL_SCOPES, DEFAULT_SCOPES, parseScopes, requireScopes, type Principal} from './authn'
import {pgDumpArgs} from './deploy-checks'

function principal(scopes: readonly string[]): Principal {
    return {
        accountId: 'acct',
        email: 'someone@example.edu',
        displayName: 'Someone',
        role: 'user',
        scopes: [...scopes] as Principal['scopes'],
        tokenKind: 'pat',
    }
}

test('database:read exists but is never granted implicitly', () => {
    // An OAuth request without a scope parameter, and a personal token created
    // without an explicit list, both fall back to DEFAULT_SCOPES. If the new
    // scope were in that set it would grant itself to every existing client.
    assert.ok(ALL_SCOPES.includes('database:read'))
    assert.ok(!(DEFAULT_SCOPES as readonly string[]).includes('database:read'))
})

test('a token holding the default scopes cannot export a database', () => {
    assert.throws(() => requireScopes(principal(DEFAULT_SCOPES), 'database:read'), /scope/i)
    assert.doesNotThrow(() => requireScopes(principal(DEFAULT_SCOPES), 'sites:read'))
    assert.doesNotThrow(() => requireScopes(principal([...DEFAULT_SCOPES, 'database:read']), 'database:read'))
})

test('database:read is still requestable by name', () => {
    assert.deepEqual(parseScopes('sites:read database:read'), ['sites:read', 'database:read'])
    assert.deepEqual(parseScopes('nonsense:scope'), [])
})

test('pg_dump never puts the password in argv', () => {
    const args = pgDumpArgs({
        host: 'postgres',
        port: 5432,
        user: 'mg_abc',
        database: 'site_abc',
        schemaOnly: false,
        outputPath: '/output/dump.sql.gz',
    })
    // argv is readable through docker inspect and the process table.
    assert.ok(!args.some(arg => /password/i.test(arg)))
    assert.ok(!args.some(arg => arg.includes('://')), 'no connection URI that could embed credentials')
})

test('the dump is portable rather than tied to this platform’s roles', () => {
    const args = pgDumpArgs({
        host: 'postgres', port: 5432, user: 'mg_abc', database: 'site_abc',
        schemaOnly: false, outputPath: '/output/dump.sql.gz',
    })
    assert.ok(args.includes('--no-owner'))
    assert.ok(args.includes('--no-privileges'))
    assert.ok(args.includes('--quote-all-identifiers'))
    assert.ok(!args.includes('--schema-only'))
})

test('a schema-only export omits every row', () => {
    const args = pgDumpArgs({
        host: 'postgres', port: 5432, user: 'mg_abc', database: 'site_abc',
        schemaOnly: true, outputPath: '/output/dump.sql.gz',
    })
    assert.ok(args.includes('--schema-only'))
})

test('the dump can only be written inside the mounted output directory', () => {
    for (const outputPath of ['/etc/passwd', '/data/dumps/x.sql.gz', '../escape.sql.gz', '/outputx/dump.sql.gz']) {
        assert.throws(() => pgDumpArgs({
            host: 'postgres', port: 5432, user: 'mg_abc', database: 'site_abc',
            schemaOnly: false, outputPath,
        }), /must stay under \/output/, outputPath)
    }
})

test('the export connects directly to PostgreSQL, not through PgBouncer', () => {
    const args = pgDumpArgs({
        host: 'postgres', port: 5432, user: 'mg_abc', database: 'site_abc',
        schemaOnly: false, outputPath: '/output/dump.sql.gz',
    })
    // PgBouncer runs on 6432 and pools by transaction, which breaks pg_dump's
    // consistent snapshot.
    assert.ok(args.includes('--port=5432'))
    assert.ok(!args.some(arg => arg.includes('6432')))
})
