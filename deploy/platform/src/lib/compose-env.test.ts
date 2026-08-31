import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'

/**
 * A variable this repository reads but compose.yaml does not list is simply
 * undefined inside the container.
 *
 * That has happened here more than once, and it never announces itself: the
 * code takes its fallback branch and everything behaves plausibly. The last
 * instance was `SMTP_HELO_NAME`, read by `smtpConfigFromEnv` and enumerated
 * nowhere, so the control plane spent its whole life announcing a HELO nobody
 * chose. Nothing errored, and nothing could have told you.
 *
 * So: every `env.X` reached for under `src/` must appear in compose.yaml, or be
 * listed below with a reason.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')
const compose = readFileSync(join(repoRoot, 'deploy', 'compose.yaml'), 'utf8')

/**
 * Names that are legitimately absent from compose.
 *
 * Each is either set by something other than compose, or read in a context that
 * never runs inside these containers. A name added here needs the reason
 * written down; "the test was failing" is not one.
 */
const EXEMPT = new Set([
    // Node and Docker set these themselves.
    'NODE_ENV', 'PATH', 'HOME', 'HOSTNAME', 'TZ',
    // Set per-exec by the scripts under deploy/platform/scripts, not by compose.
    'RITSDEV_URL', 'RITSDEV_TOKEN', 'RITSDEV_SERVER', 'RITSDEV_DOMAIN', 'RITSDEV_TENANT_HOST',
    'RITSDEV_CONFIG_DIR', 'GATE_EMAIL',
    // Injected by the executor into a tenant runtime, never read by the platform
    // from its own environment.
    'RITSDEV_PROJECT_ID', 'RITSDEV_PROXY_SECRET',
    'DATABASE_URL', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION',
    'LLM_API_KEY',
    // Read by the Playwright script the executor writes out and runs inside the
    // render container, where `process.env` is that container's, not ours.
    'TARGET_HOST', 'TARGET_URL', 'RENDER_TOKEN',
    // A legacy alias for PLATFORM_SESSION_SECRET, still honoured for an
    // installation predating the rename but deliberately not advertised.
    'PLATFORM_JWT_SECRET',
    // tools/migration-check.ts is run by hand against a throwaway database; it
    // is not one of the container services this file configures.
    'SCRATCH_DATABASE_URL',
])

const sourceFiles = execFileSync('git', ['ls-files', '-z', 'deploy/platform/src'], {cwd: repoRoot, encoding: 'utf8'})
    .split('\0')
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

test('every environment variable the platform reads is enumerated in compose.yaml', () => {
    const missing = new Map<string, string>()
    for (const rel of sourceFiles) {
        const text = readFileSync(join(repoRoot, rel), 'utf8')
        // `env.FOO`, `this.env.FOO`, `deps.env.FOO`, `opts.env.FOO`.
        for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) {
            const name = match[1]
            if (EXEMPT.has(name)) continue
            // A compose key (`  FOO:`) or an interpolation (`${FOO...}`).
            if (new RegExp(`(^\\s{2,}${name}:)|(\\$\\{${name}[:}])`, 'm').test(compose)) continue
            if (!missing.has(name)) missing.set(name, rel)
        }
    }
    assert.deepEqual(
        [...missing].map(([name, rel]) => `${name} (read in ${rel})`),
        [],
        'these are read by the platform but never passed to it, so they are always undefined',
    )
})

// Without this the test above passes cheerfully on an empty file list.
test('the guard is actually reading the source', () => {
    assert.ok(sourceFiles.length > 20, `expected the platform sources, found ${sourceFiles.length}`)
    assert.ok(compose.includes('GATEWAY_DOMAIN'), 'expected to have read compose.yaml')
})
