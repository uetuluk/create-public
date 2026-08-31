import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import test from 'node:test'

/**
 * The metrics endpoint must never be reachable from the internet.
 *
 * The control that achieves that is the *separate listener*, not anything in
 * the Caddyfile: cloudflared connects straight to `platform:3000` over the
 * public-control network (deploy/compose.yaml, the cloudflared service) and
 * never traverses Caddy, so a path rule there cannot keep a route private.
 * These are mechanical guards against a future edit that would move the route
 * onto the public app.
 */

const serverSource = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8')

test('the public app never mounts a metrics route', () => {
    const publicMounts = serverSource
        .split('\n')
        .filter(line => /^\s*app\.(route|get|use|all)\(\s*['"`]\/metrics/.test(line))
    assert.deepEqual(publicMounts, [], 'metrics must stay on its own listener, not on the public app')
})

test('the metrics listener is a second serve() with its own port', () => {
    assert.match(serverSource, /metricsRoutes\(/)
    assert.match(serverSource, /METRICS_PORT/)
    // Bound to its own port rather than sharing the public one.
    assert.doesNotMatch(serverSource, /metricsRoutes\([^)]*\)\.fetch,\s*port,/)
})

test('the listener refuses to start unauthenticated unless that is explicit', () => {
    assert.match(serverSource, /METRICS_TOKEN/)
    assert.match(serverSource, /ALLOW_UNAUTHENTICATED_METRICS/)
})

test('the Caddyfile also denies /metrics, as defence in depth', () => {
    // Not the control — see the module comment — but it closes the LAN path
    // through Caddy and documents the intent next to the other ingress rules.
    const caddyfile = readFileSync(join(import.meta.dirname, '..', '..', '..', 'Caddyfile'), 'utf8')
    assert.match(caddyfile, /respond\s+\/metrics\*\s+404/)
})

/**
 * Caddy expands `{$VAR}` before parsing, which is the only reason a variable
 * can appear in a site address at all. The failure when it is not passed is
 * quiet: the config still parses, into a server that matches no host.
 */
test('the Caddyfile names no single installation, and compose passes what it names', () => {
    const caddyfile = readFileSync(join(import.meta.dirname, '..', '..', '..', 'Caddyfile'), 'utf8')
    const compose = readFileSync(join(import.meta.dirname, '..', '..', '..', 'compose.yaml'), 'utf8')

    assert.doesNotMatch(caddyfile, /create\.ritsdev\.top/, 'the Caddyfile should not name one deployment')
    assert.match(caddyfile, /^\{\$GATEWAY_DOMAIN\} \{/m, 'the apex site address should be substituted')
    assert.match(caddyfile, /^\*\.\{\$GATEWAY_DOMAIN\} \{/m, 'the wildcard site address should be substituted')

    // Every {$VAR} the Caddyfile reads has to reach the caddy container.
    // The caddy service block: from its key to the next key at the same
    // indent. `\n  ` alone would match the service's own deeper-indented lines.
    const caddyService = compose.slice(compose.indexOf('\n  caddy:') + 1)
    const nextKey = caddyService.search(/\n {2}(?! )\S/)
    const environment = nextKey < 0 ? caddyService : caddyService.slice(0, nextKey)
    for (const name of new Set([...caddyfile.matchAll(/\{\$([A-Z_]+)\}/g)].map(m => m[1]))) {
        assert.ok(
            environment.includes(`${name}:`),
            `the Caddyfile reads {$${name}} but the caddy service does not pass it, `
            + 'so it would expand to nothing',
        )
    }
})
