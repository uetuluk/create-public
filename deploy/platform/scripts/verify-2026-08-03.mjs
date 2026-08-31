/**
 * Post-deploy verification for the 2026-08-03 remediation round.
 *
 * Run inside the platform container, which has node, pg, and a loopback route
 * to the control plane:
 *
 *   docker exec -i ritsdev-platform-1 node --input-type=module < verify-2026-08-03.mjs
 *
 * Every check below fails against the previous head. The script mints its own
 * ephemeral account and token, and purges everything it created in a finally
 * block, so an interrupted run leaves at most one project behind.
 */
import {createHash, randomBytes} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {Pool} from 'pg'

const BASE = 'http://127.0.0.1:3000'
const EMAIL = 'deploy-verify@example.edu'
const results = []
let token = null
const created = []

function record(name, ok, detail = '') {
    results.push({name, ok, detail})
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(path, init = {}) {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            ...(init.body ? {'content-type': 'application/json'} : {}),
            ...init.headers,
        },
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return {status: response.status, body}
}

/** Minimal ustar writer: avoids depending on tar being present in the image. */
function tarGz(files) {
    const blocks = []
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content, 'utf8')
        const header = Buffer.alloc(512)
        header.write(name, 0, 100, 'utf8')
        header.write('000644 \0', 100, 8)
        header.write('000000 \0', 108, 8)
        header.write('000000 \0', 116, 8)
        header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12)
        header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ', 136, 12)
        header.write('        ', 148, 8)
        header.write('0', 156, 1)
        header.write('ustar\0', 257, 6)
        header.write('00', 263, 2)
        let sum = 0
        for (const byte of header) sum += byte
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
        blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
    }
    blocks.push(Buffer.alloc(1024))
    return gzipSync(Buffer.concat(blocks))
}

const pool = new Pool({
    connectionString: (() => {
        const url = new URL(process.env.PLATFORM_ADMIN_DATABASE_URL)
        url.pathname = '/_platform'
        return url.toString()
    })(),
    max: 3,
})

async function waitFor(fn, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const value = await fn()
        if (value) return value
        await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error(`timed out waiting for ${label}`)
}

async function makeProject(slug, opts = {}) {
    const response = await api('/v1/projects', {
        method: 'POST',
        body: JSON.stringify({slug, access: 'owner', ...opts}),
    })
    if (response.status !== 202) throw new Error(`create ${slug}: ${response.status} ${JSON.stringify(response.body)}`)
    created.push(slug)
    await waitFor(async () => {
        const project = await api(`/v1/projects/${slug}`)
        return project.body?.resources?.provisionState === 'ready'
    }, 90_000, `${slug} provisioning`)
    return response.body
}

async function uploadAndBuild(slug, files) {
    const archive = tarGz(files)
    const upload = await fetch(`${BASE}/v1/projects/${slug}/sources`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/gzip',
            'x-content-sha256': createHash('sha256').update(archive).digest('hex'),
        },
        body: archive,
    })
    const source = await upload.json()
    if (!source.sourceRevisionId) throw new Error(`upload failed: ${JSON.stringify(source)}`)
    const version = await api(`/v1/projects/${slug}/versions`, {
        method: 'POST',
        body: JSON.stringify({sourceRevisionId: source.sourceRevisionId}),
    })
    const versionId = version.body.id ?? version.body.versionId
    const settled = await waitFor(async () => {
        const state = await api(`/v1/projects/${slug}/versions/${versionId}`)
        return ['ready', 'failed'].includes(state.body.status) ? state.body : null
    }, 300_000, `${slug} build`)
    return {versionId, ...settled}
}

async function deploy(slug, versionId) {
    const deployment = await api(`/v1/projects/${slug}/deployments`, {
        method: 'POST',
        body: JSON.stringify({versionId}),
    })
    const id = deployment.body.id ?? deployment.body.deploymentId
    return await waitFor(async () => {
        const state = await api(`/v1/projects/${slug}/deployments/${id}`)
        return ['active', 'failed'].includes(state.body.status) ? state.body : null
    }, 300_000, `${slug} deployment`)
}

