import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FileLock,
  type LockHandle,
  type LockRecord,
  lockPathFor,
} from '../src/core/coordination/fileLock.js'
import { sourceRoot } from './repoRoot.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ptb-lock-'))
}

function lockFile(): string {
  return join(tempDir(), 'companion-state.json.lock')
}

/** A clock the retry loop drives itself, so waiting costs no wall-clock time. */
function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

function plantLock(path: string, record: Partial<LockRecord>): void {
  const full: LockRecord = {
    pid: 999_999,
    host: hostname(),
    token: 'planted',
    startedAt: 0,
    heartbeatAt: 0,
    ...record,
  }
  writeFileSync(path, JSON.stringify(full), 'utf8')
}

function heldBy(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as LockRecord).token
}

/** A pid nobody owns, so the fixtures and the real `process.kill` probe agree. */
const DEAD_PID = 999_999
const aliveExcept =
  (dead: number) =>
  (pid: number): boolean =>
    pid !== dead

describe('waiting for a lock', () => {
  it('waits for the holder and then takes it', async () => {
    const path = lockFile()
    const clock = fakeClock()
    const common = {
      path,
      now: clock.now,
      staleAfterMs: 10_000,
      retryIntervalMs: 10,
      pidAlive: () => true,
    }
    const holder = await new FileLock({ ...common, sleep: async () => {} }).acquire(100)
    expect(holder).toBeDefined()

    let waits = 0
    const waiter = new FileLock({
      ...common,
      sleep: async (ms) => {
        clock.advance(ms)
        waits += 1
        if (waits === 3) await holder?.release()
      },
    })
    const second = await waiter.acquire(10_000)
    expect(second).toBeDefined()
    expect(waits).toBe(3) // it really waited rather than finding the lock free
    expect(heldBy(path)).toBe(second?.token)
    await second?.release()
  })

  it('fails cleanly at the deadline instead of hanging', async () => {
    const path = lockFile()
    const clock = fakeClock()
    const holder = await new FileLock({ path, now: clock.now, pidAlive: () => true }).acquire(50)
    expect(holder).toBeDefined()

    const waiter = new FileLock({
      path,
      now: clock.now,
      staleAfterMs: 10_000,
      retryIntervalMs: 10,
      pidAlive: () => true,
      sleep: async (ms) => clock.advance(ms),
    })
    const started = clock.now()
    await expect(waiter.acquire(50)).resolves.toBeUndefined()
    expect(clock.now() - started).toBeLessThanOrEqual(60) // gave up at its deadline, not later
    // A zero deadline still gets one honest attempt, and still does not throw.
    await expect(waiter.acquire(0)).resolves.toBeUndefined()
    await holder?.release()
  })
})

