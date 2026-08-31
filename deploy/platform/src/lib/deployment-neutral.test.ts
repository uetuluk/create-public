import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'

/**
 * The test that keeps this project deployable by anyone.
 *
 * Every name below was, at some point, written into source that other people
 * are meant to run: a domain in a site address, an email domain in a login
 * gate, a city in a timezone constant, a home directory in a cleanup script.
 * None of them announced themselves — the platform started, served pages, and
 * answered about an installation that was not the one running it.
 *
 * Enumeration is `git ls-files`, not a directory walk: the working tree also
 * holds build output and a vendored fork that are not part of what is
 * published, and a walk would fail on files nobody ships.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')

const tracked = execFileSync('git', ['ls-files', '-z'], {cwd: repoRoot, encoding: 'utf8'})
    .split('\0')
    .filter(Boolean)

/**
 * `LICENSE` is the GNU AGPL text, verbatim and unmodifiable; it happens to
 * contain neither of these, but it is excluded on principle rather than by
 * luck. This file names them all by definition.
 */
const EXEMPT = new Set(['LICENSE', 'deploy/platform/src/lib/deployment-neutral.test.ts'])

/** Reads as text; anything else is skipped rather than decoded. */
const TEXTUAL = /\.(ts|js|mjs|cjs|json|md|ya?ml|sh|conf|html|css|svg|example|txt)$|(^|\/)(Caddyfile|Dockerfile|\.env\.example)$/

const FORBIDDEN: Array<{pattern: RegExp; what: string}> = [
    {pattern: /create\.ritsdev\.top/i, what: 'one installation\'s domain'},
    {pattern: /\bnyu\b|new york university/i, what: 'one installation\'s institution'},
    {pattern: /shanghai/i, what: 'one installation\'s city'},
    {pattern: /\buet200\b/i, what: 'a personal account name'},
    {pattern: /\b10\.(214|209)\.\d+\.\d+\b/, what: 'a real LAN address'},
    {pattern: /ai-infra-committee/i, what: 'one installation\'s host name'},
    {pattern: /ask-llm\.ritsdev\.top/i, what: 'one installation\'s LLM endpoint'},
]

test('nothing published names one particular installation', () => {
    const offences: string[] = []
    for (const rel of tracked) {
        if (EXEMPT.has(rel) || !TEXTUAL.test(rel)) continue
        let text: string
        try {
            text = readFileSync(join(repoRoot, rel), 'utf8')
        } catch {
            continue // deleted in the working tree, or unreadable as text
        }
        for (const {pattern, what} of FORBIDDEN) {
            const line = text.split('\n').findIndex(l => pattern.test(l))
            if (line >= 0) offences.push(`${rel}:${line + 1} names ${what}`)
        }
    }
    assert.deepEqual(offences, [], `deployment-specific names are still published:\n${offences.join('\n')}`)
})

// A guard whose patterns no longer match anything real is worse than no guard,
// because it reports success either way.
test('the guard is actually capable of failing', () => {
    assert.ok(tracked.length > 50, 'git ls-files should list the repository')
    assert.ok(
        FORBIDDEN.some(({pattern}) => pattern.test('https://create.ritsdev.top/mcp')),
        'the patterns should still match the thing they were written for',
    )
})