const FUNCTION_APP = {
    'ritsdev.site.json': JSON.stringify({
        schemaVersion: 1,
        functions: {entrypoint: 'functions/index.ts'},
        database: {migrations: 'migrations'},
        resources: {postgres: true, storage: false},
    }),
    'migrations/001_init.sql': 'CREATE TABLE tasks (id INT PRIMARY KEY, title TEXT NOT NULL);',
    'functions/index.ts': `
import {Pool} from "jsr:@db/postgres"
const pool = new Pool(Deno.env.get("DATABASE_URL"), 2, true)
export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/tasks") {
      const c = await pool.connect()
      try {
        if (request.method === "POST") {
          const body = await request.json()
          await c.queryObject("INSERT INTO tasks (id, title) VALUES ($1,$2)", [body.id, body.title])
          return Response.json({inserted: body.id}, {status: 201})
        }
        const rows = await c.queryObject("SELECT id, title FROM tasks ORDER BY id")
        return Response.json({tasks: rows.rows})
      } finally { c.release() }
    }
    return Response.json({ok: true, path: url.pathname})
  },
}`,
}

try {
    // ---- ephemeral identity -------------------------------------------------
    const raw = `rits_${randomBytes(27).toString('base64url')}`
    const account = await pool.query(
        `INSERT INTO accounts (email, display_name, platform_role, project_quota)
         VALUES ($1,'Deploy Verification','user',6)
         ON CONFLICT (email) DO UPDATE SET project_quota = 6 RETURNING id`,
        [EMAIL],
    )
    await pool.query(
        `INSERT INTO personal_access_tokens (account_id, name, token_hash, token_last_four, scopes, expires_at)
         VALUES ($1,'deploy-verify',$2,$3,
                 ARRAY['sites:read','sites:write','deployments:write','logs:read','database:read'],
                 now() + interval '2 hours')`,
        [account.rows[0].id, createHash('sha256').update(raw).digest('hex'), raw.slice(-4)],
    )
    token = raw
    const me = await api('/v1/me')
    record('ephemeral token authenticates', me.status === 200, `HTTP ${me.status}`)

    // ---- CHECK A: a version whose migrations cannot run must not activate ----
    // Forces the exact state the reporting agent hit: resources not yet
    // provisioned when the deployment runs.
    const slugA = `vfy-migrate-${randomBytes(3).toString('hex')}`
    await makeProject(slugA, {postgres: true, storage: false})
    const buildA = await uploadAndBuild(slugA, FUNCTION_APP)
    if (buildA.status !== 'ready') throw new Error(`build A failed: ${buildA.error ?? ''}`)
    await pool.query(
        `UPDATE project_resources SET database_migration_user = NULL, database_secret_enc = NULL
         WHERE project_id = (SELECT id FROM projects WHERE slug = $1)`,
        [slugA],
    )
    const deployA = await deploy(slugA, buildA.versionId)
    record(
        'A. deployment fails instead of activating when migrations cannot run',
        deployA.status === 'failed' && /provisioning has not finished/.test(deployA.error ?? ''),
        `status=${deployA.status} error=${(deployA.error ?? '').slice(0, 90)}`,
    )
    const projectA = await api(`/v1/projects/${slugA}`)
    record(
        'A2. the project was not left pointing at the broken version',
        projectA.body.currentVersionId === null,
        `currentVersionId=${projectA.body.currentVersionId}`,
    )

    // ---- CHECK A3: migrations actually apply, and are logged -----------------
    await pool.query(
        `UPDATE project_resources r
         SET database_migration_user = 'mg_' || replace(p.id::text,'-','')::text,
             database_secret_enc = NULL
         FROM projects p WHERE p.id = r.project_id AND p.slug = $1`,
        [slugA],
    )
    // Re-provision restores the real credentials without rotating anything.
    const reprovision = await api(`/v1/projects/${slugA}/resources`, {
        method: 'POST',
        body: JSON.stringify({postgres: true}),
    })
    await waitFor(async () => {
        const project = await api(`/v1/projects/${slugA}`)
        return project.body?.resources?.provisionState === 'ready'
    }, 90_000, 'reprovision')
    record('B. enable_project_resources re-provisions an existing project', reprovision.status === 202,
        `HTTP ${reprovision.status}`)
    const deployA2 = await deploy(slugA, buildA.versionId)
    record('A3. the same version deploys once provisioning is repaired',
        deployA2.status === 'active', `status=${deployA2.status} ${(deployA2.error ?? '').slice(0, 80)}`)
    const logsA = await api(`/v1/projects/${slugA}/logs?limit=200`)
    const migrateLines = (logsA.body.logs ?? []).filter(l => l.source === 'migrate')
    record('A4. migrations are logged file by file',
        migrateLines.some(l => /applied 001_init\.sql/.test(l.message)) &&
        migrateLines.some(l => /migrations: \d+ applied/.test(l.message)),
        `${migrateLines.length} migrate lines`)

    // ---- CHECK C: probe reaches /api, and the table exists ------------------
    const probeGet = await api(`/v1/projects/${slugA}/versions/${buildA.versionId}/probe`, {
        method: 'POST',
        body: JSON.stringify({path: '/api/tasks'}),
    })
    record('C. probe_version reaches a LAN-only function over /api',
        probeGet.body.status === 200, `status=${probeGet.body.status} coldStart=${probeGet.body.coldStart} ${probeGet.body.durationMs}ms`)
    record('C2. the migration really created the table (no "does not exist")',
        typeof probeGet.body.body === 'string' && probeGet.body.body.includes('tasks') &&
        !/does not exist/.test(probeGet.body.body),
        (probeGet.body.body ?? '').slice(0, 120))
    const probePost = await api(`/v1/projects/${slugA}/versions/${buildA.versionId}/probe`, {
        method: 'POST',
        body: JSON.stringify({path: '/api/tasks', method: 'POST', body: JSON.stringify({id: 1, title: 'from probe'})}),
    })
    record('C3. probe_version can POST and the write round-trips',
        probePost.body.status === 201, `status=${probePost.body.status}`)
    const probeHost = await api(`/v1/projects/${slugA}/versions/${buildA.versionId}/probe`, {
        method: 'POST',
        body: JSON.stringify({path: '/api', headers: {Host: 'evil.example'}}),
    })
    record('C4. probe refuses a caller-supplied Host header',
        probeHost.status === 400, `HTTP ${probeHost.status}`)

    // ---- CHECK D: render a cold function-backed version ---------------------
    await api(`/v1/projects/${slugA}/versions/${buildA.versionId}/probe`, {
        method: 'POST', body: JSON.stringify({path: '/__none'}),
    }).catch(() => {})
    const renderStart = Date.now()
    let render = await api(`/v1/projects/${slugA}/versions/${buildA.versionId}/render`, {method: 'POST'})
    if (render.body.status === 'queued') {
        render = await waitFor(async () => {
            const again = await api(`/v1/projects/${slugA}/versions/${buildA.versionId}/render`, {method: 'POST'})
            return again.body.screenshotBase64 || again.body.status === 'failed' ? again : null
        }, 180_000, 'render')
    }
    record('D. render returns a PNG for a function-backed version',
        typeof render.body.screenshotBase64 === 'string' && render.body.screenshotBase64.length > 1000,
        `${Math.round((Date.now() - renderStart) / 1000)}s, ${render.body.screenshotBase64 ? Buffer.from(render.body.screenshotBase64, 'base64').length : 0} bytes, diagnostics=${JSON.stringify(render.body.diagnostics ?? render.body.error ?? {}).slice(0, 120)}`)

    // ---- CHECK E: a module-scope throw leaves a stack trace ------------------
    const slugE = `vfy-crash-${randomBytes(3).toString('hex')}`
    await makeProject(slugE, {postgres: false, storage: false})
    const buildE = await uploadAndBuild(slugE, {
        'ritsdev.site.json': JSON.stringify({
            schemaVersion: 1,
            functions: {entrypoint: 'functions/index.ts'},
            resources: {postgres: false, storage: false},
        }),
        // Reads an undeclared variable at module scope: the exact shape of the
        // failure that used to surface only as "container is not running".
        'functions/index.ts': `const tuning = Deno.env.get("UNDECLARED_TUNING_VARIABLE")
export default {fetch: () => Response.json({tuning})}`,
    })
    if (buildE.status !== 'ready') throw new Error(`build E failed: ${buildE.error}`)
    const deployE = await deploy(slugE, buildE.versionId)
    const probeE = await api(`/v1/projects/${slugE}/versions/${buildE.versionId}/probe`, {
        method: 'POST', body: JSON.stringify({path: '/api'}),
    })
    const logsE = await api(`/v1/projects/${slugE}/logs?limit=200`)
    const runtimeText = (logsE.body.logs ?? []).filter(l => l.source === 'runtime' || l.source === 'start_runtime')
        .map(l => l.message).join('\n')
    record('E. a module-scope throw records the Deno stack trace',
        /NotCapable|env access|failed to load function entrypoint/.test(runtimeText),
        runtimeText ? runtimeText.replace(/\s+/g, ' ').slice(0, 160) : `deploy=${deployE.status} probe=${probeE.body.status ?? probeE.status} (no runtime logs)`)
    record('E2. the failure names the entrypoint rather than "container is not running"',
        /functions\/index\.ts/.test(runtimeText), '')

    // ---- CHECK F: one corrupted chunk costs one chunk ------------------------
    const slugF = slugE
    const archive = tarGz(FUNCTION_APP)
    const digest = createHash('sha256').update(archive).digest('hex')
    const begin = await api(`/v1/projects/${slugF}/uploads`, {
        method: 'POST', body: JSON.stringify({sha256: digest, sizeBytes: archive.length}),
    })
    let uploadId = begin.body?.uploadId
    if (!uploadId) {
        // REST does not expose the chunked path; drive it through MCP instead.
        const mcp = async (name, args) => {
            const response = await fetch(`${BASE}/mcp`, {
                method: 'POST',
                headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
                body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
            })
            const payload = await response.json()
            const text = payload.result?.content?.find(c => c.type === 'text')?.text
            // A tool error carries the raw Error.message, which is deliberately
            // prose rather than JSON.
            let body = payload
            if (text !== undefined) {
                try { body = JSON.parse(text) } catch { body = {message: text} }
            }
            return {isError: payload.result?.isError, body}
        }
        const started = await mcp('begin_source_upload', {slug: slugF, sha256: digest, sizeBytes: archive.length})
        uploadId = started.body.uploadId
        record('F0. begin_source_upload recommends a smaller chunk size',
            started.body.recommendedChunkBytes === 262144, `${started.body.recommendedChunkBytes}`)
        const size = 200_000
        const chunks = []
        for (let offset = 0; offset < archive.length; offset += size) chunks.push(archive.subarray(offset, offset + size))
        // Send every chunk, corrupting exactly one in the middle.
        const corruptIndex = Math.min(1, chunks.length - 1)
        for (let index = 0; index < chunks.length; index++) {
            const payload = index === corruptIndex
                ? Buffer.concat([chunks[index].subarray(0, chunks[index].length - 3)])
                : chunks[index]
            await mcp('upload_source_chunk', {
                uploadId, chunkIndex: index, dataBase64: payload.toString('base64'),
            })
        }
        const bad = await mcp('complete_source_upload', {uploadId})
        const badText = bad.body?.message ?? JSON.stringify(bad.body)
        record('F. a corrupted chunk is diagnosed instead of failing opaquely',
            bad.isError === true && /assembled \d+ bytes|sha256|chunk \d+ holds/.test(badText),
            badText.slice(0, 170))
        const inspect = await mcp('get_source_upload', {uploadId})
        record('F2. get_source_upload reports per-chunk digests for bisection',
            Array.isArray(inspect.body.chunks) && inspect.body.chunks.every(c => typeof c.sha256 === 'string'),
            `${inspect.body.chunks?.length} chunks, lastError=${String(inspect.body.lastError).slice(0, 60)}`)
        // Repair: re-send only the bad chunk, with its digest.
        const repair = await mcp('upload_source_chunk', {
            uploadId,
            chunkIndex: corruptIndex,
            dataBase64: chunks[corruptIndex].toString('base64'),
            sha256: createHash('sha256').update(chunks[corruptIndex]).digest('hex'),
        })
        const good = await mcp('complete_source_upload', {uploadId})
        record('F3. re-sending only that chunk repairs the upload',
            !good.isError && typeof good.body.sourceRevisionId === 'string',
            `replaced=${repair.body?.replaced} sha256=${String(good.body?.sha256).slice(0, 12)}`)
        const wrongDigest = await mcp('upload_source_chunk', {
            uploadId, chunkIndex: 0, dataBase64: chunks[0].toString('base64'), sha256: 'a'.repeat(64),
        })
        record('F4. a declared per-chunk digest that does not match is rejected on arrival',
            wrongDigest.isError === true && /does not match the sha256/.test(wrongDigest.body?.message ?? ''),
            (wrongDigest.body?.message ?? JSON.stringify(wrongDigest.body)).slice(0, 110))
    }

    // ---- CHECK G: database export -------------------------------------------
    const exportSchema = await api(`/v1/projects/${slugA}/database/exports`, {
        method: 'POST', body: JSON.stringify({include: 'schema'}),
    })
    record('G. export_database returns the schema inline',
        exportSchema.body.status === 'ready' && /CREATE TABLE[\s\S]*tasks/.test(exportSchema.body.schemaSql ?? ''),
        `status=${exportSchema.body.status} ${String(exportSchema.body.sizeBytes)} bytes`)
    record('G2. the inline schema carries no tenant rows',
        !/from probe/.test(exportSchema.body.schemaSql ?? ''), '')
    if (exportSchema.body.downloadUrl) {
        const path = new URL(exportSchema.body.downloadUrl).pathname
        const anon = await fetch(`${BASE}${path}`)
        record('G3. the download URL is inert without credentials', anon.status === 401, `HTTP ${anon.status}`)
        const authed = await fetch(`${BASE}${path}`, {headers: {authorization: `Bearer ${token}`}})
        const bytes = Buffer.from(await authed.arrayBuffer())
        record('G4. the owner can download the dump',
            authed.status === 200 && bytes.length > 0 &&
            authed.headers.get('content-disposition')?.includes('attachment'),
            `HTTP ${authed.status}, ${bytes.length} bytes, ${authed.headers.get('content-type')}`)
    }

    // ---- CHECK H: MCP resources ---------------------------------------------
    const rpc = async (method, params) => {
        const response = await fetch(`${BASE}/mcp`, {
            method: 'POST',
            headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
            body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
        })
        return await response.json()
    }
    const init = await rpc('initialize', {})
    record('H. MCP advertises the resources capability',
        Boolean(init.result?.capabilities?.resources), JSON.stringify(init.result?.capabilities ?? {}))
    const list = await rpc('resources/list', {})
    record('H2. the skill is listed as a resource',
        (list.result?.resources ?? []).some(r => /SKILL\.md$/.test(r.uri)),
        (list.result?.resources ?? []).map(r => r.uri).join(' '))
    const read = await rpc('resources/read', {uri: list.result?.resources?.[0]?.uri})
    record('H3. a resource reads back its content',
        (read.result?.contents?.[0]?.text ?? '').length > 500,
        `${(read.result?.contents?.[0]?.text ?? '').length} chars`)
    const denied = await rpc('resources/read', {uri: 'https://sites.example.test/README.md'})
    record('H4. a non-allowlisted document is refused', denied.error?.code === -32602, JSON.stringify(denied.error ?? {}))
} catch (error) {
    record('SCRIPT COMPLETED', false, String(error && error.stack || error).slice(0, 500))
} finally {
    // ---- cleanup -----------------------------------------------------------
    for (const slug of created) {
        await api(`/v1/projects/${slug}`, {
            method: 'DELETE', body: JSON.stringify({confirmation: slug}),
        }).catch(() => {})
    }
    if (created.length) {
        // delete_project is scheduled seven days out for the recovery window.
        // A verification project must not sit in 'deleting' consuming quota
        // until then, so its purge is brought forward. Both halves are needed:
        // the executor refuses to purge unless projects.purge_after has also
        // passed. Scoped to the slugs this run created.
        await pool.query(
            `UPDATE projects SET purge_after = now() - interval '1 minute' WHERE slug = ANY($1)`,
            [created],
        ).catch(() => {})
        await pool.query(
            `UPDATE jobs SET run_after = now(), status = 'queued', attempts = 0, error_message = NULL
             WHERE kind = 'delete_project' AND status IN ('queued', 'failed')
               AND project_id IN (SELECT id FROM projects WHERE slug = ANY($1))`,
            [created],
        ).catch(() => {})
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
            const left = await pool.query(`SELECT 1 FROM projects WHERE slug = ANY($1)`, [created]).catch(() => null)
            if (left && left.rowCount === 0) break
            await new Promise(r => setTimeout(r, 2000))
        }
    }
    // Deleting the account would cascade to any project row that survived,
    // orphaning its database and bucket. Revoke the token instead.
    await pool.query(
        `UPDATE personal_access_tokens SET revoked_at = now()
         WHERE account_id = (SELECT id FROM accounts WHERE email = $1)`,
        [EMAIL],
    ).catch(() => {})
    console.log('\n=== SUMMARY ===')
    const failed = results.filter(r => !r.ok)
    console.log(`${results.length - failed.length}/${results.length} passed`)
    for (const item of failed) console.log(`  FAILED: ${item.name} — ${item.detail}`)
    console.log(`purge scheduled for: ${created.join(', ') || 'nothing'}`)
    await pool.end()
    process.exit(failed.length ? 1 : 0)
}
