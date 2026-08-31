import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

/**
 * The installation this binary belongs to, or nothing.
 *
 * There is no sensible compiled-in default: a CLI that ships one points every
 * adopter's users at whoever published it. Instead the platform's `/cli`
 * endpoint prepends one line setting this global to the origin that served the
 * download, so a binary is correct for the installation it came from by
 * construction rather than by the user remembering `--server`.
 *
 * Built from source instead of downloaded, this is empty and `--server` or
 * `RITSDEV_SERVER` is required — which is the honest answer, rather than a
 * confident request to somebody else's host.
 */
declare global {
    // eslint-disable-next-line no-var
    var __RITSDEV_DEFAULT_SERVER__: string | undefined
}

export const DEFAULT_SERVER_URL = globalThis.__RITSDEV_DEFAULT_SERVER__ ?? ''
export const CONFIG_DIR = process.env.RITSDEV_CONFIG_DIR || join(homedir(), '.config', 'ritsdev')

export interface Credentials {
    serverUrl: string
    token: string
}

const credentialsPath = () => join(CONFIG_DIR, 'credentials.json')

export function loadCredentials(): Credentials | null {
    const path = credentialsPath()
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf8')) as Credentials } catch { return null }
}

export function saveCredentials(credentials: Credentials): void {
    mkdirSync(CONFIG_DIR, {recursive: true})
    const path = credentialsPath()
    writeFileSync(path, JSON.stringify(credentials, null, 2))
    try { chmodSync(path, 0o600) } catch { /* Windows */ }
}

export function deleteCredentials(): boolean {
    const path = credentialsPath()
    if (!existsSync(path)) return false
    rmSync(path)
    return true
}
