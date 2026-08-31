/**
 * Managed LLM binding: minting and revoking project-scoped keys on the LiteLLM
 * proxy this installation is configured to use.
 *
 * This lives in the platform rather than the executor by necessity. The
 * executor is attached only to `data-control` and `storage-control`, both
 * `internal: true`, so it has no egress and cannot reach the proxy at all. That
 * isolation is deliberate — the executor holds the Docker socket — so the
 * platform mints and stores the key and the executor only decrypts and injects
 * it when a runtime starts.
 *
 * Rate limits are enforced by the proxy, not here. The platform never sees
 * inference traffic: runtimes call the public endpoint directly over 443. All
 * this side can do is store the limits and pass them at issuance, which is why
 * `rpm` and `tpm` are columns on `projects` next to the byte quotas.
 */

/**
 * No default proxy, deliberately.
 *
 * A default here is not a convenience but a data leak: an installation that
 * sets `LLM_ADMIN_KEY` and forgets `LLM_ADMIN_URL` would send its admin
 * credential and every project's name and id to whichever proxy the default
 * named — someone else's host — and the failure would look like an
 * authentication error rather than a misdirection.
 */
const DEFAULT_MODEL = 'Qwen3-30B-A3B-AWQ'

/** LiteLLM accepts `30s`, `60m`, `24h` and `30d`; it rejects anything else. */
const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/
const DURATION_SECONDS: Record<string, number> = {s: 1, m: 60, h: 3600, d: 86400}

export interface LlmKeyLimits {
    /** Requests per minute. Bounds a hot loop. */
    rpm: number
    /** Tokens per minute. Bounds actual work — one long generation can cost more than many short ones. */
    tpm: number
}

export interface MintedLlmKey {
    key: string
    alias: string
    expiresAt: Date | null
}

export interface LlmServiceOptions {
    adminUrl?: string
    adminKey: string
    baseUrl?: string
    model?: string
    /**
     * Every model a minted key may call. `model` stays the one the platform
     * itself sends and the one runtimes are told to use; this is the allowlist
     * the proxy enforces, which can be wider.
     */
    models?: string[]
    /** TTL requested at issuance, in LiteLLM's duration syntax. */
    duration?: string
    /** Optional team the keys join, so the proxy can also cap them in aggregate. */
    teamId?: string
    /** Names the installation in the proxy's own key metadata. */
    source?: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
    /** Base delay between completion retries. Lowered in tests, not in use. */
    retryBackoffMs?: number
}

export class LlmError extends Error {}

/**
 * `key_alias` is unique on the proxy, so deriving it from the project id gives
 * us a stable handle: revocation never needs the key material itself, and a
 * project can hold at most one key by construction.
 */
export function keyAliasFor(projectId: string): string {
    return `ritsdev-${projectId}`
}

/**
 * The alias for a key the platform issues to itself.
 *
 * Separate from `keyAliasFor` so that platform-owned keys can never collide
 * with a project's: a project id is a UUID, and `platform-<purpose>` is not one.
 * The platform needs its own key because the alternative — reusing the LiteLLM
 * master credential for inference — would put the credential that can mint and
 * revoke every project's key into an ordinary completion request, where it
 * carries no rate limit, no model restriction, and nothing to revoke short of
 * rotating the proxy.
 */
export function platformKeyAliasFor(purpose: string): string {
    return `ritsdev-platform-${purpose}`
}

/**
 * A comma-separated model list, cleaned up.
 *
 * Order is kept because the first entry is what an unset `LLM_MODEL` falls back
 * to, and duplicates are dropped because LiteLLM stores the array as given and
 * a repeated name in `/key/info` reads as a mistake even though it is harmless.
 */
export function parseModelList(value: string | undefined | null): string[] {
    if (!value) return []
    const seen = new Set<string>()
    for (const entry of value.split(',')) {
        const name = entry.trim()
        if (name) seen.add(name)
    }
    return [...seen]
}

export function parseDuration(duration: string): number {
    const match = DURATION_PATTERN.exec(duration)
    if (!match) throw new LlmError(`invalid LLM key duration '${duration}' (expected e.g. 90d)`)
    return Number(match[1]) * DURATION_SECONDS[match[2]]
}

/** Qwen3's soft switch for skipping the reasoning pass. */
const NO_THINK = '/no_think'

