import {getConnInfo} from '@hono/node-server/conninfo'
import type {MiddlewareHandler} from 'hono'
import {isIP} from 'node:net'

declare module 'hono' {
    interface ContextVariableMap {
        clientAddress: string
    }
}

type Ipv4Cidr = {
    network: number
    mask: number
}

export type ClientIpOptions = {
    trustedProxyCidrs: string
    trustedCloudflareProxyCidrs?: string
}

/**
 * Resolve the client address only from forwarding headers supplied by an
 * explicitly trusted proxy hop. Cloudflare's proprietary header has a
 * separate trust list so a LAN reverse proxy can never make it authoritative.
 */
export function clientIp(options: ClientIpOptions): MiddlewareHandler {
    const trustedProxies = parseCidrs(options.trustedProxyCidrs, 'TRUSTED_PROXY_CIDRS')
    const trustedCloudflareProxies = parseCidrs(
        options.trustedCloudflareProxyCidrs ?? '',
        'TRUSTED_CLOUDFLARE_PROXY_CIDRS',
    )

    return async (c, next) => {
        let peerAddress: string | undefined
        try {
            peerAddress = getConnInfo(c).remote.address
        } catch {
            // Hono's in-memory app.request() test adapter has no network peer.
        }
        c.set('clientAddress', resolveClientAddress({
            peerAddress,
            forwardedFor: c.req.header('x-forwarded-for'),
            cloudflareAddress: c.req.header('cf-connecting-ip'),
            trustedProxies,
            trustedCloudflareProxies,
        }))
        await next()
    }
}

export function resolveClientAddress(input: {
    peerAddress?: string
    forwardedFor?: string
    cloudflareAddress?: string
    trustedProxyCidrs?: string
    trustedCloudflareProxyCidrs?: string
    trustedProxies?: Ipv4Cidr[]
    trustedCloudflareProxies?: Ipv4Cidr[]
}): string {
    const peer = normalizeAddress(input.peerAddress)
    if (!peer) return 'unknown'

    const trustedProxies = input.trustedProxies
        ?? parseCidrs(input.trustedProxyCidrs ?? '', 'trustedProxyCidrs')
    if (!contains(trustedProxies, peer)) return peer

    const trustedCloudflareProxies = input.trustedCloudflareProxies
        ?? parseCidrs(input.trustedCloudflareProxyCidrs ?? '', 'trustedCloudflareProxyCidrs')
    const cloudflareAddress = normalizeAddress(input.cloudflareAddress)
    if (cloudflareAddress && contains(trustedCloudflareProxies, peer)) {
        return cloudflareAddress
    }

    const forwarded = (input.forwardedFor ?? '')
        .split(',')
        .map(normalizeAddress)
        .filter((address): address is string => Boolean(address))
    if (!forwarded.length) return peer

    // Walk from the socket toward the original client, discarding only hops
    // covered by the configured trust boundary.
    for (let index = forwarded.length - 1; index >= 0; index -= 1) {
        if (!contains(trustedProxies, forwarded[index])) return forwarded[index]
    }
    return forwarded[0]
}

function parseCidrs(value: string, setting: string): Ipv4Cidr[] {
    if (!value.trim()) return []
    return value.split(',').map(raw => {
        const cidr = raw.trim()
        const match = /^([^/]+)\/(\d{1,2})$/.exec(cidr)
        if (!match) throw new Error(`${setting} contains invalid IPv4 CIDR: ${cidr}`)
        const address = parseIpv4(match[1])
        const prefix = Number(match[2])
        if (address === null || prefix < 0 || prefix > 32) {
            throw new Error(`${setting} contains invalid IPv4 CIDR: ${cidr}`)
        }
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
        return {network: (address & mask) >>> 0, mask}
    })
}

function contains(cidrs: Ipv4Cidr[], address: string): boolean {
    const parsed = parseIpv4(address)
    return parsed !== null && cidrs.some(cidr => ((parsed & cidr.mask) >>> 0) === cidr.network)
}

function normalizeAddress(value?: string): string | null {
    const candidate = value?.trim()
    if (!candidate) return null
    const unwrapped = candidate.startsWith('[') && candidate.endsWith(']')
        ? candidate.slice(1, -1)
        : candidate
    const mapped = unwrapped.toLowerCase().startsWith('::ffff:')
        ? unwrapped.slice(7)
        : unwrapped
    if (parseIpv4(mapped) !== null) return mapped
    if (isIP(mapped) !== 6) return null
    return new URL(`http://[${mapped}]/`).hostname.slice(1, -1)
}

function parseIpv4(value: string): number | null {
    const parts = value.split('.')
    if (parts.length !== 4) return null
    let result = 0
    for (const part of parts) {
        if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
        const octet = Number(part)
        if (octet > 255) return null
        result = ((result << 8) | octet) >>> 0
    }
    return result
}
