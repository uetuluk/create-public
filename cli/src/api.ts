/**
 * Thin HTTP client around the platform service. All errors are thrown
 * as Error with the server's message embedded for the CLI's wrapAction
 * to render.
 */

export class ApiError extends Error {
    constructor(public status: number, message: string, public body?: unknown) {
        super(message)
    }
}

export async function api<T = unknown>(
    serverUrl: string,
    path: string,
    init: RequestInit & {token?: string} = {},
): Promise<T> {
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    if (init.token) headers.set('authorization', `Bearer ${init.token}`)

    const response = await fetch(`${serverUrl}${path}`, {...init, headers})
    const text = await response.text()
    let body: any = text
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    if (response.ok) return body as T
    throw new ApiError(response.status, formatErrorMessage(body, response.status), body)
}

/**
 * Build the most useful single-line error message from a server response.
 *
 * Tenants and the platform sometimes wrap the *real* problem inside `data`
 * (e.g. `{message: "SQL Error", data: {error: "division by zero"}}`).
 * Prefer the inner detail when present so users see "division by zero",
 * not the generic "SQL Error".
 */
function formatErrorMessage(body: unknown, status: number): string {
    if (!body || typeof body !== 'object') return `HTTP ${status}`
    const b = body as {error?: unknown; message?: unknown; data?: unknown}
    const outer = (typeof b.error === 'string' && b.error) || (typeof b.message === 'string' && b.message) || ''
    const inner = innerDetail(b.data)
    if (outer && inner && inner !== outer) return `${outer}: ${inner}`
    return outer || inner || `HTTP ${status}`
}

function innerDetail(data: unknown): string {
    if (!data || typeof data !== 'object') return ''
    const d = data as {error?: unknown; detail?: unknown; message?: unknown}
    for (const v of [d.error, d.detail, d.message]) {
        if (typeof v === 'string' && v) return v
    }
    return ''
}
