import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {promisify} from 'node:util'
import {cac} from 'cac'
import colors from 'picocolors'
import prompts from 'prompts'
import {api, ApiError} from './api'
import {DEFAULT_SERVER_URL, deleteCredentials, loadCredentials, saveCredentials, type Credentials} from './store'

const execFileP = promisify(execFile)
const cli = cac('ritsdev')

cli.option('--server <url>', DEFAULT_SERVER_URL
    ? `[string] platform URL (default: ${DEFAULT_SERVER_URL})`
    : '[string] platform URL (required: this build has no default)')

function serverUrl(opts: {server?: string}): string {
    const url = (opts.server || process.env.RITSDEV_SERVER || loadCredentials()?.serverUrl || DEFAULT_SERVER_URL)
        .replace(/\/+$/, '')
    if (!url) {
        throw new Error(
            'no platform URL: pass --server https://<your platform>, set RITSDEV_SERVER, or run `ritsdev login`.'
            + ' Downloading the CLI from a platform\'s /cli endpoint bakes its address in for you.',
        )
    }
    return url
}

function credentials(): Credentials {
    const stored = loadCredentials()
    const envToken = process.env.RITSDEV_TOKEN
    if (envToken) return {serverUrl: process.env.RITSDEV_SERVER || DEFAULT_SERVER_URL, token: envToken}
    if (!stored) throw new Error('not authenticated; create a personal token in the dashboard and run `ritsdev login`')
    return stored
}

async function authed<T>(path: string, init: RequestInit = {}, opts: {server?: string} = {}): Promise<T> {
    const auth = credentials()
    return await api<T>(serverUrl(opts) || auth.serverUrl, path, {...init, token: auth.token})
}

function action<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
    return async (...args: T) => {
        try {
            await fn(...args)
        } catch (error) {
            if (error instanceof ApiError) console.error(colors.red(`${error.status} ${error.message}`))
            else console.error(colors.red(error instanceof Error ? error.message : String(error)))
            if (process.env.RITSDEV_DEBUG) console.error(error)
            process.exitCode = 1
        }
    }
}

cli.command('login', 'save a personal access token')
    .option('--token <token>', '[string] token shown once by the dashboard')
    .action(action(async (opts: {server?: string; token?: string}) => {
        const token = opts.token || (await prompts({type: 'password', name: 'value', message: 'personal token:'})).value
        if (!token?.startsWith('rits_')) throw new Error('expected a rits_ personal token')
        const url = serverUrl(opts)
        const me = await api<{email: string; name: string}>(url, '/v1/me', {token})
        saveCredentials({serverUrl: url, token})
        console.log(colors.green(`authenticated as ${me.name} <${me.email}>`))
    }))

cli.command('logout', 'remove the saved token').action(action(async () => {
    console.log(deleteCredentials() ? 'logged out' : 'not logged in')
}))

cli.command('whoami', 'show the authenticated user').action(action(async (opts: {server?: string}) => {
    const me = await authed<{email: string; name: string; role: string; scopes: string[]}>('/v1/me', {}, opts)
    console.log(`${colors.bold(me.name)} <${me.email}>`)
    console.log(`role: ${me.role} · scopes: ${me.scopes.join(', ')}`)
}))

cli.command('create <slug>', 'create a project with its own PostgreSQL database and object bucket')
    .option('--access <mode>', '[string] owner or network (default: owner); showcase is set later, with `access`, once a version is deployed')
    .option('--no-postgres', '[boolean] do not provision PostgreSQL')
    .option('--no-storage', '[boolean] do not provision object storage')
    .option('--llm', '[boolean] provision a managed LLM key (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL)')
    .action(action(async (slug: string, opts: {server?: string; access?: 'owner' | 'network'; postgres?: boolean; storage?: boolean; llm?: boolean}) => {
        const project = await authed<Project>('/v1/projects', {
            method: 'POST',
            body: JSON.stringify({
                slug,
                access: opts.access ?? 'owner',
                postgres: opts.postgres !== false,
                storage: opts.storage !== false,
                // Opt-in, unlike the other two: inference is shared hardware.
                llm: opts.llm === true,
            }),
        }, opts)
        printProject(project)
    }))

cli.command('list', 'list your projects').action(action(async (opts: {server?: string}) => {
    const {projects} = await authed<{projects: Project[]}>('/v1/projects', {}, opts)
    if (!projects.length) return console.log('no projects')
    projects.forEach(project => printProject(project))
}))

