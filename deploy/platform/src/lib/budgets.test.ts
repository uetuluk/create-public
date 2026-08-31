import assert from 'node:assert/strict'
import test from 'node:test'
import {renderBudget, runtimeBudget} from './budgets'

test('runtime defaults let the gateway outlast the executor health wait', () => {
    const budget = runtimeBudget({})
    assert.equal(budget.healthMs, 90_000)
    assert.ok(
        budget.gatewayColdStartMs > budget.healthMs,
        'the gateway must wait longer than the executor, or a slow start is reported as a timeout while it is still working',
    )
    assert.ok(budget.healthProbeMs < budget.healthMs)
})

test('runtime budget honours env overrides', () => {
    const budget = runtimeBudget({RUNTIME_HEALTH_TIMEOUT_MS: '30000', GATEWAY_COLD_START_TIMEOUT_MS: '45000'})
    assert.equal(budget.healthMs, 30_000)
    assert.equal(budget.gatewayColdStartMs, 45_000)
})

test('a gateway budget at or below the health wait is refused', () => {
    // This is exactly the combination that shipped: both 20s.
    assert.throws(
        () => runtimeBudget({RUNTIME_HEALTH_TIMEOUT_MS: '20000', GATEWAY_COLD_START_TIMEOUT_MS: '20000'}),
        /must exceed/,
    )
    assert.throws(
        () => runtimeBudget({RUNTIME_HEALTH_TIMEOUT_MS: '90000', GATEWAY_COLD_START_TIMEOUT_MS: '30000'}),
        /must exceed/,
    )
})

test('a health probe longer than the whole health wait is refused', () => {
    assert.throws(
        () => runtimeBudget({RUNTIME_HEALTH_TIMEOUT_MS: '3000', RUNTIME_HEALTH_PROBE_MS: '3000'}),
        /must be smaller/,
    )
})

test('render defaults give navigation room inside the container wall clock', () => {
    const budget = renderBudget({})
    assert.equal(budget.navigationMs, 60_000)
    assert.ok(budget.containerMs > budget.navigationMs + budget.settleMs)
    // The renderer must be allowed to wait out a cold start before navigating.
    assert.equal(budget.prewarmMs, runtimeBudget({}).healthMs)
})

test('a container wall clock that cannot contain the navigation is refused', () => {
    // The shipped combination: 45s container, 20s navigation, and any settle
    // wait at all would have exceeded it.
    assert.throws(
        () => renderBudget({RENDER_NAVIGATION_TIMEOUT_MS: '60000', RENDER_CONTAINER_TIMEOUT_MS: '60000'}),
        /must exceed/,
    )
})

test('non-numeric and non-positive overrides are refused rather than silently defaulted', () => {
    for (const value of ['abc', '0', '-1', '1.5']) {
        assert.throws(() => runtimeBudget({RUNTIME_HEALTH_POLL_MS: value}), /positive integer/, value)
    }
    // An unset or empty override falls back to the default.
    assert.equal(runtimeBudget({RUNTIME_HEALTH_POLL_MS: ''}).healthPollMs, 350)
})
