import {HTTPException} from 'hono/http-exception'

/**
 * Validation for the HTTP probe.
 *
 * The probe exists because deployed sites resolve only on the private network,
 * so an author working through MCP had no way to call their own `/api`. The
 * safety property that makes it acceptable is narrow and worth stating: the
 * caller supplies a **path**, never a host. The target host is derived from the
 * project and version the caller already owns, so the tool cannot be turned
 * into a general-purpose fetcher pointed at the control plane, the metadata
 * service, or another tenant.
 */

export const PROBE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type ProbeMethod = typeof PROBE_METHODS[number]

export type ProbeRequest = {
    path: string
    method: ProbeMethod
    headers: Record<string, string>
    body: string | null
}

const MAX_BODY_BYTES = 256 * 1024

/**
 * Headers the caller may not set, because the gateway uses them to decide which
 * site a request belongs to and whether it is trusted.
 */
const RESERVED_HEADERS = new Set([
    'host',
    'x-ritsdev-render-host',
    'x-ritsdev-render-token',
    'x-ritsdev-runtime-token',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'cookie',
    'content-length',
])

export function parseProbeRequest(input: {
    path?: unknown
    method?: unknown
    headers?: unknown
    body?: unknown
}): ProbeRequest {
    const path = typeof input.path === 'string' ? input.path : '/'
    if (!path.startsWith('/')) {
        throw new HTTPException(400, {message: 'path must start with "/"; the host is fixed to the version being probed'})
    }
    if (path.startsWith('//')) {
        // "//evil.example/x" is a scheme-relative URL, not a path.
        throw new HTTPException(400, {message: 'path must not start with "//"'})
    }
    if (path.length > 2_000) throw new HTTPException(400, {message: 'path exceeds 2000 characters'})
    if (/[\r\n\0]/.test(path)) throw new HTTPException(400, {message: 'path contains a control character'})

    const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET'
    if (!(PROBE_METHODS as readonly string[]).includes(method)) {
        throw new HTTPException(400, {message: `method must be one of ${PROBE_METHODS.join(', ')}`})
    }

    const headers: Record<string, string> = {}
    if (input.headers !== undefined && input.headers !== null) {
        if (typeof input.headers !== 'object' || Array.isArray(input.headers)) {
            throw new HTTPException(400, {message: 'headers must be an object'})
        }
        for (const [rawName, rawValue] of Object.entries(input.headers as Record<string, unknown>)) {
            const name = rawName.toLowerCase()
            if (typeof rawValue !== 'string') throw new HTTPException(400, {message: `header ${rawName} must be a string`})
            if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
                throw new HTTPException(400, {message: `invalid header name: ${rawName}`})
            }
            if (RESERVED_HEADERS.has(name)) {
                throw new HTTPException(400, {
                    message: `${rawName} is set by the platform and cannot be overridden; ` +
                        'the probe always targets the version you named',
                })
            }
            if (/[\r\n\0]/.test(rawValue)) throw new HTTPException(400, {message: `header ${rawName} contains a control character`})
            if (rawValue.length > 4_000) throw new HTTPException(400, {message: `header ${rawName} exceeds 4000 characters`})
            headers[name] = rawValue
        }
    }
    if (Object.keys(headers).length > 32) throw new HTTPException(400, {message: 'at most 32 headers are allowed'})

    let body: string | null = null
    if (input.body !== undefined && input.body !== null) {
        if (typeof input.body !== 'string') throw new HTTPException(400, {message: 'body must be a string'})
        if (Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES) {
            throw new HTTPException(400, {message: `body exceeds ${MAX_BODY_BYTES} bytes`})
        }
        if (method === 'GET' || method === 'HEAD') {
            throw new HTTPException(400, {message: `a ${method} request cannot carry a body`})
        }
        body = input.body
    }

    return {path, method: method as ProbeMethod, headers, body}
}