cli.command('status <slug>', 'show project status, quotas, and usage').action(action(async (slug: string, opts: {server?: string}) => {
    printProject(await authed<Project>(`/v1/projects/${encodeURIComponent(slug)}`, {}, opts), true)
}))

cli.command('access <slug> <mode>', 'set visitor access to owner, network, or showcase')
    .action(action(async (slug: string, mode: AccessMode, opts: {server?: string}) => {
        if (!ACCESS_MODES.includes(mode)) {
            throw new Error(`mode must be one of ${ACCESS_MODES.join(', ')}`)
        }
        const project = await authed<Project>(`/v1/projects/${encodeURIComponent(slug)}/access`, {
            method: 'PATCH',
            body: JSON.stringify({access: mode}),
        }, opts)
        console.log(colors.green(`${project.slug} access is now ${project.access}`))
        if (project.access === 'showcase') {
            console.log(colors.dim('  listed in the gallery on the dashboard, with a screenshot taken shortly'))
        }
    }))

cli.command('describe <slug> <description>', 'set the line shown under this project in the gallery')
    .action(action(async (slug: string, description: string, opts: {server?: string}) => {
        const project = await authed<Project>(`/v1/projects/${encodeURIComponent(slug)}/showcase`, {
            method: 'PUT',
            body: JSON.stringify({description}),
        }, opts)
        console.log(colors.green(`${project.slug}: ${project.showcase.description}`))
    }))

cli.command('showcase', 'list the projects other people have shared')
    .action(action(async (opts: {server?: string}) => {
        const {projects} = await authed<{projects: ShowcaseEntry[]}>('/v1/showcase', {}, opts)
        if (!projects.length) return console.log('nothing shared yet')
        for (const entry of projects) {
            console.log(`${colors.bold(entry.slug)} ${colors.dim(`by ${entry.ownerName}`)}`)
            console.log(`  ${entry.description}`)
            console.log(`  ${entry.url}`)
        }
    }))

cli.command('resources <slug>', 'add postgres, storage, or the LLM binding to an existing project')
    .option('--postgres', 'add a PostgreSQL database')
    .option('--storage', 'add an object storage bucket')
    .option('--llm', 'add a managed LLM key (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL)')
    .action(action(async (slug: string, opts: {postgres?: boolean; storage?: boolean; llm?: boolean; server?: string}) => {
        if (!opts.postgres && !opts.storage && !opts.llm) throw new Error('pass --postgres, --storage, --llm, or any combination')
        const project = await authed<Project>(`/v1/projects/${encodeURIComponent(slug)}/resources`, {
            method: 'POST',
            body: JSON.stringify({postgres: opts.postgres, storage: opts.storage, llm: opts.llm}),
        }, opts)
        console.log(colors.green(`${project.slug} resources: postgres=${project.resources?.postgres} storage=${project.resources?.storage} llm=${project.resources?.llm}`))
        console.log(colors.dim(`provisioning is asynchronous; wait for "ready" with \`ritsdev status ${slug}\``))
        console.log(colors.dim('then rebuild and redeploy so the runtime picks up the new environment'))
        // The build refuses a manifest asking for a resource the project lacks,
        // so adding the binding is only half of it.
        if (opts.llm) console.log(colors.dim('set "resources": {"llm": true} in ritsdev.site.json before rebuilding'))
    }))

cli.command('secrets <slug> [...values]', 'set NAME=value or delete NAME- runtime secrets')
    .action(action(async (slug: string, values: string[], opts: {server?: string}) => {
        const secrets: Record<string, string | null> = {}
        for (const item of values) {
            const split = item.indexOf('=')
            if (split >= 1) {
                secrets[item.slice(0, split)] = item.slice(split + 1)
            } else if (item.endsWith('-') && item.length > 1) {
                secrets[item.slice(0, -1)] = null
            } else {
                throw new Error(`invalid secret ${item}; expected NAME=value or NAME-`)
            }
        }
        const result = await authed<{updated: string[]; deleted: string[]}>(`/v1/projects/${encodeURIComponent(slug)}/secrets`, {
            method: 'PUT',
            body: JSON.stringify({secrets}),
        }, opts)
        if (result.updated.length) console.log(colors.green(`updated ${result.updated.join(', ')}`))
        if (result.deleted.length) console.log(colors.yellow(`deleted ${result.deleted.join(', ')}`))
    }))

