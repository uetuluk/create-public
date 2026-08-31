import assert from 'node:assert/strict'
import test from 'node:test'
import {isPublicAddress} from '../build-proxy'

test('build proxy only permits public destination addresses', () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.2', '::1', 'fc00::1', 'fe80::1']) {
        assert.equal(isPublicAddress(address), false, address)
    }
    assert.equal(isPublicAddress('1.1.1.1'), true)
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
})
