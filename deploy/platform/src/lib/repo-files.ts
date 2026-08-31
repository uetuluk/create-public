import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs'
import {extname, resolve, sep} from 'node:path'

/**
 * Reads a file from an explicitly mounted, read-only repository root.
 *
 * Two boundaries, deliberately: the resolved path must stay under the root,
 * and the realpath must too, so a symlink planted inside the mount cannot
 * point out of it. Callers pass the narrowest root they can — the public
 * skills route roots at `<repo>/skills` rather than `<repo>` because the
 * repository mount can also contain ignored operator files.
 *
 * Extracted from routes/static.ts so the MCP resource surface reuses exactly
 * this check rather than growing a second, unaudited path resolver.
 */

const TEXT_TYPES: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
}

export type RepoFile = {body: Buffer; type: string}

export function readRepoFile(root: string, rel: string): RepoFile | null {
    const absRoot = resolve(root)
    const abs = resolve(absRoot, rel)
    if (!abs.startsWith(absRoot + sep)) return null
    if (!existsSync(abs)) return null
    let realRoot: string
    let real: string
    try {
        realRoot = realpathSync(absRoot)
        real = realpathSync(abs)
    } catch {
        return null
    }
    if (!real.startsWith(realRoot + sep)) return null
    const st = statSync(real)
    if (!st.isFile()) return null
    return {body: readFileSync(real), type: TEXT_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream'}
}