cli.command('push <slug> [directory]', 'upload source and create a build version')
    .option('--wait', '[boolean] wait for the build result')
    .action(action(async (slug: string, directory: string | undefined, opts: {server?: string; wait?: boolean}) => {
        const version = await pushVersion(slug, directory ?? '.', opts)
        printVersion(version)
        if (opts.wait) printVersion(await waitVersion(slug, version.id, opts))
    }))

cli.command('deploy <slug> [directory]', 'upload, build, and deploy a project')
    .action(action(async (slug: string, directory: string | undefined, opts: {server?: string}) => {
        const created = await pushVersion(slug, directory ?? '.', opts)
        console.log(`building ${created.id}…`)
        const version = await waitVersion(slug, created.id, opts)
        if (version.status !== 'ready') throw new Error(version.error || 'build failed')
        const deployment = await authed<Deployment>(`/v1/projects/${encodeURIComponent(slug)}/deployments`, {
            method: 'POST',
            headers: {'idempotency-key': `cli-deploy-${version.id}`},
            body: JSON.stringify({versionId: version.id}),
        }, opts)
        console.log(`deployment queued: ${deployment.id}`)
        const activated = await waitDeployment(slug, deployment.id, opts)
        if (activated.status !== 'active') throw new Error(activated.error || 'deployment failed')
        console.log(colors.green(`deployed: ${activated.url}`))
    }))

cli.command('versions <slug>', 'list project versions').action(action(async (slug: string, opts: {server?: string}) => {
    const {versions} = await authed<{versions: Version[]}>(`/v1/projects/${encodeURIComponent(slug)}/versions`, {}, opts)
    versions.forEach(printVersion)
}))

cli.command('deploy-version <slug> <version>', 'deploy or roll back to an existing ready version')
    .action(action(async (slug: string, version: string, opts: {server?: string}) => {
        const result = await authed<Deployment>(`/v1/projects/${encodeURIComponent(slug)}/deployments`, {
            method: 'POST',
            headers: {'idempotency-key': `cli-deploy-${version}`},
            body: JSON.stringify({versionId: version}),
        }, opts)
        console.log(`deployment queued: ${result.id}`)
        const activated = await waitDeployment(slug, result.id, opts)
        if (activated.status !== 'active') throw new Error(activated.error || 'deployment failed')
        console.log(colors.green(`deployed: ${activated.url}`))
    }))

cli.command('logs <slug>', 'show recent project logs')
    .option('--limit <count>', '[number] maximum records (default: 200)')
    .action(action(async (slug: string, opts: {server?: string; limit?: string}) => {
        const {logs} = await authed<{logs: Array<{createdAt: string; source: string; level: string; message: string}>}>(
            `/v1/projects/${encodeURIComponent(slug)}/logs?limit=${encodeURIComponent(opts.limit ?? '200')}`, {}, opts,
        )
        for (const log of logs) {
            const level = log.level === 'error' ? colors.red(log.level) : colors.dim(log.level)
            console.log(`${colors.dim(log.createdAt)} ${level} ${colors.cyan(log.source)} ${log.message}`)
        }
    }))

cli.command('stats <slug>', 'show how many people have visited a deployed site')
    .option('--days <count>', '[number] window in days, 1-30 (default: 30)')
    .action(action(async (slug: string, opts: {server?: string; days?: string}) => {
        const query = opts.days ? `?days=${encodeURIComponent(opts.days)}` : ''
        const stats = await authed<{
            days: number
            views: number
            apiRequests: number
            visitors: number
            daily: Array<{day: string; views: number; apiRequests: number; visitors: number}>
        }>(`/v1/projects/${encodeURIComponent(slug)}/analytics${query}`, {}, opts)
        console.log(`${colors.cyan(slug)} ${colors.dim(`· last ${stats.days} days`)}`)
        console.log(`  ${colors.green(String(stats.views))} page loads`
            + ` · ${colors.green(String(stats.visitors))} visitors`
            + ` · ${colors.green(String(stats.apiRequests))} API requests`)
        // A bar per day, so the shape is visible without a chart. Scaled to the
        // busiest day; `|| 1` keeps an all-zero window from dividing by zero.
        const peak = Math.max(...stats.daily.map(d => d.views + d.apiRequests), 0) || 1
        for (const day of stats.daily) {
            const total = day.views + day.apiRequests
            const width = Math.round((total / peak) * 32)
            console.log(`  ${colors.dim(day.day)} ${'\u2588'.repeat(width) || colors.dim('\u00b7')} ${total ? total : ''}`)
        }
        console.log(colors.dim('  Counted at the edge; nothing is added to your pages. Only page'))
        console.log(colors.dim('  navigations count, so client-side routes in a single-page app do not.'))
    }))

