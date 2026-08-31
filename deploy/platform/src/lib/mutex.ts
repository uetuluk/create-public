/**
 * In-process mutual exclusion.
 *
 * The executor is a single process, so an in-process lock is sufficient and
 * correct for serialising work that shares process-external state — Docker
 * network creation and removal, and any `mc` invocation. Anything shared across
 * *processes* uses a PostgreSQL advisory lock instead; see lib/job-claim.ts.
 */

export class Mutex {
    private locked = false
    private readonly waiters: Array<() => void> = []

    /** Runs `fn` with the lock held, releasing it even if `fn` throws. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire()
        try {
            return await fn()
        } finally {
            this.release()
        }
    }

    private async acquire(): Promise<void> {
        if (!this.locked) {
            this.locked = true
            return
        }
        // FIFO: a waiter that arrived first runs first, so a steady stream of
        // callers cannot starve one that is already queued.
        await new Promise<void>(resolve => this.waiters.push(resolve))
    }

    private release(): void {
        const next = this.waiters.shift()
        if (next) {
            next()
            return
        }
        this.locked = false
    }
}

/** One independent mutex per key; different keys never block each other. */
export class KeyedMutex {
    private readonly locks = new Map<string, Mutex>()

    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        let lock = this.locks.get(key)
        if (!lock) {
            lock = new Mutex()
            this.locks.set(key, lock)
        }
        return await lock.run(fn)
    }
}
