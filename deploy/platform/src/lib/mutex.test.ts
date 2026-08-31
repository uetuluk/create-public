import assert from 'node:assert/strict'
import test from 'node:test'
import {KeyedMutex, Mutex} from './mutex'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('critical sections do not interleave', async () => {
    const mutex = new Mutex()
    const events: string[] = []
    const section = async (name: string) => {
        await mutex.run(async () => {
            events.push(`${name}:enter`)
            await tick()
            events.push(`${name}:exit`)
        })
    }
    await Promise.all([section('a'), section('b')])
    // Whichever ran first, neither entered while the other was inside.
    assert.deepEqual(events.slice(0, 2), [events[0], events[0].replace(':enter', ':exit')])
    assert.equal(events.length, 4)
})

test('a throw inside a critical section still releases the lock', async () => {
    const mutex = new Mutex()
    await assert.rejects(mutex.run(async () => { throw new Error('boom') }), /boom/)
    // Would hang forever if the lock leaked on the error path.
    assert.equal(await mutex.run(async () => 'recovered'), 'recovered')
})

test('waiters run in the order they arrived', async () => {
    const mutex = new Mutex()
    const order: number[] = []
    const held = mutex.run(async () => { await tick() })
    const queued = [1, 2, 3].map(n => mutex.run(async () => { order.push(n) }))
    await Promise.all([held, ...queued])
    assert.deepEqual(order, [1, 2, 3])
})

test('a keyed mutex serialises one key and parallelises different keys', async () => {
    const mutex = new KeyedMutex()
    const events: string[] = []
    const section = async (key: string, name: string) => {
        await mutex.run(key, async () => {
            events.push(`${name}:enter`)
            await tick()
            events.push(`${name}:exit`)
        })
    }
    await Promise.all([section('a', 'a1'), section('a', 'a2'), section('b', 'b1')])
    const a1 = events.indexOf('a1:exit')
    const a2 = events.indexOf('a2:enter')
    assert.ok(a1 < a2 || events.indexOf('a2:exit') < events.indexOf('a1:enter'), 'same key must not overlap')
    // A different key was free to start before the first finished.
    assert.ok(events.indexOf('b1:enter') < events.indexOf('a1:exit') + 3)
})