cli.command('render <slug> <version>', 'render a private preview to a PNG')
    .option('--output <file>', '[string] output file (default: <slug>-<version>.png)')
    .action(action(async (slug: string, version: string, opts: {server?: string; output?: string}) => {
        let result: {status?: string; error?: string; screenshotBase64?: string; diagnostics?: unknown} = {}
        const deadline = Date.now() + 4 * 60_000
        while (Date.now() < deadline && !result.screenshotBase64) {
            result = await authed<typeof result>(
                `/v1/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/render`,
                {method: 'POST'}, opts,
            )
            // A failed render now carries the page console and errors that
            // explain it, so stop and show them rather than polling on.
            if (result.status === 'failed') {
                console.error(colors.red(result.error ?? 'render failed'))
                console.error(JSON.stringify(result.diagnostics, null, 2))
                throw new Error('render failed')
            }
            if (!result.screenshotBase64) await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
        }
        if (!result.screenshotBase64) throw new Error(`render ${result.status ?? 'did not finish'}`)
        const output = resolve(opts.output ?? `${slug}-${version.slice(0, 10)}.png`)
        await import('node:fs/promises').then(fs => fs.writeFile(output, Buffer.from(result.screenshotBase64!, 'base64')))
        console.log(colors.green(`wrote ${output}`))
        console.log(JSON.stringify(result.diagnostics, null, 2))
    }))

cli.command('probe <slug> <version> [path]', 'make an HTTP request to a version from inside the network')
    .option('-X, --method <method>', '[string] HTTP method (default: GET)')
    .option('-H, --header <header>', '[string] extra request header, NAME:value (repeatable)')
    .option('-d, --data <body>', '[string] request body')
    .action(action(async (slug: string, version: string, path: string | undefined, opts: {
        method?: string; header?: string | string[]; data?: string; server?: string
    }) => {
        const headers: Record<string, string> = {}
        for (const item of [opts.header ?? []].flat()) {
            const split = item.indexOf(':')
            if (split < 1) throw new Error(`header must be NAME:value, got ${item}`)
            headers[item.slice(0, split).trim()] = item.slice(split + 1).trim()
        }
        const result = await authed<{
            status?: number | string; headers?: Record<string, string>; body?: string
            durationMs?: number; coldStart?: boolean; truncated?: boolean; error?: string
        }>(`/v1/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/probe`, {
            method: 'POST',
            body: JSON.stringify({path: path ?? '/', method: opts.method, headers, body: opts.data}),
        }, opts)
        if (result.error) throw new Error(result.error)
        const code = Number(result.status)
        const shown = code >= 200 && code < 400 ? colors.green(String(code)) : colors.red(String(code))
        console.log(`${shown} ${colors.dim(`${result.durationMs}ms${result.coldStart ? ' (cold start)' : ''}`)}`)
        for (const [name, value] of Object.entries(result.headers ?? {})) {
            console.log(colors.dim(`${name}: ${value}`))
        }
        console.log('')
        console.log(result.body ?? '')
        if (result.truncated) console.log(colors.yellow('[body truncated]'))
    }))

