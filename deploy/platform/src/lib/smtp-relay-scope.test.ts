import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'

/**
 * `smtpd.conf` is bind-mounted read-only, so it cannot read an environment
 * variable. Its `match from src` is therefore a literal, while compose exposes
 * `MAIL_CONTROL_SUBNET` as configurable — and the two are the same fact written
 * twice.
 *
 * Diverging them fails in the worst available way: an installation that moves
 * the subnet gets a relay that refuses every alert it is handed, and the only
 * symptom is alerts that never arrive, which is indistinguishable from having
 * nothing to alert about. So the coupling is asserted here rather than
 * described in a comment nobody reads while editing the other file.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')
const compose = readFileSync(join(repoRoot, 'deploy', 'compose.yaml'), 'utf8')
const smtpdConf = readFileSync(join(repoRoot, 'deploy', 'smtp', 'smtpd.conf'), 'utf8')

test('the relay accepts exactly the subnet compose puts the control plane on', () => {
    const composeDefault = compose.match(/MAIL_CONTROL_SUBNET:-([\d.]+\/\d+)/)?.[1]
    assert.ok(composeDefault, 'compose.yaml should default MAIL_CONTROL_SUBNET')

    const relayScope = smtpdConf.match(/^match from src ([\d.]+\/\d+)/m)?.[1]
    assert.ok(relayScope, 'smtpd.conf should scope the relay to a subnet')

    assert.equal(
        relayScope,
        composeDefault,
        'smtpd.conf and compose.yaml disagree about the mail-control subnet: '
        + 'the relay would silently refuse every alert. Change both, or neither.',
    )
})

// The scope is the only thing standing between this and an open relay reachable
// by anything that can route to it.
test('the relay is never opened to any source', () => {
    assert.ok(!/^match from any/m.test(smtpdConf), 'match from any would make this an open relay')
})
