import {timingSafeEqual} from 'node:crypto'
import {getConnInfo} from '@hono/node-server/conninfo'
import {Hono} from 'hono'
import type {Pool} from 'pg'
import {collect} from '../lib/metrics'
import {Counters} from '../lib/prometheus'

/**
 * The metrics listener.
 *
 * This is a **separate server on a separate port**, not a route on the public
 * app, and that is the actual access control. The Cloudflare tunnel reaches
 * `platform:3000` directly over the public-control network — it does not
 * traverse Caddy — so a path rule in the Caddyfile cannot keep anything off the
 * public internet. Only a port that no ingress names can.
 *
 * The bearer token and peer allowlist below are defence in depth on top of that.
 */

export interface MetricsDeps {
    pool: Pool
    counters: Counters
    token?: string
    allowedCidrs: string[]
    snapshotPath: string
    dataRoot: string
    perProject: boolean
}

function constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
}

/** Matches an IPv4 address against `a.b.c.d/len`, ignoring anything malformed. */
export function withinCidrs(address: string, cidrs: string[]): boolean {
    if (!cidrs.length) return true
    const ip = toIpv4(address)
    if (ip === null) return false
    return cidrs.some(entry => {
        const [network, lengthText] = entry.trim().split('/')
        const base = toIpv4(network)
        const length = Number(lengthText ?? 32)
        if (base === null || !Number.isInteger(length) || length < 0 || length > 32) return false
        if (length === 0) return true
        const mask = length === 32 ? 0xffffffff : (~0 << (32 - length)) >>> 0
        return (ip & mask) >>> 0 === (base & mask) >>> 0
    })
}

function toIpv4(value: string | undefined): number | null {
    if (!value) return null
    // ::ffff:10.0.0.1 — node reports IPv4 peers this way on a dual-stack socket.
    const plain = value.startsWith('::ffff:') ? value.slice(7) : value
    const parts = plain.split('.')
    if (parts.length !== 4) return null
    let result = 0
    for (const part of parts) {
        const octet = Number(part)
        if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
        result = ((result << 8) | octet) >>> 0
    }
    return result
}

export function metricsRoutes(deps: MetricsDeps) {
    const app = new Hono()

    app.get('/metrics', async c => {
        const peer = getConnInfo(c).remote.address ?? ''
        if (!withinCidrs(peer, deps.allowedCidrs)) return c.text('forbidden', 403)
        if (deps.token) {
            const header = c.req.header('authorization') ?? ''
            const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
            if (!supplied || !constantTimeEquals(supplied, deps.token)) {
                return c.text('unauthorized', 401)
            }
        }
        const body = await collect({
            pool: deps.pool,
            counters: deps.counters,
            snapshotPath: deps.snapshotPath,
            dataRoot: deps.dataRoot,
            perProject: deps.perProject,
        })
        return c.body(body, 200, {'content-type': 'text/plain; version=0.0.4; charset=utf-8'})
    })

    app.get('/healthz', c => c.json({ok: true, service: 'metrics'}))
    return app
}
