import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import test from 'node:test'
import {dockerLogOptions} from '../executor'

test('log options always leave room for a rotated file', () => {
    // The local driver compresses rotated files, and compression cannot be
    // enabled with a single file: the container then fails to start with an
    // error about the logging driver rather than about the workload. This has
    // cost two separate debugging sessions.
    assert.deepEqual(dockerLogOptions(5), [
        '--log-driver', 'local', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    ])
    assert.throws(() => dockerLogOptions(1, 1), /max-file >= 2/)
    assert.throws(() => dockerLogOptions(1, 0), /max-file >= 2/)
})

test('no container launch sets its log options inline', () => {
    // Guards the fix rather than the symptom: a fifth launched container must
    // go through the helper instead of copying the flags again.
    const source = readFileSync(join(import.meta.dirname, '..', 'executor.ts'), 'utf8')
    const inline = source.split('\n').filter(line => line.includes("'--log-opt'"))
    assert.deepEqual(
        inline.filter(line => !line.includes('max-file=${maxFiles}') && !line.includes('max-size=${maxSizeMb}')),
        [],
        'use dockerLogOptions() instead of inline --log-opt flags',
    )
})