describe('staleness — two independent signals', () => {
  // [trigger branch] Signal 1 alone: the heartbeat is seconds old, nowhere near the ceiling,
  // so only the dead pid can justify the break. This is the crashed-window case, and waiting
  // out a generous ceiling for it would freeze every other window for half a minute.
  it('breaks a lock whose owner is gone, without waiting out the ceiling', async () => {
    const path = lockFile()
    const clock = fakeClock()
    plantLock(path, { pid: DEAD_PID, heartbeatAt: clock.now() }) // heartbeat is fresh
    let waits = 0
    const lock = new FileLock({
      path,
      now: clock.now,
      staleAfterMs: 30_000,
      pidAlive: aliveExcept(DEAD_PID),
      sleep: async (ms) => {
        clock.advance(ms)
        waits += 1
      },
    })
    const handle = await lock.acquire(0) // zero deadline: only an immediate break can succeed
    expect(handle).toBeDefined()
    expect(waits).toBe(0)
    expect(heldBy(path)).toBe(handle?.token)
    await handle?.release()
  })

  // [trigger branch] Signal 2 alone: the owner is alive as far as we can tell, so only the
  // aged heartbeat can justify the break. A recycled pid, or a holder on another machine.
  it('breaks a lock whose heartbeat aged out even though the pid answers', async () => {
    const path = lockFile()
    const clock = fakeClock()
    plantLock(path, { pid: process.pid, heartbeatAt: clock.now() - 30_001 })
    const lock = new FileLock({
      path,
      now: clock.now,
      staleAfterMs: 30_000,
      pidAlive: () => true,
      sleep: async (ms) => clock.advance(ms),
    })
    const handle = await lock.acquire(0)
    expect(handle).toBeDefined()
    await handle?.release()
  })

  it('leaves a lock alone while both signals say it is held', async () => {
    const path = lockFile()
    const clock = fakeClock()
    plantLock(path, { pid: process.pid, heartbeatAt: clock.now() - 29_000 })
    const lock = new FileLock({
      path,
      now: clock.now,
      staleAfterMs: 30_000,
      retryIntervalMs: 10,
      pidAlive: () => true,
      sleep: async (ms) => clock.advance(ms),
    })
    expect(await lock.acquire(40)).toBeUndefined()
    expect(heldBy(path)).toBe('planted')
  })

  // A pid indexes a process table, and another machine's table is not ours. Trusting it would
  // break a live holder every time a network home directory is shared.
  it('never probes a pid written by another host', async () => {
    const path = lockFile()
    const clock = fakeClock()
    plantLock(path, { pid: DEAD_PID, host: 'some-other-machine', heartbeatAt: clock.now() })
    const lock = new FileLock({
      path,
      now: clock.now,
      staleAfterMs: 30_000,
      retryIntervalMs: 10,
      pidAlive: aliveExcept(DEAD_PID), // would say "gone" if it were asked
      sleep: async (ms) => clock.advance(ms),
    })
    expect(await lock.acquire(40)).toBeUndefined()
  })

  // A torn lock record has no pid we may believe. Falling back to the file's own age keeps a
  // half-written heartbeat from either wedging the lock for ever or breaking a live one.
  it('judges an unreadable lock file on its age, never on an invented pid', async () => {
    const path = lockFile()
    writeFileSync(path, '{"pid":12', 'utf8') // a heartbeat caught mid-write
    const fresh = new FileLock({ path, staleAfterMs: 2_000, retryIntervalMs: 5 })
    expect(await fresh.acquire(0)).toBeUndefined()

    const old = Date.now() / 1000 - 60
    utimesSync(path, old, old)
    const handle = await fresh.acquire(0)
    expect(handle).toBeDefined()
    await handle?.release()
  })
})

describe('breaking a stale lock', () => {
  // [trigger branch] Both waiters judge the same stale lock at the same instant and reach the
  // break together. `rename` arbitrates: one moves the file aside, the other gets ENOENT.
  // `unlink` would let both succeed, and the second would delete the winner's fresh lock.
  it('lets exactly one of two simultaneous waiters win the break', async () => {
    const path = lockFile()
    const clock = fakeClock()
    plantLock(path, { pid: DEAD_PID, heartbeatAt: clock.now() })

    const renamed: string[] = []
    const bothArrived = { count: 0, release: () => {} }
    const gate = new Promise<void>((resolve) => (bothArrived.release = resolve))
    const realRename = fsp.rename.bind(fsp)
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      renamed.push(String(from))
      bothArrived.count += 1
      if (bothArrived.count === 2) bothArrived.release()
      await gate // hold both waiters on the doorstep, then let them through together
      return realRename(from as string, to as string)
    })

    let results: (LockHandle | undefined)[]
    try {
      const make = (): FileLock =>
        new FileLock({
          path,
          now: clock.now,
          staleAfterMs: 30_000,
          pidAlive: aliveExcept(DEAD_PID),
          sleep: async (ms) => clock.advance(ms),
        })
      results = await Promise.all([make().acquire(0), make().acquire(0)])
    } finally {
      spy.mockRestore()
    }

    expect(renamed).toEqual([path, path]) // broken by rename, not unlink
    const winners = results.filter((handle) => handle !== undefined)
    expect(winners).toHaveLength(1)
    await winners[0]?.release()
  })

  it('produces exactly one winner when a crowd races one stale lock', async () => {
    const path = lockFile()
    plantLock(path, { pid: DEAD_PID, heartbeatAt: Date.now() })
    // Nobody releases, so a second winner would be a second holder — the thing the rename is
    // there to prevent. The losers give up at their own deadline.
    const locks = Array.from(
      { length: 8 },
      () =>
        new FileLock({
          path,
          staleAfterMs: 30_000,
          retryIntervalMs: 5,
          pidAlive: aliveExcept(DEAD_PID),
        }),
    )
    const results = await Promise.all(locks.map((lock) => lock.acquire(300)))
    const winners = results.filter((handle) => handle !== undefined)
    expect(winners).toHaveLength(1)
    expect(heldBy(path)).toBe(winners[0]?.token)
    await winners[0]?.release()
  })
})

