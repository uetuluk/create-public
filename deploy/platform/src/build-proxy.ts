import {lookup} from 'node:dns/promises'
import {createServer} from 'node:http'
import {connect} from 'node:net'
import {BlockList, isIP} from 'node:net'
import type {Duplex} from 'node:stream'

const denied = new BlockList()
for (const [address, prefix, type] of [
    ['0.0.0.0', 8, 'ipv4'],
    ['10.0.0.0', 8, 'ipv4'],
    ['100.64.0.0', 10, 'ipv4'],
    ['127.0.0.0', 8, 'ipv4'],
    ['169.254.0.0', 16, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.0.0.0', 24, 'ipv4'],
    ['192.0.2.0', 24, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['198.18.0.0', 15, 'ipv4'],
    ['198.51.100.0', 24, 'ipv4'],
    ['203.0.113.0', 24, 'ipv4'],
    ['224.0.0.0', 4, 'ipv4'],
    ['240.0.0.0', 4, 'ipv4'],
    ['::', 128, 'ipv6'],
    ['::1', 128, 'ipv6'],
    ['fc00::', 7, 'ipv6'],
    ['fe80::', 10, 'ipv6'],
    ['ff00::', 8, 'ipv6'],
    ['2001:db8::', 32, 'ipv6'],
] as const) {
    denied.addSubnet(address, prefix, type)
}

export function isPublicAddress(raw: string): boolean {
    let address = raw
    if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7)
    const family = isIP(address)
    return Boolean(family) && !denied.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export async function startBuildProxy(env: NodeJS.ProcessEnv = process.env) {
    const port = Number(env.BUILD_PROXY_PORT ?? 3128)
    const maxConnections = Number(env.BUILD_PROXY_MAX_CONNECTIONS ?? 64)
    let active = 0
    const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/healthz') {
            response.writeHead(200, {'content-type': 'application/json'})
            response.end('{"ok":true,"service":"build-egress-proxy"}')
            return
        }
        response.writeHead(403, {'content-type': 'text/plain'})
        response.end('Only HTTPS CONNECT to public TCP/443 is allowed.\n')
    })

    server.on('connect', (request, clientSocket, head) => {
        void handleConnect(request.url ?? '', clientSocket, head, {
            acquire: () => {
                if (active >= maxConnections) return false
                active += 1
                return true
            },
            release: () => {
                active = Math.max(0, active - 1)
            },
        })
    })

    await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
            server.off('error', reject)
            resolveListen()
        })
    })
    console.log(`[build-proxy] listening on ${port}`)
    return {
        port,
        close: async () => await new Promise<void>((resolveClose, reject) => {
            server.close(error => error ? reject(error) : resolveClose())
        }),
    }
}

async function handleConnect(
    authority: string,
    client: Duplex,
    head: Buffer,
    concurrency: {acquire(): boolean; release(): void},
): Promise<void> {
    if (!concurrency.acquire()) {
        reject(client, 429, 'Too Many Connections')
        return
    }
    let released = false
    const release = () => {
        if (!released) concurrency.release()
        released = true
    }
    client.once('close', release)
    try {
        const target = parseAuthority(authority)
        if (target.port !== 443) throw new Error('only TCP/443 is allowed')
        const addresses = await lookup(target.hostname, {all: true, verbatim: true})
        if (!addresses.length || addresses.some(candidate => !isPublicAddress(candidate.address))) {
            throw new Error('destination does not resolve exclusively to public addresses')
        }
        const candidate = addresses[0]
        const upstream = connect({host: candidate.address, port: 443, family: candidate.family})
        upstream.setTimeout(60_000, () => upstream.destroy(new Error('upstream idle timeout')))
        upstream.once('error', () => client.destroy())
        upstream.once('connect', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) upstream.write(head)
            client.pipe(upstream)
            upstream.pipe(client)
        })
    } catch {
        reject(client, 403, 'Forbidden')
    }
}

function parseAuthority(authority: string): {hostname: string; port: number} {
    const url = new URL(`https://${authority}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid CONNECT authority')
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (!hostname || (!isIP(hostname) && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname))) {
        throw new Error('invalid CONNECT hostname')
    }
    return {hostname, port: Number(url.port || 443)}
}

function reject(socket: Duplex, status: number, message: string): void {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startBuildProxy().catch(error => {
        console.error(error)
        process.exit(1)
    })
}
