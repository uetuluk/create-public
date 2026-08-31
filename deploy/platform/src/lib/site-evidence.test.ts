import assert from 'node:assert/strict'
import test from 'node:test'
import {
    EVIDENCE_MAX_FORMS, EVIDENCE_MAX_ORIGINS, EVIDENCE_TEXT_LIMIT, TRUNCATION_NOTE,
    siteEvidenceFrom, siteEvidenceSchema,
} from './site-evidence'
import {reviewSite, staticSignals, reviewTermsFromEnv} from './site-review'

const TERMS = reviewTermsFromEnv({SITE_REVIEW_IMPERSONATION_TERMS: 'example university,exampleid'})

const site = {slug: 'demo', host: 'demo.sites.example.test'}

function diagnostics(evidence: unknown, rest: Record<string, unknown> = {}) {
    return {status: 200, error: null, settled: true, console: [], evidence, ...rest}
}

test('a normal render becomes the evidence a review reads', () => {
    const evidence = siteEvidenceFrom(diagnostics({
        title: 'My Task App',
        text: 'Log in to your account.',
        truncated: false,
        forms: [{action: '/api/login', method: 'post', inputs: ['text', 'password']}],
        origins: ['https://cdn.example.net'],
    }), site)

    assert.equal(evidence.title, 'My Task App')
    assert.equal(evidence.host, 'demo.sites.example.test')
    assert.deepEqual(evidence.forms, [{action: '/api/login', method: 'post', inputs: ['text', 'password']}])
    assert.deepEqual(evidence.externalOrigins, ['https://cdn.example.net'])
})

test('a render that produced nothing is evidence of nothing, and is not clean', () => {
    // The failure this platform has shipped three times is a check that passes
    // when its evidence is missing. A page that never answered must not read as
    // a page with nothing wrong with it.
    const review = reviewSite(siteEvidenceFrom({status: null, error: 'Timeout exceeded'}, site), null, TERMS)
    assert.equal(review.level, 'review')
    assert.deepEqual(review.signals.map(s => s.code), ['no_page_evidence'])
    assert.match(review.summary, /did not answer/)
})

test('an error page with a full sign-in form is still read as one', () => {
    // Keyed on the absence of evidence rather than on the status code, so
    // answering 404 is not a way to be skipped.
    const review = reviewSite(siteEvidenceFrom(diagnostics({
        title: 'Example University Login',
        text: 'Sign in with your ExampleID and password.',
        truncated: false,
        forms: [{action: 'https://collector.example.net/x', method: 'post', inputs: ['text', 'password']}],
        origins: [],
    }, {status: 404}), site), null, TERMS)

    assert.equal(review.level, 'urgent')
    assert.equal(review.signals.some(s => s.code === 'no_page_evidence'), false)
})

test('a missing or hostile evidence block degrades rather than throwing', () => {
    for (const block of [undefined, null, 'not an object', 42, {forms: 'nope', origins: {}}]) {
        const evidence = siteEvidenceFrom(diagnostics(block), site)
        assert.deepEqual(evidence.forms, [])
        assert.deepEqual(evidence.externalOrigins, [])
        assert.equal(evidence.text, '')
        // And it lands on the floor for having said nothing, never on clean.
        assert.equal(staticSignals(evidence, TERMS)[0].code, 'no_page_evidence')
    }
})

test('a page cannot flood the review with forms, inputs or origins', () => {
    const evidence = siteEvidenceFrom(diagnostics({
        title: 'x',
        text: 'x',
        truncated: false,
        forms: Array.from({length: 500}, () => ({action: '/a', method: 'post', inputs: Array(90).fill('text')})),
        origins: Array.from({length: 500}, (_, i) => `https://h${i}.example.net`),
    }), site)

    assert.equal(evidence.forms.length, EVIDENCE_MAX_FORMS)
    assert.ok(evidence.forms[0].inputs.length <= 20)
    assert.equal(evidence.externalOrigins.length, EVIDENCE_MAX_ORIGINS)
})

test('repeated origins are counted once', () => {
    const evidence = siteEvidenceFrom(diagnostics({
        title: '', text: '', truncated: false, forms: [],
        origins: ['https://a.example', 'https://a.example', 'https://b.example'],
    }), site)
    assert.deepEqual(evidence.externalOrigins, ['https://a.example', 'https://b.example'])
})

test('truncation is marked, whether the collector cut it or this did', () => {
    const collectorCut = siteEvidenceFrom(diagnostics({
        title: '', text: 'a'.repeat(EVIDENCE_TEXT_LIMIT), truncated: true, forms: [], origins: [],
    }), site)
    assert.ok(collectorCut.text.endsWith(TRUNCATION_NOTE), 'the collector said it cut, so it is marked')

    const oversize = siteEvidenceFrom(diagnostics({
        title: '', text: 'a'.repeat(EVIDENCE_TEXT_LIMIT + 500), truncated: false, forms: [], origins: [],
    }), site)
    assert.ok(oversize.text.endsWith(TRUNCATION_NOTE))
    assert.equal(oversize.text.length, EVIDENCE_TEXT_LIMIT + TRUNCATION_NOTE.length)

    const short = siteEvidenceFrom(diagnostics({
        title: '', text: 'short', truncated: false, forms: [], origins: [],
    }), site)
    assert.equal(short.text, 'short')
})

test('what the truncation limit cannot hide', () => {
    // The known bypass, asserted so it stays bounded: text past the cut is
    // invisible, but forms and origins are never truncated, so the two signals
    // that carry the urgent verdicts still see everything.
    const evidence = siteEvidenceFrom(diagnostics({
        title: 'Free stuff',
        text: 'filler '.repeat(EVIDENCE_TEXT_LIMIT),
        truncated: true,
        forms: [{action: 'https://collector.example.net/x', method: 'post', inputs: ['password']}],
        origins: [],
    }), site)

    assert.equal(reviewSite(evidence, null, TERMS).level, 'urgent')
})

test('only genuine console errors travel as evidence', () => {
    // The COOP note the render path provokes is retyped to `note` before this
    // runs, so it never arrives as an error the page is blamed for.
    const evidence = siteEvidenceFrom(diagnostics({title: '', text: 'x', truncated: false, forms: [], origins: []}, {
        console: [
            {type: 'error', text: 'TypeError: x is not a function'},
            {type: 'note', text: 'The Cross-Origin-Opener-Policy header has been ignored'},
            {type: 'log', text: 'hello'},
        ],
    }), site)
    assert.deepEqual(evidence.consoleErrors, ['TypeError: x is not a function'])
})

test('the wire schema rejects evidence larger than the collector can produce', () => {
    const good = siteEvidenceFrom(diagnostics({
        title: 't', text: 'x', truncated: false, forms: [], origins: [],
    }), site)
    assert.equal(siteEvidenceSchema.safeParse(good).success, true)
    assert.equal(siteEvidenceSchema.safeParse({...good, text: 'x'.repeat(EVIDENCE_TEXT_LIMIT * 2)}).success, false)
    assert.equal(siteEvidenceSchema.safeParse({...good, status: 'two hundred'}).success, false)
})
