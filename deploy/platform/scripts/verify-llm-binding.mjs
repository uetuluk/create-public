/**
 * Live gate for the managed LLM binding, part 2: behavioural checks.
 *
 * The first pass asserted against `GET /key/info?key_alias=...`, which turned
 * out to ignore the alias entirely and return the *calling* key's record — it
 * reported `key_alias: create-key` for a key minted under a different alias,
 * with null limits and an empty model list, even though `/key/generate` had
 * echoed all three back correctly. Those assertions were wrong, not the
 * platform. Everything below tests what the project's key can actually DO.
 */
import {createDecipheriv, createHash, randomBytes} from 'node:crypto'
import {Pool} from 'pg'

const BASE = 'http://127.0.0.1:3000'
const ADMIN = (process.env.LLM_ADMIN_URL ?? '').replace(/\/+$/, '')
const ADMIN_KEY = process.env.LLM_ADMIN_KEY
const MODEL = process.env.LLM_MODEL ?? 'Qwen3-30B-A3B-AWQ'
const OTHER_MODEL = 'create-image'
const results = []
let email = null
let slug = null

function record(name, ok, detail = '') {
    results.push({name, ok})
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function decrypt(encoded, keyMaterial) {
    const [version, iv, tag, ciphertext] = encoded.split('.')
    if (version !== 'v1') throw new Error('unexpected envelope')
    const key = createHash('sha256').update(keyMaterial).digest()
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(ciphertext, 'base64url')), d.final()]).toString('utf8')
}

async function call(path, token, init = {}) {
    const r = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            ...(token ? {authorization: `Bearer ${token}`} : {}),
            ...(init.body ? {'content-type': 'application/json'} : {}),
            ...init.headers,
        },
    })
    const text = await r.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return {status: r.status, body}
}

async function chat(key, model) {
    const r = await fetch(`${ADMIN}/v1/chat/completions`, {
        method: 'POST',
        headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'},
        body: JSON.stringify({model, messages: [{role: 'user', content: 'Reply with exactly: ok'}], max_tokens: 8, temperature: 0}),
    })
    const text = await r.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return {status: r.status, body}
}

const pool = new Pool({
    connectionString: (() => {
        const url = new URL(process.env.PLATFORM_ADMIN_DATABASE_URL)
        url.pathname = '/_platform'
        return url.toString()
    })(),
    max: 3,
})

try {
    email = `llm-gate2-${randomBytes(3).toString('hex')}@example.edu`
    const account = await pool.query(
        `INSERT INTO accounts (email, display_name, platform_role) VALUES ($1,$1,'user') RETURNING id`, [email])
    const token = `rits_${randomBytes(24).toString('hex')}`
    await pool.query(
        `INSERT INTO personal_access_tokens (account_id, name, token_hash, token_last_four, scopes, expires_at)
         VALUES ($1,'llm-gate2',$2,$3,ARRAY['sites:read','sites:write','deployments:write','logs:read','database:read'],
                 now() + interval '1 hour')`,
        [account.rows[0].id, createHash('sha256').update(token).digest('hex'), token.slice(-4)])

    slug = `llmgate2-${randomBytes(3).toString('hex')}`
    const created = await call('/v1/projects', token, {
        method: 'POST',
        body: JSON.stringify({slug, access: 'owner', postgres: false, storage: false, llm: true}),
    })
    record('project created with the binding', created.status === 202, `HTTP ${created.status}`)
    const projectId = created.body.id

    const stored = await pool.query(
        `SELECT llm_key_enc, llm_key_alias FROM project_resources WHERE project_id = $1`, [projectId])
    const projectKey = decrypt(stored.rows[0].llm_key_enc, process.env.SECRET_ENCRYPTION_KEY)
    record('the stored key decrypts with SECRET_ENCRYPTION_KEY',
        typeof projectKey === 'string' && projectKey.length > 10, `${projectKey.slice(0, 6)}…`)

    // ---- it works on the granted model ----
    const allowed = await chat(projectKey, MODEL)
    record('the project key performs a real completion on the granted model',
        allowed.status === 200,
        `HTTP ${allowed.status} ${JSON.stringify(allowed.body?.choices?.[0]?.message?.content ?? '').slice(0, 60)}`)

    // ---- and is refused on a model it was not granted ----
    const denied = await chat(projectKey, OTHER_MODEL)
    record(`the project key is refused on a model it was not granted (${OTHER_MODEL})`,
        denied.status >= 400,
        `HTTP ${denied.status} ${JSON.stringify(denied.body?.error?.message ?? denied.body).slice(0, 110)}`)

    // ---- the limits really are attached to this key ----
    const own = await fetch(`${ADMIN}/key/info?key=${encodeURIComponent(projectKey)}`, {
        headers: {authorization: `Bearer ${ADMIN_KEY}`},
    })
    const ownBody = await own.json().catch(() => ({}))
    const i = ownBody.info ?? ownBody
    record('the proxy reports this key\'s own rate limits',
        i?.rpm_limit === 60 && i?.tpm_limit === 200000,
        `rpm=${i?.rpm_limit} tpm=${i?.tpm_limit} alias=${i?.key_alias} models=${JSON.stringify(i?.models)}`)

    // ---- deletion revokes it: proven by the key ceasing to work ----
    const del = await call(`/v1/projects/${encodeURIComponent(slug)}`, token, {
        method: 'DELETE',
        body: JSON.stringify({confirmation: slug}),
    })
    record('deletion is accepted', del.status === 202, `HTTP ${del.status}`)
    const afterDelete = await chat(projectKey, MODEL)
    record('the revoked key can no longer perform inference',
        afterDelete.status === 401 || afterDelete.status === 403,
        `HTTP ${afterDelete.status} ${JSON.stringify(afterDelete.body?.error?.message ?? '').slice(0, 90)}`)
} finally {
    if (slug) await pool.query(`DELETE FROM projects WHERE slug = $1`, [slug]).catch(() => {})
    if (email) await pool.query(`DELETE FROM accounts WHERE email = $1`, [email]).catch(() => {})
    await pool.end()
    const passed = results.filter(r => r.ok).length
    console.log(`\n=== SUMMARY ===\n${passed}/${results.length} passed`)
}
