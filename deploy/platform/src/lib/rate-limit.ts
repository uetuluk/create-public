import type {MiddlewareHandler} from 'hono'

type Bucket = {
    count: number
    resetsAt: number
}

const MAX_BUCKETS = 10_000

/**
 * Small fixed-window limiter for the single-node pilot. Caddy/Cloudflare should
 * enforce a second outer limit; this one protects OAuth endpoints even when
 * the control plane is reached directly from the private network.
 */
export function rateLimit(name: string, limit: number, windowMs: number): MiddlewareHandler {
    const buckets = new Map<string, Bucket>()
    let requests = 0

    return async (c, next) => {
        const now = Date.now()
        const key = `${name}:${c.get('clientAddress') ?? 'unknown'}`
        const current = buckets.get(key)
        if (!current && buckets.size >= MAX_BUCKETS) {
            for (const [candidate, value] of buckets) {
                if (value.resetsAt <= now || buckets.size >= MAX_BUCKETS) buckets.delete(candidate)
                if (buckets.size < MAX_BUCKETS) break
            }
        }
        const bucket = !current || current.resetsAt <= now
            ? {count: 0, resetsAt: now + windowMs}
            : current
        bucket.count += 1
        buckets.set(key, bucket)

        c.header('X-RateLimit-Limit', String(limit))
        c.header('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)))
        c.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetsAt / 1000)))
        if (bucket.count > limit) {
            c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetsAt - now) / 1000))))
            return c.json({error: 'rate_limited', message: 'too many requests'}, 429)
        }

        requests += 1
        if (requests % 1_000 === 0) {
            for (const [candidate, value] of buckets) {
                if (value.resetsAt <= now) buckets.delete(candidate)
            }
        }
        await next()
    }
}
