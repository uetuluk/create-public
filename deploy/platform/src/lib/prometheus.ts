/**
 * Prometheus text exposition, hand-rolled.
 *
 * A deliberate limitation, stated here because it is invisible from the output:
 * almost every family below is a **gauge over a trailing window**, computed by
 * querying the control database at scrape time, not a monotonic counter. A
 * scraper cannot `rate()` them. That is the honest price of a self-contained
 * endpoint with no counter store and no ingestion pipeline, and it is what the
 * alert rules consume anyway. The handful of genuinely monotonic values —
 * scrapes served, alerts delivered, deliveries failed — live in `Counters`.
 */

export type MetricType = 'gauge' | 'counter' | 'histogram'

export type Sample = {
    labels?: Record<string, string | number | null | undefined>
    value: number
}

export type Family = {
    name: string
    help: string
    type: MetricType
    samples: Sample[]
}

/** A histogram expressed as its bucket bounds and the observations in each. */
export type Histogram = {
    name: string
    help: string
    /** Upper bounds, ascending. `+Inf` is added automatically. */
    bounds: number[]
    series: Array<{
        labels?: Record<string, string | number | null | undefined>
        /** Counts per bound, same length as `bounds`, plus one for `+Inf`. */
        counts: number[]
        sum: number
    }>
}

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/

export function escapeLabelValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function renderLabels(labels: Sample['labels']): string {
    if (!labels) return ''
    const parts = Object.entries(labels)
        // A null or undefined label is omitted rather than rendered as the
        // string "null", which would create a distinct and meaningless series.
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => {
            if (!NAME_PATTERN.test(key)) throw new Error(`invalid label name: ${key}`)
            return `${key}="${escapeLabelValue(String(value))}"`
        })
    return parts.length ? `{${parts.join(',')}}` : ''
}

function renderValue(value: number): string {
    if (Number.isNaN(value)) return 'NaN'
    if (value === Infinity) return '+Inf'
    if (value === -Infinity) return '-Inf'
    return String(value)
}

export function renderFamily(family: Family): string {
    if (!NAME_PATTERN.test(family.name)) throw new Error(`invalid metric name: ${family.name}`)
    const lines = [`# HELP ${family.name} ${family.help.replace(/\n/g, ' ')}`, `# TYPE ${family.name} ${family.type}`]
    for (const sample of family.samples) {
        lines.push(`${family.name}${renderLabels(sample.labels)} ${renderValue(sample.value)}`)
    }
    return lines.join('\n')
}

export function renderHistogram(histogram: Histogram): string {
    if (!NAME_PATTERN.test(histogram.name)) throw new Error(`invalid metric name: ${histogram.name}`)
    if (!histogram.bounds.length) throw new Error(`${histogram.name} needs at least one bucket bound`)
    for (let i = 1; i < histogram.bounds.length; i++) {
        if (histogram.bounds[i] <= histogram.bounds[i - 1]) {
            throw new Error(`${histogram.name} bucket bounds must ascend strictly`)
        }
    }
    const lines = [
        `# HELP ${histogram.name} ${histogram.help.replace(/\n/g, ' ')}`,
        `# TYPE ${histogram.name} histogram`,
    ]
    for (const series of histogram.series) {
        // Prometheus buckets are cumulative; the collectors produce per-bucket
        // counts, so the running total is built here.
        let cumulative = 0
        histogram.bounds.forEach((bound, index) => {
            cumulative += series.counts[index] ?? 0
            lines.push(`${histogram.name}_bucket${renderLabels({...series.labels, le: bound})} ${cumulative}`)
        })
        cumulative += series.counts[histogram.bounds.length] ?? 0
        lines.push(`${histogram.name}_bucket${renderLabels({...series.labels, le: '+Inf'})} ${cumulative}`)
        lines.push(`${histogram.name}_sum${renderLabels(series.labels)} ${renderValue(series.sum)}`)
        lines.push(`${histogram.name}_count${renderLabels(series.labels)} ${cumulative}`)
    }
    return lines.join('\n')
}

export function render(parts: Array<Family | Histogram>): string {
    const rendered = parts.map(part =>
        'bounds' in part ? renderHistogram(part as Histogram) : renderFamily(part as Family))
    return `${rendered.join('\n')}\n`
}

/** The few values that really are monotonic within one process lifetime. */
export class Counters {
    private readonly values = new Map<string, number>()

    increment(name: string, by = 1): void {
        this.values.set(name, (this.values.get(name) ?? 0) + by)
    }

    set(name: string, value: number): void {
        this.values.set(name, value)
    }

    get(name: string): number {
        return this.values.get(name) ?? 0
    }

    snapshot(): Record<string, number> {
        return Object.fromEntries([...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)))
    }
}

/**
 * Turns a list of numeric observations into per-bucket counts plus a sum.
 * Observations above the last bound land in the implicit `+Inf` bucket.
 */
export function bucketize(values: number[], bounds: number[]): {counts: number[]; sum: number} {
    const counts = new Array(bounds.length + 1).fill(0)
    let sum = 0
    for (const value of values) {
        if (!Number.isFinite(value)) continue
        sum += value
        const index = bounds.findIndex(bound => value <= bound)
        counts[index === -1 ? bounds.length : index] += 1
    }
    return {counts, sum}
}
