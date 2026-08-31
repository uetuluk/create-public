/**
 * Runs the JSON-salvage helper documented in `site-contract.md`.
 *
 * Same reasoning as `llm-sample.test.ts`: the block is copy-pasted by every
 * author who asks the model for structured output, so executing it out of the
 * markdown is the only way an edit to the page cannot quietly break what it
 * teaches. The malformed replies below are verbatim captures from the proxy,
 * not inventions — a `hours-recorder` parse on 2026-08-18 and one on 2026-08-12
 * respectively — which is what makes this a regression test rather than a
 * restatement of the helper's own logic.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'
import {transformSync} from 'esbuild'

const CONTRACT = join(
    import.meta.dirname, '..', '..', '..', '..',
    'skills', 'create-ritsdev', 'references', 'site-contract.md',
)

function loadHelper(): (content: string) => unknown[] {
    const markdown = readFileSync(CONTRACT, 'utf8')
    const block = [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)]
        .map(match => match[1])
        .find(code => code.includes('salvageObjects'))
    assert.ok(block, 'site-contract.md no longer documents a JSON salvage helper')

    const js = transformSync(block, {loader: 'ts', format: 'cjs'}).code
    const module_ = {exports: {} as {readModelJSON?: (content: string) => unknown[]}}
    new Function('module', 'exports', js)(module_, module_.exports)
    assert.ok(module_.exports.readModelJSON, 'the documented helper must export readModelJSON')
    return module_.exports.readModelJSON
}

/** The reply that made the app fall back to its regex parser on 2026-08-18. */
const DUPLICATED_BRACE =
    '{"entries":[{"date":"2026-08-17","hours":3,"details":"Kiwi Codegen App","confidence":"high","newTag":false,"note":""},' +
    '{"date":"2026-08-18","hours":1,"details":"Meeting","confidence":"high","newTag":false,"note":""}}]}'

/** The earlier one, where the key quote is doubled from the second object on. */
const DOUBLED_QUOTE =
    '{"entries":[{"date":"2026-08-15","hours":4,"details":"Kiwi Document Chunking","confidence":"low","newTag":false},' +
    '{""date":"2026-08-16","hours":2,"details":"Meeting","confidence":"low","newTag":false}]}'

test('a duplicated closing brace does not cost the entries', () => {
    const entries = loadHelper()(DUPLICATED_BRACE)
    assert.equal(entries.length, 2)
    assert.deepEqual(entries.map(entry => (entry as {details: string}).details), ['Kiwi Codegen App', 'Meeting'])
})

test('a doubled key quote does not cost the entries', () => {
    const entries = loadHelper()(DOUBLED_QUOTE)
    assert.equal(entries.length, 2)
    assert.deepEqual(entries.map(entry => (entry as {date: string}).date), ['2026-08-15', '2026-08-16'])
})

test('well-formed replies are read as they are, wrapped or bare', () => {
    const read = loadHelper()
    const wrapped = '{"entries":[{"date":"2026-08-17","hours":2,"details":"Meeting"}]}'
    const bare = '[{"date":"2026-08-17","hours":2,"details":"Meeting"}]'
    const fenced = '```json\n' + wrapped + '\n```'
    for (const reply of [wrapped, bare, fenced]) {
        assert.deepEqual(read(reply), [{date: '2026-08-17', hours: 2, details: 'Meeting'}])
    }
})

test('a brace inside a string value is not mistaken for structure', () => {
    const entries = loadHelper()('{"entries":[{"date":"2026-08-17","hours":2,"details":"Fix {json} bug"}}]}')
    assert.deepEqual(entries, [{date: '2026-08-17', hours: 2, details: 'Fix {json} bug'}])
})

test('an empty string value survives the key-quote repair', () => {
    const entries = loadHelper()('{"entries":[{"date":"2026-08-17","hours":2,"note":""}]}')
    assert.equal((entries[0] as {note: string}).note, '')
})

test('a reply with no JSON in it yields nothing, so callers can treat it as a failure', () => {
    assert.deepEqual(loadHelper()('I cannot help with that.'), [])
})