/**
 * The same messages, with `/no_think` carried in the prompt.
 *
 * It rides on the system message so it stays out of the caller's own wording,
 * and falls back to the last user message when there is no system role — the
 * switch has to appear somewhere in the prompt to take effect. Already-marked
 * prompts are left alone so a caller that sets it itself does not get it twice.
 */
export function withNoThink<T extends {role: 'system' | 'user'; content: string}>(messages: T[]): T[] {
    if (messages.some(message => message.content.includes(NO_THINK))) return messages
    const lastIndexOfRole = (role: 'system' | 'user'): number => {
        for (let index = messages.length - 1; index >= 0; index--) {
            if (messages[index].role === role) return index
        }
        return -1
    }
    const target = lastIndexOfRole('system') === -1 ? lastIndexOfRole('user') : lastIndexOfRole('system')
    if (target === -1) return messages
    return messages.map((message, index) =>
        index === target ? {...message, content: `${message.content} ${NO_THINK}`} : message)
}

/**
 * The doubled key quote this model emits — `{""date": ...` — repaired.
 *
 * Anchored on a following `key":` so the rewrite only fires where a key is
 * expected and a deliberate empty string value survives untouched.
 */
export function repairModelJson(text: string): string {
    return text.replace(/([{,])\s*""([A-Za-z_][A-Za-z0-9_]*)"\s*:/g, '$1"$2":')
}

/**
 * Every balanced, flat `{...}` in a reply, parsed on its own.
 *
 * The model corrupts the scaffolding around its JSON rather than the objects
 * inside it, and it does so in more than one way: a doubled key quote, and a
 * duplicated brace closing the last object. Both were seen in production within
 * a week, so this deliberately does not know which quirk it is looking at —
 * whole-document parsing is what keeps losing, and parsing each object
 * independently is what survives.
 *
 * String state is tracked so a brace inside a value is never read as structure,
 * and an object containing another object is skipped, which drops any wrapper
 * and keeps the records. Documented for tenants in `site-contract.md`.
 */
export function salvageJsonObjects(text: string): unknown[] {
    const found: unknown[] = []
    const stack: Array<{start: number; hasChild: boolean}> = []
    let inString = false
    let escaped = false

    for (let index = 0; index < text.length; index++) {
        const char = text[index]
        if (escaped) {
            escaped = false
            continue
        }
        if (char === '\\' && inString) {
            escaped = true
            continue
        }
        if (char === '"') {
            inString = !inString
            continue
        }
        if (inString) continue

        if (char === '{') {
            if (stack.length > 0) stack[stack.length - 1]!.hasChild = true
            stack.push({start: index, hasChild: false})
        } else if (char === '}' && stack.length > 0) {
            const frame = stack.pop()!
            if (frame.hasChild) continue
            const candidate = text.slice(frame.start, index + 1)
            for (const attempt of [candidate, repairModelJson(candidate)]) {
                try {
                    found.push(JSON.parse(attempt))
                    break
                } catch {
                    // Try the repaired spelling, then give up on this one.
                }
            }
        }
    }
    return found
}

export class LlmService {
    private readonly adminUrl: string
    private readonly adminKey: string
    private readonly fetchImpl: typeof fetch
    private readonly timeoutMs: number
    private readonly retryBackoffMs: number
    readonly baseUrl: string
    readonly model: string
    /**
     * The allowlist stamped onto every key this service mints.
     *
     * Always contains `model`, and `model` first when it was named explicitly:
     * the proxy refuses a completion for a model the key does not list, so a
     * primary outside its own allowlist would mint keys that cannot serve the
     * platform's own calls. A wider list costs nothing — the key still can only
     * reach models this proxy serves, and the rate limits are unchanged.
     */
    readonly models: readonly string[]
    readonly duration: string
    readonly teamId: string | null
    /**
     * Stamped on every key so the proxy's own records say which installation
     * minted it. A shared proxy serves more than one, and "which platform is
     * this key from?" is unanswerable after the fact if they all say the same
     * thing.
     */
    readonly source: string

    constructor(options: LlmServiceOptions) {
        if (!options.adminKey) throw new LlmError('LLM admin key is required')
        if (!options.adminUrl) {
            throw new LlmError('LLM_ADMIN_URL is required when an LLM admin key is configured')
        }
        this.adminUrl = options.adminUrl.replace(/\/+$/, '')
        this.adminKey = options.adminKey
        this.baseUrl = (options.baseUrl ?? `${this.adminUrl}/v1`).replace(/\/+$/, '')
        const allowlist = parseModelList((options.models ?? []).join(','))
        this.model = options.model ?? allowlist[0] ?? DEFAULT_MODEL
        this.models = allowlist.includes(this.model) ? allowlist : [this.model, ...allowlist]
        this.duration = options.duration ?? '90d'
        this.teamId = options.teamId ?? null
        this.source = options.source ?? 'ritsdev-platform'
        this.fetchImpl = options.fetchImpl ?? fetch
        this.timeoutMs = options.timeoutMs ?? 15_000
        this.retryBackoffMs = options.retryBackoffMs ?? 400
        parseDuration(this.duration)
    }

    /**
     * Returns null when no admin credential is configured, so a deployment that
     * has not been given one still starts and simply cannot offer the binding.
     */
    static fromEnv(env: NodeJS.ProcessEnv, source?: string): LlmService | null {
        const adminKey = env.LLM_ADMIN_KEY
        if (!adminKey) return null
        return new LlmService({
            adminKey,
            adminUrl: env.LLM_ADMIN_URL,
            baseUrl: env.LLM_BASE_URL,
            model: env.LLM_MODEL,
            models: parseModelList(env.LLM_MODELS),
            duration: env.LLM_KEY_DURATION,
            teamId: env.LLM_TEAM_ID,
            source,
        })
    }

    /**
     * Mints a project's key. Nothing here checks that the key answers, and
     * that is deliberate.
     *
     * The case for checking is one report of two completions returning HTTP
     * 500 seconds after a project was created, which succeeded a few minutes
     * later and was never reproduced. An unknown key does not look like that:
     * the proxy answers it with 401 `token_not_found_in_db`, on `/v1/models`
     * and `/v1/chat/completions` alike, checked against the live proxy on
     * 2026-08-04. So a cheap auth-only probe would have returned 200 during
     * exactly the failure that motivated it, and its "verified" would have
     * meant nothing. The only probe that covers a 500 is a real completion,
     * which spends tokens on shared hardware for every project created with
     * the binding, adds an inference round trip to `create_project`, and fails
     * for reasons that have nothing to do with the key — and because the proxy
     * caches identical completions, a fixed probe prompt stops exercising the
     * model path after the first project. Since a probe must degrade to
     * "ready, unverified" rather than fail a create, all it could produce is a
     * note. The retry in the documented sample is where a transient upstream
     * failure is actually survived.
     */
    async mint(project: {id: string; slug: string}, limits: LlmKeyLimits): Promise<MintedLlmKey> {
        const alias = keyAliasFor(project.id)
        // Re-minting for a restored project would collide on the unique alias,
        // and a mint interrupted after the proxy committed leaves an orphan the
        // platform never stored. Clearing the alias first covers both.
        await this.revoke(project.id)
        const response = await this.request<{key: string; expires?: string | null}>('/key/generate', {
            key_alias: alias,
            duration: this.duration,
            rpm_limit: limits.rpm,
            tpm_limit: limits.tpm,
            models: [...this.models],
            metadata: {project_id: project.id, project_slug: project.slug, source: this.source},
            ...(this.teamId ? {team_id: this.teamId} : {}),
        })
        if (!response.key) throw new LlmError('LLM key service returned no key')
        return {
            key: response.key,
            alias,
            expiresAt: expiryFrom(response.expires) ?? new Date(Date.now() + parseDuration(this.duration) * 1000),
        }
    }

    /**
     * Mints a key the platform itself uses, for work no tenant asked for.
     *
     * Same shape as `mint`, and deliberately the same clear-then-generate: the
     * alias is unique on the proxy, so a control-plane restart that mints again
     * must replace rather than collide. The previous key is invalidated by that,
     * which is correct — nothing else holds it, because it is never stored.
     */
    async mintPlatformKey(purpose: string, limits: LlmKeyLimits): Promise<MintedLlmKey> {
        const alias = platformKeyAliasFor(purpose)
        await this.request('/key/delete', {key_aliases: [alias]}, true)
        const response = await this.request<{key: string; expires?: string | null}>('/key/generate', {
            key_alias: alias,
            duration: this.duration,
            rpm_limit: limits.rpm,
            tpm_limit: limits.tpm,
            models: [...this.models],
            metadata: {purpose, source: this.source, owner: 'platform'},
            ...(this.teamId ? {team_id: this.teamId} : {}),
        })
        if (!response.key) throw new LlmError('LLM key service returned no key')
        return {
            key: response.key,
            alias,
            expiresAt: expiryFrom(response.expires) ?? new Date(Date.now() + parseDuration(this.duration) * 1000),
        }
    }

    /**
     * One completion, with the two properties this proxy's model demands.
     *
     * The model reasons before it answers and charges the reasoning against
     * `max_tokens`, so a tight budget returns HTTP 200, `finish_reason:
     * "length"`, and an empty `content`. That cost an author a working feature
     * once already, and a caller reading only the status code cannot see it —
     * which is why an empty content is returned as null here rather than as an
     * answer.
     *
     * Suppressing the reasoning takes `/no_think` in the prompt. The API-level
     * `chat_template_kwargs: {enable_thinking: false}` is sent too, but it is
     * inert on this deployment: measured against vllm-0.26.0, one prompt gave
     * byte-identical reasoning with the flag false, true, and absent — 3423
     * characters of it, consuming a whole 1024-token budget. `/no_think` cut
     * the same prompt to 2 characters and 28 tokens. Whether a prompt reasons
     * at all varies by its wording, which is what makes the failure look
     * intermittent rather than systematic.
     *
     * Returns null for every failure, of any kind. Callers of this are meant to
     * degrade, never to fail.
     */
    async complete(
        key: string,
        messages: Array<{role: 'system' | 'user'; content: string}>,
        options: {maxTokens?: number; timeoutMs?: number} = {},
    ): Promise<string | null> {
        const body = JSON.stringify({
            model: this.model,
            messages: withNoThink(messages),
            chat_template_kwargs: {enable_thinking: false},
            max_tokens: options.maxTokens ?? 1024,
            temperature: 0,
        })
        // A 5xx from the shared proxy is usually transient and a 4xx never is;
        // 429 is the rate limiter, and retrying into it spends the next minute's
        // budget as well. Same rule the documented sample gives to tenants.
        for (let attempt = 0; ; attempt++) {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs)
            try {
                const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {'content-type': 'application/json', authorization: `Bearer ${key}`},
                    body,
                    signal: controller.signal,
                })
                if (response.status >= 500 && attempt < 2) {
                    await response.body?.cancel().catch(() => undefined)
                    await new Promise(resolve => setTimeout(resolve, this.retryBackoffMs * 2 ** attempt))
                    continue
                }
                if (!response.ok) {
                    console.warn(`[llm] completion returned ${response.status}`)
                    return null
                }
                const parsed = await response.json() as {
                    choices?: Array<{message?: {content?: string | null}; finish_reason?: string}>
                }
                const text = parsed.choices?.[0]?.message?.content ?? ''
                if (!text.trim()) {
                    console.warn(`[llm] completion returned no content (finish_reason=${parsed.choices?.[0]?.finish_reason})`)
                    return null
                }
                return text.trim()
            } catch (error: any) {
                if (attempt < 2 && error?.name !== 'AbortError') {
                    await new Promise(resolve => setTimeout(resolve, this.retryBackoffMs * 2 ** attempt))
                    continue
                }
                console.warn(`[llm] completion failed: ${error?.message ?? error}`)
                return null
            } finally {
                clearTimeout(timer)
            }
        }
    }

    /** Idempotent: revoking a project that never held a key is not an error. */
    async revoke(projectId: string): Promise<void> {
        await this.request('/key/delete', {key_aliases: [keyAliasFor(projectId)]}, true)
    }

    private async request<T>(path: string, body: unknown, tolerateMissing = false): Promise<T> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        let response: Response
        try {
            response = await this.fetchImpl(`${this.adminUrl}${path}`, {
                method: 'POST',
                headers: {'content-type': 'application/json', authorization: `Bearer ${this.adminKey}`},
                body: JSON.stringify(body),
                signal: controller.signal,
            })
        } catch (error: any) {
            throw new LlmError(`LLM key service unreachable: ${error?.message ?? error}`)
        } finally {
            clearTimeout(timer)
        }
        if (!response.ok) {
            // The proxy answers 400 for an alias that does not exist, which is
            // the expected outcome of revoking a project that never had a key.
            if (tolerateMissing && (response.status === 400 || response.status === 404)) return undefined as T
            const detail = (await response.text().catch(() => '')).slice(0, 300)
            throw new LlmError(`LLM key service returned ${response.status}${detail ? `: ${detail}` : ''}`)
        }
        if (response.status === 204) return undefined as T
        return await response.json().catch(() => undefined) as T
    }
}

function expiryFrom(value: string | null | undefined): Date | null {
    if (!value) return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
}
