import assert from 'node:assert/strict'
import {test} from 'node:test'
import {annotateRenderConsole, annotateRenderDiagnostics} from './render-diagnostics'

/**
 * Copied verbatim out of a `diagnostics.json` written by a real render on the
 * platform host, so the pattern is matched against what Chromium actually
 * emits rather than against a paraphrase of it.
 */
const COOP_FROM_A_REAL_RENDER = "The Cross-Origin-Opener-Policy header has been ignored, because the URL's "
    + 'origin was untrustworthy. It was defined either in the final response or a redirect. Please deliver the '
    + "response using the HTTPS protocol. You can also use the 'localhost' origin instead. See "
    + 'https://www.w3.org/TR/powerful-features/#potentially-trustworthy-origin and '
    + 'https://html.spec.whatwg.org/#the-cross-origin-opener-policy-header.'

/** From the same file: the second message the render path provokes. */
const ORIGIN_AGENT_CLUSTER_FROM_A_REAL_RENDER = 'The page requested an origin-keyed agent cluster using the '
    + "Origin-Agent-Cluster header, but could not be origin-keyed since the origin 'http://gateway:3001' had "
    + 'previously been placed in a site-keyed agent cluster. Update your headers to uniformly request '
    + 'origin-keying for all pages on the origin.'

test('the COOP message the render path always emits is downgraded, with the reason attached', () => {
    const [entry] = annotateRenderConsole([{type: 'error', text: COOP_FROM_A_REAL_RENDER}])
    assert.equal(entry.type, 'note')
    // Nothing is swallowed: the full text survives, which is what makes this
    // safe to do at all.
    assert.equal(entry.text, COOP_FROM_A_REAL_RENDER)
    assert.match(entry.note ?? '', /internal render reaches it over plain HTTP/)
})

test('a COOP message from a tenant page keeps its error type', () => {
    // Chromium's other COOP message. This one is the page's own problem: a
    // window.opener call was blocked and the author can fix it.
    const blocked = 'Cross-Origin-Opener-Policy policy would block the window.opener call.'
    // A page is also free to log about COOP itself, including with wording
    // that starts the same way. The reason clause is what distinguishes the
    // browser's untrustworthy-origin notice from either of these.
    const ownLog = 'The Cross-Origin-Opener-Policy header has been ignored by our popup bridge; falling back'
    const annotated = annotateRenderConsole([
        {type: 'error', text: blocked},
        {type: 'error', text: ownLog},
    ])
    assert.deepEqual(annotated, [
        {type: 'error', text: blocked},
        {type: 'error', text: ownLog},
    ])
})

test('the Origin-Agent-Cluster warning is explained without changing its severity', () => {
    const [entry] = annotateRenderConsole([{type: 'warning', text: ORIGIN_AGENT_CLUSTER_FROM_A_REAL_RENDER}])
    // The browser called it a warning and it is one; only the reason was
    // missing. Nothing here raises or lowers a warning.
    assert.equal(entry.type, 'warning')
    assert.equal(entry.text, ORIGIN_AGENT_CLUSTER_FROM_A_REAL_RENDER)
    assert.match(entry.note ?? '', /internal address the renderer reaches the gateway on/)
})

test('the same warning about a page\'s own origin is left bare', () => {
    // A page really can provoke this on the origin visitors use, and then it
    // is about headers the author controls. The internal origin is what makes
    // the render-path one recognisable.
    const ownOrigin = ORIGIN_AGENT_CLUSTER_FROM_A_REAL_RENDER
        .replace("'http://gateway:3001'", "'https://demo.sites.example.test'")
    const annotated = annotateRenderConsole([
        {type: 'warning', text: ownOrigin},
        // And the render-path wording typed as something else is not ours to
        // touch either: only the browser emits it as a warning.
        {type: 'error', text: ORIGIN_AGENT_CLUSTER_FROM_A_REAL_RENDER},
    ])
    assert.deepEqual(annotated, [
        {type: 'warning', text: ownOrigin},
        {type: 'error', text: ORIGIN_AGENT_CLUSTER_FROM_A_REAL_RENDER},
    ])
})

test('only an error is reclassified, and only that one message', () => {
    const warning = {type: 'warning', text: COOP_FROM_A_REAL_RENDER}
    const annotated = annotateRenderConsole([
        warning,
        {type: 'error', text: 'TypeError: cannot read properties of undefined'},
        {type: 'pageerror', text: 'ReferenceError: api is not defined'},
        {type: 'log', text: 'ready'},
    ])
    // A message that already arrived as a warning is left alone; there is
    // nothing to downgrade and widening the match buys nothing.
    assert.deepEqual(annotated, [
        warning,
        {type: 'error', text: 'TypeError: cannot read properties of undefined'},
        {type: 'pageerror', text: 'ReferenceError: api is not defined'},
        {type: 'log', text: 'ready'},
    ])
})

test('order is preserved and unrelated entries are untouched around a match', () => {
    const annotated = annotateRenderConsole([
        {type: 'log', text: 'boot'},
        {type: 'error', text: COOP_FROM_A_REAL_RENDER},
        {type: 'error', text: 'Failed to load resource: 500'},
    ])
    assert.deepEqual(annotated.map(e => e.type), ['log', 'note', 'error'])
    assert.equal(annotated[2].text, 'Failed to load resource: 500')
})

test('malformed diagnostics do not throw', () => {
    assert.deepEqual(annotateRenderConsole(undefined), [])
    assert.deepEqual(annotateRenderConsole('not an array'), [])
    assert.deepEqual(annotateRenderConsole([null, 7, {type: 'error'}]), [null, 7, {type: 'error'}] as never)
})

test('a diagnostics object with no console array is returned unchanged', () => {
    // An absent console key means the container never got far enough to write
    // one. Inventing an empty array here would hide that.
    const parsed = {status: null, error: 'navigation timeout', settled: false}
    assert.deepEqual(annotateRenderDiagnostics({...parsed}), parsed)
})

test('annotateRenderDiagnostics rewrites the console array in place', () => {
    const parsed: Record<string, unknown> = {
        status: 200,
        error: null,
        settled: true,
        console: [{type: 'error', text: COOP_FROM_A_REAL_RENDER}],
    }
    const returned = annotateRenderDiagnostics(parsed)
    assert.equal(returned, parsed)
    assert.equal((parsed.console as Array<{type: string}>)[0].type, 'note')
})
