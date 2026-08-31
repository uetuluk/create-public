import {resolve} from 'node:path'
import {withPlatformHost} from '../lib/skill-resources'
import {Hono} from 'hono'
import {HTTPException} from 'hono/http-exception'
import {readRepoFile as serve} from '../lib/repo-files'

/**
 * Serves the explicitly mounted public skills + README under /repo inside the
 * container. The rest of the repository is not mounted. Path traversal is
 * blocked by resolving
 * the requested path against the root and asserting it stays underneath.
 *
 * Mount points (in server.ts):
 *   GET /              → README.md
 *   GET /skills/*      → skills/*  (agent SKILL.md files)
 */

export interface StaticDeps {
    /** Public documentation root inside the container. */
    repoRoot: string
    /** Stamped into the CLI download so it points back here. See the /cli route. */
    publicBaseUrl: string
}

export function staticRoutes(deps: StaticDeps) {
    const app = new Hono()
    const root = resolve(deps.repoRoot)
    const skillsRoot = resolve(root, 'skills')

    app.get('/README.md', c => {
        const readme = serve(root, 'README.md')
        if (!readme) throw new HTTPException(404, {message: 'README.md not found'})
        return c.body(new Uint8Array(readme.body), 200, {'content-type': readme.type})
    })

    // /favicon.ico aliases to favicon.svg — modern browsers prefer SVG
    // when announced via the <link rel> in HTML, but the bare /favicon.ico
    // request still happens for any page that doesn't include such a link
    // (e.g. the bare README served at /). Returning the SVG body with the
    // SVG content-type works in every current browser; the .ico extension
    // is just a path convention.
    const sendFavicon = (c: any) => {
        const f = serve(root, 'favicon.svg')
        if (!f) throw new HTTPException(404, {message: 'favicon not found'})
        return c.body(new Uint8Array(f.body), 200, {
            'content-type': f.type,
            'cache-control': 'public, max-age=86400',
        })
    }
    app.get('/favicon.ico', sendFavicon)
    app.get('/favicon.svg', sendFavicon)

    // Served by the platform rather than only through npm so the client is
    // always in step with the API it talks to. The published npm package drifted
    // three months behind a rewrite, and anyone installing it got a client for
    // the retired system pointed at the current host.
    app.get('/cli', c => {
        const cli = serve(resolve(root, 'cli'), 'ritsdev.cjs')
        if (!cli) {
            throw new HTTPException(503, {
                message: 'the CLI bundle is not present in this deployment; run deploy/scripts/bootstrap.sh',
            })
        }
        // The bundle ships with no compiled-in platform address, because one
        // baked at build time would point every adopter's users at whoever
        // published the binary. Stamping it here instead makes the download
        // correct for the installation that served it, without the user having
        // to know to pass --server.
        //
        // Inserted after the shebang, never before it: a `#!` line is only
        // honoured on the first line of the file.
        const source = Buffer.from(cli.body).toString('utf8')
        const newline = source.indexOf('\n')
        const shebang = source.startsWith('#!') && newline >= 0
        const prelude = `globalThis.__RITSDEV_DEFAULT_SERVER__=${JSON.stringify(deps.publicBaseUrl)};`
        const stamped = shebang
            ? `${source.slice(0, newline + 1)}${prelude}\n${source.slice(newline + 1)}`
            : `${prelude}\n${source}`
        return c.body(stamped, 200, {
            'content-type': 'text/javascript; charset=utf-8',
            'content-disposition': 'attachment; filename="ritsdev"',
            'cache-control': 'no-cache',
        })
    })

    app.get('/skills/*', c => {
        // Keep this route rooted at /skills. The repository mount can also
        // contain ignored operator files, so "inside /repo" is not a
        // sufficient traversal boundary for a public request.
        const rel = c.req.path.slice('/skills/'.length)
        const file = serve(skillsRoot, rel)
        if (!file) throw new HTTPException(404, {message: 'not found'})
        // Text formats name the platform with placeholders; binaries are passed
        // through untouched.
        if (/^text\/|json|yaml/.test(file.type)) {
            return c.body(withPlatformHost(file.body.toString('utf8'), deps.publicBaseUrl), 200,
                {'content-type': file.type})
        }
        return c.body(new Uint8Array(file.body), 200, {'content-type': file.type})
    })

    return app
}
