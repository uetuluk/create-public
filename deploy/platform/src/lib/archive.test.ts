import assert from 'node:assert/strict'
import test from 'node:test'
import {validateArchiveHeaders, validateArchiveListing} from '../executor'

test('archive validation rejects traversal, links, and oversized expansion before extraction', () => {
    assert.doesNotThrow(() => {
        validateArchiveListing('./\n./src/\n./src/index.ts\n')
        validateArchiveHeaders('drwxr-xr-x root/root 0 2026-01-01 00:00 ./src/\n-rw-r--r-- root/root 42 2026-01-01 00:00 ./src/index.ts\n')
    })
    assert.throws(() => validateArchiveListing('../operator.env\n'), /escapes project root/)
    assert.throws(() => validateArchiveListing('./config/.env.production\n'), /environment files/)
    assert.throws(
        () => validateArchiveHeaders('lrwxrwxrwx root/root 0 2026-01-01 00:00 ./link -> ..\\/operator.env\n'),
        /link or special entry/,
    )
    assert.throws(
        () => validateArchiveHeaders('-rw-r--r-- root/root 268435457 2026-01-01 00:00 ./large.bin\n'),
        /expanded source exceeds/,
    )
})