describe('confirming an acquisition', () => {
  /**
   * [trigger branch] Breaking a stale lock is a rename followed by an acquire, and those are
   * not one operation. Here somebody else finishes that sequence in the window between our
   * `open(…, 'wx')` and our first look at the file. Without the confirm we hand back a handle
   * for a lock we do not hold, and two windows write the save at once — the exact failure the
   * lock exists to prevent.
   */
  it('refuses a lock that was stolen between the open and the confirm', async () => {
    const path = lockFile()
    const realReadFile = fsp.readFile.bind(fsp)
    let stolen = false
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation(async (...args) => {
      if (!stolen) {
        stolen = true
        await fsp.rename(path, `${path}.stale-someone`)
        plantLock(path, { pid: process.pid, token: 'the-thief', heartbeatAt: Date.now() })
      }
      return realReadFile(...(args as Parameters<typeof realReadFile>))
    })
    try {
      const lock = new FileLock({ path, staleAfterMs: 30_000, pidAlive: () => true })
      expect(await lock.acquire(0)).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect(heldBy(path)).toBe('the-thief') // and we left the real holder's record alone
  })
})

describe('holding and releasing', () => {
  it('publishes a readable record and clears it on release', async () => {
    const path = lockFile()
    const lock = new FileLock({ path })
    const handle = await lock.acquire(1_000)
    expect(handle).toBeDefined()
    const record = await lock.read()
    expect(record?.token).toBe(handle?.token)
    expect(record?.pid).toBe(process.pid)
    expect(record?.host).toBe(hostname())
    await handle?.release()
    expect(existsSync(path)).toBe(false)
    expect(await lock.read()).toBeUndefined()
  })

  it('moves the heartbeat forward and reports when the lock has been taken away', async () => {
    const path = lockFile()
    const clock = fakeClock()
    const handle = await new FileLock({ path, now: clock.now }).acquire(1_000)
    clock.advance(5_000)
    expect(await handle?.heartbeat()).toBe(true)
    const beat = JSON.parse(readFileSync(path, 'utf8')) as LockRecord
    expect(beat.heartbeatAt).toBe(clock.now())
    expect(beat.startedAt).toBeLessThan(beat.heartbeatAt)

    // Somebody judged us stale and broke us; a lease holder must find that out.
    await fsp.rename(path, `${path}.stale-someone`)
    plantLock(path, { pid: process.pid, token: 'the-next-holder', heartbeatAt: clock.now() })
    expect(await handle?.heartbeat()).toBe(false)
    await handle?.release()
  })

  // Releasing is not "delete the lock file", it is "delete the file *if it is still ours*".
  // A holder that was broken and replaced would otherwise unlink the next holder's lock.
  it('never unlinks a lock that is no longer ours', async () => {
    const path = lockFile()
    const handle = await new FileLock({ path }).acquire(1_000)
    await fsp.rename(path, `${path}.stale-someone`)
    plantLock(path, { pid: process.pid, token: 'the-next-holder', heartbeatAt: Date.now() })
    await handle?.release()
    expect(existsSync(path)).toBe(true)
    expect(heldBy(path)).toBe('the-next-holder')
  })
})

describe('withLock', () => {
  it('runs the work, releases, and tags the outcome', async () => {
    const path = lockFile()
    const lock = new FileLock({ path })
    const result = await lock.withLock(async (handle) => `held:${handle.token}`, 1_000)
    expect(result.acquired).toBe(true)
    expect(result.acquired === true && result.value.startsWith('held:')).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('reports contention instead of running the work', async () => {
    const path = lockFile()
    const clock = fakeClock()
    const holder = await new FileLock({ path, now: clock.now, pidAlive: () => true }).acquire(50)
    let ran = false
    const result = await new FileLock({
      path,
      now: clock.now,
      staleAfterMs: 30_000,
      retryIntervalMs: 10,
      pidAlive: () => true,
      sleep: async (ms) => clock.advance(ms),
    }).withLock(async () => {
      ran = true
    }, 40)
    expect(result.acquired).toBe(false)
    expect(ran).toBe(false)
    await holder?.release()
  })

  it('releases the lock when the work throws', async () => {
    const path = lockFile()
    const lock = new FileLock({ path })
    await expect(
      lock.withLock(async () => {
        throw new Error('the purchase failed')
      }, 1_000),
    ).rejects.toThrow('the purchase failed')
    expect(existsSync(path)).toBe(false)
  })
})

/**
 * The one property no in-process test can reach: a holder that dies **without releasing**.
 * `SIGKILL` is the case the design exists for — a host crash, "Restart Extension Host", a
 * `kill -9` — and only a real process can produce a pid that `process.kill(pid, 0)` answers
 * `ESRCH` for.
 *
 * The staleness ceiling here is a minute, so the heartbeat signal cannot possibly fire: what
 * the parent acquires on is the dead pid, and nothing else.
 */
describe('a holder that dies (real processes)', () => {
  const root = tempDir()
  const holderScript = join(root, 'holder.mjs')

  beforeAll(async () => {
    const source = join(sourceRoot(), 'core', 'coordination', 'fileLock.ts')
    const entry = join(root, 'holder.entry.mjs')
    writeFileSync(
      entry,
      [
        `import { FileLock } from ${JSON.stringify(source)}`,
        `const lock = new FileLock({ path: process.argv[2], staleAfterMs: 60_000 })`,
        `const handle = await lock.acquire(5_000)`,
        `if (handle === undefined) process.exit(2)`,
        `setInterval(() => { void handle.heartbeat() }, 100)`,
        `console.log('held')`,
      ].join('\n'),
      'utf8',
    )
    const { build } = await import('esbuild')
    await build({
      entryPoints: [entry],
      outfile: holderScript,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
    })
  }, 30_000)

  const spawnHolder = async (path: string): Promise<ReturnType<typeof spawn>> => {
    const child = spawn(process.execPath, [holderScript, path], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the holder never reported')), 15_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('held')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`the holder exited early (${String(code)})`))
      })
    })
    return child
  }

  let child: ReturnType<typeof spawn> | undefined
  afterAll(() => child?.kill('SIGKILL'))

  it('is never broken while it lives, and is broken at once when it dies', async () => {
    const path = lockPathFor(join(tempDir(), 'companion-state.json'))
    child = await spawnHolder(path)
    const parent = new FileLock({ path, staleAfterMs: 60_000, retryIntervalMs: 50 })

    // Negative assertion on the wall clock, not on event-loop turns: a live holder that keeps
    // heartbeating must survive a real second and a half of a determined waiter.
    const denied = await parent.acquire(1_500)
    expect(denied).toBeUndefined()
    expect(await parent.read()).toBeDefined()

    const exited = new Promise<void>((resolve) => child?.on('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited

    const startedAt = Date.now()
    const handle = await parent.acquire(5_000)
    expect(handle).toBeDefined()
    // Well inside the 60s ceiling: this is the pid signal, not a heartbeat timing out.
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    await handle?.release()
  }, 30_000)
})
