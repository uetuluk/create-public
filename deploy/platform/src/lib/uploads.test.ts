import assert from 'node:assert/strict'
import test from 'node:test'
import {describeUploadMismatch, MAX_CHUNK_BYTES, normalizeChunkBase64, sha256Hex} from './uploads'

test('whitespace in a transcribed chunk is tolerated', () => {
    const original = Buffer.from('hello world')
    const wrapped = original.toString('base64').replace(/(.{4})/g, '$1\n')
    assert.deepEqual(normalizeChunkBase64(wrapped), original)
})

test('a mistranscribed chunk is refused instead of silently decoding to wrong bytes', () => {
    // Buffer.from(x, 'base64') drops characters it does not recognise, so a
    // corrupted chunk used to decode to plausible-looking wrong bytes and was
    // only caught 46 chunks later as a whole-archive digest mismatch.
    const good = Buffer.from('the quick brown fox jumps').toString('base64')
    const corrupted = good.slice(0, 4) + '!' + good.slice(5)
    assert.throws(() => normalizeChunkBase64(corrupted), /not valid base64|does not round-trip/)
})

test('base64 that decodes but does not round-trip is refused', () => {
    // 'QUJDRA==' is the canonical encoding of "ABCD". 'QUJDRB==' decodes to the
    // same four bytes because the trailing bits are ignored, but no encoder
    // would emit it — so it is evidence of a corrupted transcription, and the
    // strict round-trip check is what catches it.
    assert.deepEqual(normalizeChunkBase64('QUJDRA=='), Buffer.from('ABCD'))
    assert.throws(() => normalizeChunkBase64('QUJDRB=='), /round-trip/)
})

test('an empty or oversized chunk is refused', () => {
    assert.throws(() => normalizeChunkBase64(''), /empty/)
    const tooBig = Buffer.alloc(MAX_CHUNK_BYTES + 1, 0x61).toString('base64')
    assert.throws(() => normalizeChunkBase64(tooBig), /between 1 and/)
})

test('a valid chunk yields a stable digest', () => {
    const data = normalizeChunkBase64(Buffer.from('abc').toString('base64'))
    assert.equal(sha256Hex(data), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('a truncated middle chunk is identified by index', () => {
    const message = describeUploadMismatch({
        expectedSize: 3 * MAX_CHUNK_BYTES,
        expectedSha256: 'a'.repeat(64),
        actualSize: 3 * MAX_CHUNK_BYTES - 10,
        actualSha256: 'b'.repeat(64),
        chunks: [
            {index: 0, bytes: MAX_CHUNK_BYTES},
            {index: 1, bytes: MAX_CHUNK_BYTES - 10},
            {index: 2, bytes: MAX_CHUNK_BYTES},
        ],
        chunkBytes: MAX_CHUNK_BYTES,
    })
    assert.match(message, /chunk 1 holds \d+ bytes/)
    assert.match(message, /re-send that chunk/)
})

test('a same-length corruption points at the per-chunk digests', () => {
    const message = describeUploadMismatch({
        expectedSize: 2 * MAX_CHUNK_BYTES,
        expectedSha256: 'a'.repeat(64),
        actualSha256: 'b'.repeat(64),
        actualSize: 2 * MAX_CHUNK_BYTES,
        chunks: [{index: 0, bytes: MAX_CHUNK_BYTES}, {index: 1, bytes: MAX_CHUNK_BYTES}],
        chunkBytes: MAX_CHUNK_BYTES,
    })
    assert.match(message, /size matches/)
    assert.match(message, /get_source_upload/)
    assert.doesNotMatch(message, /holds \d+ bytes where/)
})

test('a short final chunk is not mistaken for corruption', () => {
    const message = describeUploadMismatch({
        expectedSize: MAX_CHUNK_BYTES + 100,
        expectedSha256: 'a'.repeat(64),
        actualSize: MAX_CHUNK_BYTES + 100,
        actualSha256: 'b'.repeat(64),
        chunks: [{index: 0, bytes: MAX_CHUNK_BYTES}, {index: 1, bytes: 100}],
        chunkBytes: MAX_CHUNK_BYTES,
    })
    assert.doesNotMatch(message, /chunk 1 holds/)
})
