import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import test from 'node:test'
import {promisify} from 'node:util'
import {renderBudget} from './budgets'
import {renderScript} from '../executor'

const execFileP = promisify(execFile)

test('the render program is syntactically valid', async () => {
    const child = execFileP('node', ['--check'])
    child.child.stdin!.end(renderScript(renderBudget({})))
    await child
})

test('diagnostics are written on every path, including a navigation failure', () => {
    const script = renderScript(renderBudget({}))
    // The shipped version threw out of page.goto before writing the file, so a
    // timeout returned no console output at all — exactly when it was needed.
    const writes = script.match(/writeFileSync\('\/output\/diagnostics\.json'/g) ?? []
    assert.ok(writes.length >= 2, 'diagnostics must be written on the normal path and from the outer catch')
    assert.match(script, /catch\(e\)\{error=String/, 'a navigation failure is recorded, not thrown away')
    assert.match(script, /console:logs/)
})

test('the screenshot is attempted even after a failed navigation', () => {
    const script = renderScript(renderBudget({}))
    const gotoAt = script.indexOf('page.goto')
    const shotAt = script.indexOf('page.screenshot')
    const writeAt = script.indexOf("writeFileSync('/output/diagnostics.json'")
    assert.ok(gotoAt < shotAt && shotAt < writeAt, 'goto, then screenshot, then diagnostics')
    assert.match(script, /try\{await page\.screenshot/)
})

test('it waits for load rather than network idle', () => {
    const script = renderScript(renderBudget({}))
    // A page that polls, streams, or holds a websocket never reaches network
    // idle, so waiting for it timed out however warm the runtime was.
    assert.match(script, /waitUntil:'load'/)
    assert.doesNotMatch(script, /waitUntil:'networkidle'/)
    // Network idle is still tried, but only as a best-effort settle.
    assert.match(script, /waitForLoadState\('networkidle'[^)]*\)\.then\(\(\)=>true,\(\)=>false\)/)
})

test('timeouts come from the budget, not from literals in the program', () => {
    const script = renderScript(renderBudget({RENDER_NAVIGATION_TIMEOUT_MS: '31000', RENDER_SETTLE_TIMEOUT_MS: '2000'}))
    assert.match(script, /timeout:31000/)
    assert.match(script, /timeout:2000/)
    assert.doesNotMatch(script, /timeout:20000/, 'the hard-coded 20s navigation timeout is gone')
})

test('the evidence a review reads is collected, and written with the rest', () => {
    const script = renderScript(renderBudget({}))
    assert.match(script, /evidence=await page\.evaluate/)
    assert.match(script, /document\.forms/)
    assert.match(script, /document\.body&&document\.body\.innerText/)
    // Written into the same file, on the same path that already writes status
    // and console, so a review reads one artefact and not two.
    assert.match(script, /JSON\.stringify\(\{status,error,settled,console:logs,evidence\}\)/)
})

test('a form reports the action its author wrote, not the resolved one', () => {
    // The render reaches the site as http://gateway:3001, so form.action would
    // resolve every relative action against that internal origin and a site's
    // own login would arrive looking like it posts somewhere else — which is
    // the one signal that is otherwise almost never wrong.
    const script = renderScript(renderBudget({}))
    assert.match(script, /form\.getAttribute\('action'\)/)
    assert.doesNotMatch(script, /action:form\.action/)
})

test('origins exclude the internal one the render arrives on', () => {
    const script = renderScript(renderBudget({}))
    // The origins are added in the branch for requests that are *not* the
    // gateway; everything the page loads from itself arrives as gateway:3001,
    // and counting those would flag every page with a stylesheet.
    const gatewayBranch = script.indexOf("url.hostname==='gateway'")
    const originAdd = script.indexOf('origins.add(url.origin)')
    const elseAt = script.indexOf('}else{', gatewayBranch)
    assert.ok(elseAt > 0 && originAdd > elseAt, 'origins are only recorded on the non-gateway path')
})

test('evidence collection cannot fail the render', () => {
    // A page is free to break page.evaluate. That must cost the review its
    // evidence, which reads as no_page_evidence, and never the screenshot.
    const script = renderScript(renderBudget({}))
    assert.match(script, /\}catch\(e\)\{logs\.push\(\{type:'pageerror',text:'evidence collection failed/)
    assert.ok(script.indexOf('evidence collection failed') < script.indexOf('page.screenshot'))
})

test('render headers are still confined to the gateway origin', () => {
    const script = renderScript(renderBudget({}))
    assert.match(script, /url\.hostname==='gateway'&&url\.port==='3001'/)
    assert.match(script, /delete headers\['x-ritsdev-render-token'\]/)
})

/**
 * The two consumers want different pictures of the same page, and the flag is
 * the only thing that separates them. A gallery card is a fixed rectangle: a
 * full-page shot of a long landing page is a 1440x9000 strip, which a card can
 * only show as a sliver of the header or a smear.
 */
test('the caller chooses between a full-page shot and the viewport', () => {
    const full = renderScript(renderBudget({}))
    const viewport = renderScript(renderBudget({}), {fullPage: false})
    assert.match(full, /page\.screenshot\(\{path:'\/output\/screenshot\.png',fullPage:true\}\)/)
    assert.match(viewport, /page\.screenshot\(\{path:'\/output\/screenshot\.png',fullPage:false\}\)/)
    // The default is the previous behaviour, so the preview an author asked for
    // is unchanged by a feature they did not.
    assert.equal(renderScript(renderBudget({}), {}), full)
    // Same viewport either way: the thumbnail's aspect ratio comes from here.
    assert.match(viewport, /viewport:\{width:1440,height:1000\}/)
})
