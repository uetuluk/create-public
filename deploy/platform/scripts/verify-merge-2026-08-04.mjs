/**
 * Post-merge verification for PR #57 (read-only system admin view) and
 * PR #56 (managed LLM binding).
 *
 * Run inside the platform container:
 *   docker exec -i ritsdev-platform-1 node --input-type=module < verify-merge.mjs
 *
 * Mints two ephemeral accounts — one operator, one plain user — so the gate is
 * tested from both sides, and purges both in a finally block.
 */
import {createHash, randomBytes} from 'node:crypto'
import {Pool} from 'pg'

const BASE = 'http://127.0.0.1:3000'
const results = []
const accounts = []

function record(name, ok, detail = '') {
    results.push({name, ok})
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function call(path, token, init = {}) {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            ...(token ? {authorization: `Bearer ${token}`} : {}),
            ...(init.body ? {'content-type': 'application/json'} : {}),
            ...init.headers,
        },
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return {status: response.status, body}
}

const pool = new Pool({
    connectionString: (() => {
        const url = new URL(process.env.PLATFORM_ADMIN_DATABASE_URL)
        url.pathname = '/_platform'
        return url.toString()
    })(),
    max: 3,
})

async function makeAccount(email, role) {
    const account = await pool.query(
        `INSERT INTO accounts (email, display_name, platform_role)
         VALUES ($1, $1, $2)
         ON CONFLICT (email) DO UPDATE SET platform_role = EXCLUDED.platform_role
         RETURNING id`,
        [email, role],
    )
    accounts.push(email)
    const raw = `rits_${randomBytes(24).toString('hex')}`
    await pool.query(
        `INSERT INTO personal_access_tokens (account_id, name, token_hash, token_last_four, scopes, expires_at)
         VALUES ($1,'verify-merge',$2,$3,
                 ARRAY['sites:read','sites:write','deployments:write','logs:read','database:read'],
                 now() + interval '1 hour')`,
        [account.rows[0].id, createHash('sha256').update(raw).digest('hex'), raw.slice(-4)],
    )
    return raw
}

try {
    const opToken = await makeAccount(`verify-op-${randomBytes(3).toString('hex')}@example.edu`, 'operator')
    const userToken = await makeAccount(`verify-user-${randomBytes(3).toString('hex')}@example.edu`, 'user')

    // ---- PR #57: the operator gate, from both sides ----
    const anon = await call('/v1/admin/overview', null)
    record('admin API refuses an anonymous caller', anon.status === 401, `HTTP ${anon.status}`)

    const asUser = await call('/v1/admin/overview', userToken)
    record('admin API refuses a plain user', asUser.status === 403, `HTTP ${asUser.status}`)

    const asOp = await call('/v1/admin/overview', opToken)
    record('operator reads the overview', asOp.status === 200, `HTTP ${asOp.status}`)

    for (const path of ['projects', 'accounts', 'jobs', 'audit']) {
        const r = await call(`/v1/admin/${path}`, opToken)
        record(`operator reads /v1/admin/${path}`, r.status === 200, `HTTP ${r.status}`)
    }

    // ---- read-only: no mutating verb is routed ----
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await call('/v1/admin/projects', opToken, {method})
        record(`${method} /v1/admin/projects is not routed`, r.status === 404, `HTTP ${r.status}`)
    }

    // ---- demotion applies immediately, not at session expiry ----
    await pool.query(`UPDATE accounts SET platform_role = 'user' WHERE email = $1`, [accounts[0]])
    const afterDemote = await call('/v1/admin/overview', opToken)
    record('a demoted operator loses access on the next request',
        afterDemote.status === 403, `HTTP ${afterDemote.status}`)
    await pool.query(`UPDATE accounts SET platform_role = 'operator' WHERE email = $1`, [accounts[0]])

    // ---- no credential column reaches the response ----
    const dump = JSON.stringify([
        (await call('/v1/admin/overview', opToken)).body,
        (await call('/v1/admin/projects', opToken)).body,
        (await call('/v1/admin/accounts', opToken)).body,
    ])
    const leaked = ['token_hash', 'secret_enc', 'storage_secret', 'llm_key_enc', 'password', 'client_secret']
        .filter(needle => dump.toLowerCase().includes(needle.toLowerCase()))
    record('no credential column appears in any admin response', leaked.length === 0,
        leaked.length ? `leaked: ${leaked.join(', ')}` : 'checked 6 column names')

    // ---- limit clamping ----
    const clamped = await call('/v1/admin/jobs?limit=100000', opToken)
    record('limit is clamped rather than honoured',
        clamped.status === 200 && (clamped.body.jobs?.length ?? 0) <= 200,
        `returned ${clamped.body.jobs?.length ?? 0} rows`)

    // ---- the executor's samples reach the operator view ----
    const overview = (await call('/v1/admin/overview', opToken)).body
    record('the host sample written by the executor is visible to the operator API',
        Boolean(overview.host && overview.host.cpuCount > 0),
        overview.host ? `cpu=${overview.host.cpuCount} worker=${overview.host.worker}` : 'host is null')

    // ---- the admin page itself ----
    const page = await call('/admin', null)
    record('the admin page serves HTML that carries no data of its own',
        page.status === 200 && !/token_hash|secret/i.test(String(page.body)),
        `HTTP ${page.status}`)

    // ---- PR #56: the binding degrades when no admin key is configured ----
    const slug = `vfy-llm-${randomBytes(3).toString('hex')}`
    const withLlm = await call('/v1/projects', opToken, {
        method: 'POST',
        body: JSON.stringify({slug, access: 'owner', postgres: false, storage: false, llm: true}),
    })
    record('asking for the LLM binding without LLM_ADMIN_KEY returns 503, not 500',
        withLlm.status === 503, `HTTP ${withLlm.status} ${JSON.stringify(withLlm.body).slice(0, 90)}`)

    // ---- and a project without it still creates, proving migration 6 landed ----
    const plain = await call('/v1/projects', opToken, {
        method: 'POST',
        body: JSON.stringify({slug, access: 'owner', postgres: false, storage: false}),
    })
    // 202: creation is accepted and provisioning runs asynchronously.
    const ok = plain.status === 202
    record('a project without the binding still creates (llm columns exist)',
        ok && plain.body.resources?.llm === false,
        `HTTP ${plain.status} resources=${JSON.stringify(plain.body.resources ?? null)}`)
    // Both branches' fields must survive on one object, which is the merge this
    // round had to make by hand after git produced two duplicate members.
    record('the merged resources shape carries both branches\' fields',
        ok && plain.body.resources?.llm === false && plain.body.resources?.provisionState === 'pending',
        JSON.stringify(plain.body.resources ?? null))
    if (ok) {
        await pool.query(`DELETE FROM projects WHERE slug = $1`, [slug])
    }
} finally {
    for (const email of accounts) {
        await pool.query(`DELETE FROM accounts WHERE email = $1`, [email]).catch(() => {})
    }
    await pool.end()
    const passed = results.filter(r => r.ok).length
    console.log(`\n=== SUMMARY ===\n${passed}/${results.length} passed`)
    if (passed !== results.length) process.exitCode = 1
}
