import {createHash} from 'node:crypto'
import {HTTPException} from 'hono/http-exception'

/**
 * Integrity helpers for the chunked MCP source upload.
 *
 * The upload channel had no per-chunk verification: everything was checked once
 * at the end, and a mismatch there was unrecoverable because `next_chunk` was
 * never rewound and the stored chunks were never cleared. An agent transcribing
 * base64 by hand got 45 of 46 chunks right and had to re-send all 47, twice,
 * with no way to find out which one was wrong.
 */

export const MAX_CHUNK_BYTES = 512 * 1024
/** Deliberately below the cap: shorter base64 blocks transcribe more reliably. */
export const RECOMMENDED_CHUNK_BYTES = 256 * 1024

/**
 * Decodes a base64 chunk, refusing anything that does not round-trip.
 *
 * `Buffer.from(x, 'base64')` silently discards characters it does not
 * recognise, so a mistranscribed chunk decoded to the wrong bytes and was only
 * detected 46 chunks later as a whole-archive digest mismatch. Insisting on an
 * exact round trip turns that into an immediate, local error.
 */
export function normalizeChunkBase64(raw: string): Buffer {
    const normalized = raw.replace(/\s+/g, '')
    if (!normalized) throw new HTTPException(400, {message: 'chunk is empty'})
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
        throw new HTTPException(400, {message: 'chunk is not valid base64'})
    }
    const data = Buffer.from(normalized, 'base64')
    if (data.toString('base64') !== normalized) {
        throw new HTTPException(400, {
            message: 'chunk base64 does not round-trip, so it contains characters that were silently dropped; ' +
                're-send this chunk exactly as produced',
        })
    }
    if (!data.length || data.length > MAX_CHUNK_BYTES) {
        throw new HTTPException(400, {message: `chunk must be between 1 and ${MAX_CHUNK_BYTES} decoded bytes`})
    }
    return data
}

export function sha256Hex(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex')
}

export type ChunkFact = {index: number; bytes: number}

/**
 * Explains a whole-archive mismatch in terms of the chunks that produced it, so
 * a client can re-send one chunk instead of restarting.
 */
export function describeUploadMismatch(input: {
    expectedSize: number
    expectedSha256: string
    actualSize: number
    actualSha256: string
    chunks: readonly ChunkFact[]
    chunkBytes: number
}): string {
    const parts: string[] = []
    if (input.actualSize !== input.expectedSize) {
        parts.push(`assembled ${input.actualSize} bytes but ${input.expectedSize} were declared`)
    } else {
        parts.push(`size matches (${input.actualSize} bytes) but sha256 does not`)
        parts.push(`declared ${input.expectedSha256}, assembled ${input.actualSha256}`)
    }
    parts.push(`${input.chunks.length} chunk(s) stored`)
    // A short chunk that is not the last one is the signature of a truncated
    // transcription, and names the chunk to re-send.
    const short = input.chunks
        .slice(0, -1)
        .find(chunk => chunk.bytes !== input.chunkBytes)
    if (short) {
        parts.push(
            `chunk ${short.index} holds ${short.bytes} bytes where ${input.chunkBytes} were expected, ` +
                'which is where a truncated chunk would show; re-send that chunk with upload_source_chunk ' +
                'and call complete_source_upload again',
        )
    } else {
        parts.push(
            'every chunk has the expected length, so the corruption is within a chunk rather than a short one; ' +
                'call get_source_upload to compare per-chunk digests and re-send only the chunk that differs',
        )
    }
    return parts.join('; ')
}
