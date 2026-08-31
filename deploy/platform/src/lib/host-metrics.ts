import {statfs} from 'node:fs/promises'
import {readFile} from 'node:fs/promises'

/**
 * Host-level signals the control plane can read directly.
 *
 * `/proc/meminfo` and `/proc/pressure/*` are not namespaced, so a container
 * reading them sees the host's numbers — which is what the disk and memory
 * alerts need. `statfs` on the data mount reports the real backing filesystem
 * for the same reason.
 */

export type DiskUsage = {freeBytes: number; totalBytes: number}

export async function diskUsage(path: string): Promise<DiskUsage | null> {
    try {
        const stats = await statfs(path)
        // bsize is the block size the counts are expressed in.
        return {freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize)}
    } catch {
        return null
    }
}

export type MemInfo = {
    availableBytes: number | null
    totalBytes: number | null
    swapTotalBytes: number | null
    swapUsedBytes: number | null
}

/** Parses /proc/meminfo. Values there are in kB despite the `kB` suffix. */
export function parseMemInfo(text: string): MemInfo {
    const values = new Map<string, number>()
    for (const line of text.split('\n')) {
        const match = /^(\w+):\s+(\d+)(?:\s+kB)?$/.exec(line.trim())
        if (match) values.set(match[1], Number(match[2]) * 1024)
    }
    const swapTotal = values.get('SwapTotal') ?? null
    const swapFree = values.get('SwapFree') ?? null
    return {
        availableBytes: values.get('MemAvailable') ?? null,
        totalBytes: values.get('MemTotal') ?? null,
        swapTotalBytes: swapTotal,
        // A host with swap disabled reports SwapTotal 0; used is then 0, not NaN.
        swapUsedBytes: swapTotal === null || swapFree === null ? null : swapTotal - swapFree,
    }
}

export async function memInfo(path = '/proc/meminfo'): Promise<MemInfo> {
    try {
        return parseMemInfo(await readFile(path, 'utf8'))
    } catch {
        return {availableBytes: null, totalBytes: null, swapTotalBytes: null, swapUsedBytes: null}
    }
}

/**
 * Pressure Stall Information: the fraction of the last 60 seconds in which work
 * was stalled waiting for a resource. This is the right signal for "sustained
 * pressure" — far better than free-memory thresholds, which look alarming on a
 * healthy host that is simply using its page cache.
 *
 * **No alert rule reads it.** RHEL 9 builds PSI in but leaves it off unless
 * `psi=1` is on the kernel command line, and this host has neither, so
 * /proc/pressure does not exist. The rules that depended on it evaluated never
 * and were replaced; see `memory_available_*` and `swap_in_rate` in
 * alert-rules.ts. This stays because the family is still worth exporting
 * wherever the kernel does supply it.
 */
export function parsePressure(text: string): number | null {
    for (const line of text.split('\n')) {
        if (!line.startsWith('some')) continue
        const match = /avg60=([\d.]+)/.exec(line)
        if (match) return Number(match[1])
    }
    return null
}

export async function pressure(resource: 'memory' | 'io' | 'cpu'): Promise<number | null> {
    try {
        return parsePressure(await readFile(`/proc/pressure/${resource}`, 'utf8'))
    } catch {
        // A kernel without PSI, or a restricted container: omit the family
        // rather than reporting a misleading zero.
        return null
    }
}

/** x86_64 pages are 4 KiB, and /proc/vmstat counts pages, not bytes. */
export const PAGE_BYTES = 4096

/**
 * `pswpin` from /proc/vmstat: pages read back in from swap since boot.
 * Monotonic, and the only counter this file reads — everything else here is an
 * instantaneous level.
 */
export function parseSwapInPages(text: string): number | null {
    for (const line of text.split('\n')) {
        const match = /^pswpin\s+(\d+)$/.exec(line.trim())
        if (match) return Number(match[1])
    }
    return null
}

export async function swapInPages(path = '/proc/vmstat'): Promise<number | null> {
    try {
        return parseSwapInPages(await readFile(path, 'utf8'))
    } catch {
        return null
    }
}

export type SwapInSample = {pages: number; at: number}

/**
 * Bytes per second faulted back in from swap between two samples. Reading from
 * swap is the stall itself rather than a proxy for one, which is what makes it
 * a usable stand-in for memory PSI on a kernel that has none.
 *
 * Null when there is nothing to difference: the first pass after start, two
 * samples from the same instant, or a counter that went backwards, which means
 * the host rebooted between them and not that swap-in was negative.
 */
export function swapInRate(previous: SwapInSample, current: SwapInSample): number | null {
    const seconds = (current.at - previous.at) / 1000
    if (seconds <= 0 || current.pages < previous.pages) return null
    return ((current.pages - previous.pages) * PAGE_BYTES) / seconds
}
