/**
 * The model half of a site review, and the reason it lives in the control plane.
 *
 * The executor renders the page — it is the only process holding a Docker
 * socket — but it is attached to `data-control` and `storage-control` only,
 * both `internal: true`. It has no egress at all and cannot reach the proxy at
 * the configured LLM proxy, and it must not be given egress: it holds the Docker
 * socket. The LiteLLM admin credential is likewise set on the platform service
 * alone, for the same reason. So the executor asks the control plane for an
 * opinion over `/internal/site-review`, and everything here runs on that side.
 *
 * Nothing here decides anything. It returns the model's text, or null, and the
 * executor combines it with the static floor through `reviewSite`, which is
 * where the rule that the model may only escalate is enforced. Keeping the
 * judgement in one place is deliberate: a second place that could lower a
 * verdict is a second place to get it wrong.
 */
import {createHash} from 'node:crypto'
import type {LlmService} from './llm'
import {buildReviewPrompt, type SiteEvidence} from './site-review'

/** Names the platform-owned key on the proxy. Not a project id, by design. */
export const REVIEW_KEY_PURPOSE = 'site-review'

/**
 * Deliberately small. A review is one short answer about one page, and the
 * proxy is shared with every project on the host; if this ever runs hot enough
 * to hit these, that is a bug worth being told about rather than absorbing.
 */
export const REVIEW_KEY_LIMITS = {rpm: 20, tpm: 60_000}

/** Thinking is disabled at the request, but a model may still emit a block. */
export function stripReasoning(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

export class SiteReviewModel {
    /**
     * Held in memory only. It is never written to the database, so there is
     * nothing to leak at rest and nothing to keep in step with the proxy; a
     * restart mints a fresh one, which replaces the old alias.
     */
    private key: string | null = null

    constructor(private readonly llm: LlmService) {}

    /**
     * The model's opinion of a page, as raw text for the caller to parse.
     *
     * Null means no opinion — not configured, not reachable, or nothing usable
     * came back. Every one of those is the same thing to a reviewer and none of
     * them is approval.
     */
    async opinion(evidence: SiteEvidence): Promise<string | null> {
        const key = await this.reviewKey()
        if (!key) return null
        const {system, user} = buildReviewPrompt(evidence, digest)
        const raw = await this.llm.complete(
            key,
            [{role: 'system', content: system}, {role: 'user', content: user}],
            // The answer is one JSON object; the budget is headroom, because a
            // model that spends it reasoning returns an empty content instead.
            {maxTokens: 1024, timeoutMs: 60_000},
        )
        if (raw === null) {
            // The commonest reason a working key stops working is that it is no
            // longer there — expired, or cleared on the proxy. Dropping it costs
            // one mint on the next review and self-heals without an operator.
            this.key = null
            return null
        }
        return stripReasoning(raw) || null
    }

    private async reviewKey(): Promise<string | null> {
        if (this.key) return this.key
        try {
            const minted = await this.llm.mintPlatformKey(REVIEW_KEY_PURPOSE, REVIEW_KEY_LIMITS)
            this.key = minted.key
            return this.key
        } catch (error: any) {
            console.warn(`[site-review] could not mint the platform review key: ${error?.message ?? error}`)
            return null
        }
    }
}

function digest(input: string): string {
    return createHash('sha256').update(input).digest('hex')
}