cli.command('db-export <slug>', 'download a dump of the project database')
    .option('--schema-only', 'dump the schema without any rows')
    .option('--output <file>', '[string] output file (default: <slug>-<date>.sql.gz)')
    .action(action(async (slug: string, opts: {schemaOnly?: boolean; output?: string; server?: string}) => {
        const include = opts.schemaOnly ? 'schema' : 'all'
        let result: {status?: string; error?: string; downloadUrl?: string; sha256?: string; sizeBytes?: number; schemaSql?: string} = {}
        const deadline = Date.now() + 6 * 60_000
        while (Date.now() < deadline && result.status !== 'ready') {
            result = await authed<typeof result>(`/v1/projects/${encodeURIComponent(slug)}/database/exports`, {
                method: 'POST',
                body: JSON.stringify({include}),
            }, opts)
            if (result.status === 'failed') throw new Error(result.error ?? 'export failed')
            if (result.status !== 'ready') await new Promise(wait => setTimeout(wait, 2_000))
        }
        if (result.status !== 'ready' || !result.downloadUrl) throw new Error('export did not finish')
        // The download URL carries no capability of its own, so it is fetched
        // with the same credential as every other call.
        const response = await fetch(result.downloadUrl, {headers: {authorization: `Bearer ${credentials().token}`}})
        if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`)
        const body = Buffer.from(await response.arrayBuffer())
        const {createHash} = await import('node:crypto')
        const digest = createHash('sha256').update(body).digest('hex')
        if (result.sha256 && digest !== result.sha256) {
            throw new Error(`downloaded ${body.length} bytes but the digest does not match; expected ${result.sha256}, got ${digest}`)
        }
        const output = resolve(opts.output ?? `${slug}-${new Date().toISOString().slice(0, 10)}.sql.gz`)
        await import('node:fs/promises').then(fs => fs.writeFile(output, body))
        console.log(colors.green(`wrote ${output} (${body.length} bytes, sha256 verified)`))
    }))

cli.command('delete <slug>', 'schedule project deletion after seven days')
    .option('-y, --yes', '[boolean] skip confirmation')
    .option('--now', '[boolean] purge immediately; operators, own projects, not recoverable')
    .action(action(async (slug: string, opts: {server?: string; yes?: boolean; now?: boolean}) => {
        if (!opts.yes) {
            // The two prompts differ because the two answers differ: one is a
            // week to change your mind, the other is none.
            const answer = await prompts({
                type: 'confirm',
                name: 'yes',
                message: opts.now
                    ? `purge ${slug} now? there is no recovery window and this cannot be undone`
                    : `delete ${slug} after the recovery window?`,
                initial: false,
            })
            if (!answer.yes) return
        }
        const result = await authed<{purgeAfter: string; immediate: boolean}>(`/v1/projects/${encodeURIComponent(slug)}`, {
            method: 'DELETE',
            body: JSON.stringify({confirmation: slug, immediate: opts.now === true}),
        }, opts)
        console.log(result.immediate
            ? colors.yellow(`purging ${slug} now; there is no recovery window`)
            : colors.yellow(`deletion scheduled; purge after ${result.purgeAfter}`))
    }))

cli.command('restore <slug>', 'cancel a scheduled deletion during its recovery window')
    .action(action(async (slug: string, opts: {server?: string}) => {
        const project = await authed<Project>(`/v1/projects/${encodeURIComponent(slug)}/restore`, {
            method: 'POST',
        }, opts)
        console.log(colors.green(`restored ${project.slug}`))
    }))

async function pushVersion(slug: string, directory: string, opts: {server?: string}): Promise<Version> {
    const archive = resolve(tmpdir(), `ritsdev-${process.pid}-${Date.now()}.tar.gz`)
    const root = resolve(directory)
    try {
        await execFileP('tar', [
            '-czf', archive,
            '--exclude=.git',
            '--exclude=node_modules',
            '--exclude=.DS_Store',
            '--exclude=.env',
            '--exclude=.env.*',
            '-C', root,
            '.',
        ])
        const body = await readFile(archive)
        if (body.length > 25 * 1024 * 1024) throw new Error('compressed source exceeds 25 MiB')
        const sha = createHash('sha256').update(body).digest('hex')
        const source = await authed<{sourceRevisionId: string}>(`/v1/projects/${encodeURIComponent(slug)}/sources`, {
            method: 'POST',
            headers: {'content-type': 'application/gzip', 'x-content-sha256': sha},
            body,
        }, opts)
        return await authed<Version>(`/v1/projects/${encodeURIComponent(slug)}/versions`, {
            method: 'POST',
            headers: {'idempotency-key': `cli-build-${sha}`},
            body: JSON.stringify({sourceRevisionId: source.sourceRevisionId}),
        }, opts)
    } finally {
        await rm(archive, {force: true})
    }
}

async function waitVersion(slug: string, versionId: string, opts: {server?: string}): Promise<Version> {
    const deadline = Date.now() + 6 * 60_000
    while (Date.now() < deadline) {
        const version = await authed<Version>(
            `/v1/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(versionId)}`, {}, opts,
        )
        if (['ready', 'failed'].includes(version.status)) return version
        await new Promise(resolveWait => setTimeout(resolveWait, 1500))
    }
    throw new Error('build did not finish within six minutes')
}

async function waitDeployment(slug: string, deploymentId: string, opts: {server?: string}): Promise<Deployment> {
    const deadline = Date.now() + 6 * 60_000
    while (Date.now() < deadline) {
        const deployment = await authed<Deployment>(
            `/v1/projects/${encodeURIComponent(slug)}/deployments/${encodeURIComponent(deploymentId)}`, {}, opts,
        )
        if (['active', 'failed'].includes(deployment.status)) return deployment
        await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
    }
    throw new Error('deployment did not finish within six minutes')
}

function printProject(project: Project, detailed = false): void {
    const status = project.status === 'ready' ? colors.green(project.status) : colors.yellow(project.status)
    console.log(`${colors.bold(project.slug)} ${colors.dim(`[${project.access}]`)} ${status}`)
    console.log(`  ${project.url}`)
    if (detailed) {
        console.log(`  version: ${project.currentVersionId ?? 'none'}`)
        console.log(`  postgres: ${formatBytes(project.usage.postgresBytes)} / ${formatBytes(project.quota.postgresBytes)}`)
        console.log(`  objects:  ${formatBytes(project.usage.objectBytes)} / ${formatBytes(project.quota.objectBytes)}`)
        console.log(`  runtime:  ${project.quota.runtimeMemoryMiB} MiB / ${project.quota.runtimeCpu} CPU`)
        if (project.resources) {
            const state = project.resources.provisionState
            console.log(`  resources: postgres=${project.resources.postgres} storage=${project.resources.storage} llm=${project.resources.llm} (${state === 'ready' ? colors.green(state) : colors.yellow(state)})`)
            if (project.resources.llm) {
                console.log(`  llm:      ${project.quota.llmRequestsPerMinute} req/min · ${project.quota.llmTokensPerMinute} tokens/min`)
            }
            if (project.resources.provisionError) console.log(`  ${colors.red(project.resources.provisionError)}`)
        }
        if (project.showcase?.description) console.log(`  gallery:  ${project.showcase.description}`)
        // Printed as a suggestion and never applied: it was written by a model
        // reading this project's own page, and the owner decides what other
        // people are told about their work.
        if (project.showcase?.draft) {
            console.log(colors.dim(`  suggested: ${project.showcase.draft}`))
            console.log(colors.dim(`  (check it, then: ritsdev describe ${project.slug} "<your line>")`))
        }
    }
}

function printVersion(version: Version): void {
    const status = version.status === 'ready' ? colors.green(version.status)
        : version.status === 'failed' ? colors.red(version.status) : colors.yellow(version.status)
    console.log(`${version.id} ${status} ${colors.dim(version.previewUrl)}`)
    if (version.error) console.log(colors.red(`  ${version.error}`))
}

function formatBytes(value: number): string {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
    return `${value} B`
}

/** The visitor ladder: each mode is reachable by everyone the last one was, plus more. */
const ACCESS_MODES = ['owner', 'network', 'showcase'] as const
type AccessMode = typeof ACCESS_MODES[number]

interface ShowcaseEntry {
    slug: string
    url: string
    description: string
    ownerName: string
    screenshotUrl: string | null
}

interface Project {
    id: string
    slug: string
    url: string
    access: AccessMode
    status: string
    currentVersionId: string | null
    showcase: {description: string; draft: string | null; screenshotSource: string | null; capturedAt: string | null}
    resources?: {postgres: boolean; storage: boolean; llm: boolean; provisionState: string; provisionError: string | null}
    quota: {
        runtimeMemoryMiB: number
        runtimeCpu: number
        postgresBytes: number
        objectBytes: number
        llmRequestsPerMinute: number
        llmTokensPerMinute: number
    }
    usage: {postgresBytes: number; objectBytes: number}
}

interface Version {
    id: string
    status: string
    previewUrl: string
    error?: string | null
}

interface Deployment {
    id: string
    status: string
    url: string
    error?: string | null
}

cli.help()
cli.version('1.0.0')
cli.parse()
