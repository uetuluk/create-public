/**
 * Every cold-start and render timeout in one place.
 *
 * These constants used to be literals scattered across executor.ts and
 * gateway.ts, and they had drifted into a combination that could not succeed:
 * the gateway waited 20s for a runtime while the executor's own health probe
 * was also allowed 20s, so a start that used its full budget always surfaced to
 * the visitor as a 504. The renderer then navigated with a 20s timeout of its
 * own, which is why the first preview of any function-backed site timed out.
 *
 * The invariants below are asserted at construction so the same drift cannot
 * happen again silently.
 */

export type RuntimeBudget = {
    /** How long the executor waits for a new container to answer its health probe. */
    healthMs: number
    /** Interval between health probes. */
    healthPollMs: number
    /** Per-probe timeout for a single `docker exec` health check. */
    healthProbeMs: number
    /** How long the gateway waits for `project_runtime.state = 'running'`. */
    gatewayColdStartMs: number
    /** Interval between gateway state polls. */
    gatewayPollMs: number
}

export type RenderBudget = {
    /** How long a pre-warm may take before the renderer gives up and navigates anyway. */
    prewarmMs: number
    /** Playwright `page.goto` timeout. */
    navigationMs: number
    /** Best-effort wait for network idle after load; a timeout here is not an error. */
    settleMs: number
    /** Wall clock for the whole render container. */
    containerMs: number
    /** How long the control plane polls before returning `{status: 'queued'}`. */
    pollMs: number
}

const DEFAULT_RUNTIME: RuntimeBudget = {
    healthMs: 90_000,
    healthPollMs: 350,
    healthProbeMs: 3_000,
    gatewayColdStartMs: 105_000,
    gatewayPollMs: 350,
}

const DEFAULT_RENDER: RenderBudget = {
    prewarmMs: 90_000,
    navigationMs: 60_000,
    settleMs: 5_000,
    containerMs: 120_000,
    pollMs: 55_000,
}

export function runtimeBudget(env: NodeJS.ProcessEnv = process.env): RuntimeBudget {
    const budget: RuntimeBudget = {
        healthMs: readMs(env, 'RUNTIME_HEALTH_TIMEOUT_MS', DEFAULT_RUNTIME.healthMs),
        healthPollMs: readMs(env, 'RUNTIME_HEALTH_POLL_MS', DEFAULT_RUNTIME.healthPollMs),
        healthProbeMs: readMs(env, 'RUNTIME_HEALTH_PROBE_MS', DEFAULT_RUNTIME.healthProbeMs),
        gatewayColdStartMs: readMs(env, 'GATEWAY_COLD_START_TIMEOUT_MS', DEFAULT_RUNTIME.gatewayColdStartMs),
        gatewayPollMs: readMs(env, 'GATEWAY_COLD_START_POLL_MS', DEFAULT_RUNTIME.gatewayPollMs),
    }
    // The gateway has to outlast the executor, or a start that uses its whole
    // budget is reported to the visitor as a timeout while it is still working.
    if (budget.gatewayColdStartMs <= budget.healthMs) {
        throw new Error(
            `GATEWAY_COLD_START_TIMEOUT_MS (${budget.gatewayColdStartMs}) must exceed ` +
                `RUNTIME_HEALTH_TIMEOUT_MS (${budget.healthMs}); the gateway waits on the executor`,
        )
    }
    if (budget.healthProbeMs >= budget.healthMs) {
        throw new Error(
            `RUNTIME_HEALTH_PROBE_MS (${budget.healthProbeMs}) must be smaller than ` +
                `RUNTIME_HEALTH_TIMEOUT_MS (${budget.healthMs})`,
        )
    }
    return budget
}

export function renderBudget(env: NodeJS.ProcessEnv = process.env): RenderBudget {
    const budget: RenderBudget = {
        prewarmMs: readMs(env, 'RENDER_PREWARM_TIMEOUT_MS', runtimeBudget(env).healthMs),
        navigationMs: readMs(env, 'RENDER_NAVIGATION_TIMEOUT_MS', DEFAULT_RENDER.navigationMs),
        settleMs: readMs(env, 'RENDER_SETTLE_TIMEOUT_MS', DEFAULT_RENDER.settleMs),
        containerMs: readMs(env, 'RENDER_CONTAINER_TIMEOUT_MS', DEFAULT_RENDER.containerMs),
        pollMs: readMs(env, 'RENDER_POLL_TIMEOUT_MS', DEFAULT_RENDER.pollMs),
    }
    // The container has to outlast everything it is asked to do inside itself,
    // or a navigation timeout is reported as a container kill and the
    // diagnostics we now always write never make it out.
    if (budget.containerMs <= budget.navigationMs + budget.settleMs) {
        throw new Error(
            `RENDER_CONTAINER_TIMEOUT_MS (${budget.containerMs}) must exceed ` +
                `RENDER_NAVIGATION_TIMEOUT_MS + RENDER_SETTLE_TIMEOUT_MS ` +
                `(${budget.navigationMs} + ${budget.settleMs})`,
        )
    }
    return budget
}

function readMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`)
    }
    return value
}
