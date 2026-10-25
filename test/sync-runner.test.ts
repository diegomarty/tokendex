import { describe, expect, it } from 'vitest'
import {
  SYNC_DEBOUNCE_MS,
  SYNC_LEADER_RECHECK_MS,
  SYNC_PERIOD_MS,
  type SyncRound,
  SyncRunner,
  type SyncStatus,
} from '../src/worker/syncRunner.js'
import { type SyncReport } from '../src/core/sync/engine.js'
import { SyncError } from '../src/core/sync/transport.js'

const REPORT: SyncReport = {
  pulled: true,
  pushed: false,
  merges: [],
  peers: [],
  skipped: [],
  busy: false,
}

/** Timers the test advances by hand: `run()` fires whatever is due. */
function clock() {
  let now = 0
  let nextID = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextID++
      timers.set(id, { at: now + ms, fn })
      return id as unknown as NodeJS.Timeout
    },
    clearTimer: (id: NodeJS.Timeout) => void timers.delete(id as unknown as number),
    /** When the one pending timer fires, relative to now; `undefined` when none is pending. */
    pendingIn: () => {
      const [first] = [...timers.values()].sort((a, b) => a.at - b.at)
      return first === undefined ? undefined : first.at - now
    },
    async advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.fn()
      }
      // A round is a chain of awaits on in-memory promises: settle them before asserting.
      for (let i = 0; i < 10; i++) await Promise.resolve()
    },
  }
}

function runner(round: SyncRound, options: { leader?: () => boolean } = {}) {
  const time = clock()
  const statuses: SyncStatus[] = []
  const reports: SyncReport[] = []
  const r = new SyncRunner({
    isLeader: options.leader ?? (() => true),
    onStatus: (s) => statuses.push(s),
    onReport: (report) => reports.push(report),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  })
  r.configure(round)
  return { r, time, statuses, reports }
}

describe('SyncRunner', () => {
  it('syncs at once when configured, then every period', async () => {
    let rounds = 0
    const { time } = runner(async () => {
      rounds += 1
      return REPORT
    })
    await time.advance(0)
    expect(rounds).toBe(1)
    expect(time.pendingIn()).toBe(SYNC_PERIOD_MS)
    await time.advance(SYNC_PERIOD_MS)
    expect(rounds).toBe(2)
  })

  // [trigger branch] Every window of the machine has a runner; only the lease holder may talk to
  // GitHub. A follower checks again soon, without a request, in case it inherits the lease.
  it('leaves the network to the window that holds the lease', async () => {
    let rounds = 0
    let leader = false
    const { time } = runner(
      async () => {
        rounds += 1
        return REPORT
      },
      { leader: () => leader },
    )
    await time.advance(0)
    expect(rounds).toBe(0)
    expect(time.pendingIn()).toBe(SYNC_LEADER_RECHECK_MS)
    leader = true
    await time.advance(SYNC_LEADER_RECHECK_MS)
    expect(rounds).toBe(1)
  })

  it('pulls a change forward to the debounce, never pushes one back', async () => {
    const { r, time } = runner(async () => REPORT)
    await time.advance(0)
    r.noteChange()
    expect(time.pendingIn()).toBe(SYNC_DEBOUNCE_MS)
    await time.advance(SYNC_DEBOUNCE_MS - 1000)
    r.noteChange()
    expect(time.pendingIn()).toBe(1000)
  })

  it("backs off on failure and honours the server's wait", async () => {
    let fail: unknown = new SyncError('network', 'offline')
    const { time, statuses } = runner(async () => {
      if (fail !== undefined) throw fail
      return REPORT
    })
    await time.advance(0)
    expect(time.pendingIn()).toBe(60_000)
    expect(statuses.at(-1)).toMatchObject({ phase: 'error', lastError: 'network' })
    await time.advance(60_000)
    expect(time.pendingIn()).toBe(120_000)
    fail = new SyncError('rateLimited', 'slow', 900_000)
    await time.advance(120_000)
    expect(time.pendingIn()).toBe(900_000)
    fail = undefined
    await time.advance(900_000)
    expect(statuses.at(-1)).toMatchObject({ phase: 'idle' })
    expect(time.pendingIn()).toBe(SYNC_PERIOD_MS)
  })

  // A refused credential will be refused again: retrying it hourly is noise in GitHub's logs.
  // The runner waits for the host to hand it a new one.
  it('stops on a refused credential until it is configured again', async () => {
    const { r, time, statuses } = runner(async () => {
      throw new SyncError('auth', 'refused')
    })
    await time.advance(0)
    expect(statuses.at(-1)).toMatchObject({ phase: 'error', lastError: 'auth' })
    expect(time.pendingIn()).toBeUndefined()
    r.noteChange()
    expect(time.pendingIn()).toBeUndefined()
  })

  it('runs one round at a time, and a manual one regardless of the lease', async () => {
    let release: (() => void) | undefined
    let rounds = 0
    const { r, time } = runner(
      () =>
        new Promise<SyncReport>((resolve) => {
          rounds += 1
          release = () => resolve(REPORT)
        }),
      { leader: () => false },
    )
    const first = r.runNow()
    const second = r.runNow()
    expect(rounds).toBe(1)
    release?.()
    await first
    await time.advance(0)
    release?.()
    await second
    expect(rounds).toBe(2)
  })

  // [trigger branch] Turning sync on asks the player which companion continues before the first
  // round. An automatic round in between would settle the fork by the rule, unasked.
  it('waits for the first manual round when configured paused', async () => {
    let rounds = 0
    const time = clock()
    const r = new SyncRunner({
      isLeader: () => true,
      onStatus: () => undefined,
      onReport: () => undefined,
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    })
    r.configure(
      async () => {
        rounds += 1
        return REPORT
      },
      { paused: true },
    )
    r.noteChange()
    await time.advance(SYNC_PERIOD_MS)
    expect(rounds).toBe(0)
    expect(time.pendingIn()).toBeUndefined()
    await r.runNow({ onFork: 'remote' })
    expect(rounds).toBe(1)
    expect(time.pendingIn()).toBe(SYNC_PERIOD_MS)
  })

  // [trigger branch] A round from before a reconfigure finished after the enable flow paused the
  // runner, and its success unpaused it: an automatic round could then settle the first-sync fork
  // by the rule before the player answered.
  it('does not let a round from an earlier configuration lift the pause', async () => {
    const time = clock()
    let release: (() => void) | undefined
    const r = new SyncRunner({
      isLeader: () => true,
      onStatus: () => undefined,
      onReport: () => undefined,
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    })
    r.configure(
      () =>
        new Promise<SyncReport>((resolve) => {
          release = () => resolve(REPORT)
        }),
    )
    await time.advance(0) // the old round is now in flight
    r.configure(async () => REPORT, { paused: true })
    release?.()
    await time.advance(0)
    r.noteChange()
    expect(time.pendingIn()).toBeUndefined()
  })

  // [trigger branch] A round in flight when sync was turned off still pushed, and its success
  // published "idle" over "off".
  it('tells a round in flight that it is no longer wanted once sync is turned off', async () => {
    const time = clock()
    const statuses: SyncStatus[] = []
    let release: (() => void) | undefined
    let stillWanted: (() => boolean) | undefined
    const r = new SyncRunner({
      isLeader: () => true,
      onStatus: (s) => statuses.push(s),
      onReport: () => undefined,
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    })
    r.configure(
      (options) =>
        new Promise<SyncReport>((resolve) => {
          stillWanted = options.stillWanted
          release = () => resolve(REPORT)
        }),
    )
    await time.advance(0)
    expect(stillWanted?.()).toBe(true)
    r.configure(undefined)
    expect(stillWanted?.()).toBe(false)
    release?.()
    await time.advance(0)
    expect(statuses.at(-1)).toMatchObject({ phase: 'off' })
  })

  // [trigger branch] Its failure, too, spoke for a configuration it no longer belonged to: "error"
  // over "off" — a sign-in prompt after sync was turned off — and a backoff counted against the next.
  it('lets neither the report nor the failure of a round from before a reconfigure through', async () => {
    const time = clock()
    const statuses: SyncStatus[] = []
    const reports: SyncReport[] = []
    const settle: { ok?: () => void; fail?: () => void } = {}
    const r = new SyncRunner({
      isLeader: () => true,
      onStatus: (s) => statuses.push(s),
      onReport: (report) => reports.push(report),
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    })
    const pending = () =>
      new Promise<SyncReport>((resolve, reject) => {
        settle.ok = () => resolve(REPORT)
        settle.fail = () => reject(new SyncError('auth', 'refused'))
      })
    r.configure(pending)
    await time.advance(0)
    r.configure(undefined)
    settle.ok?.()
    await time.advance(0)
    expect(reports).toEqual([])

    r.configure(pending)
    await time.advance(0)
    r.configure(undefined)
    settle.fail?.()
    await time.advance(0)
    expect(statuses.at(-1)).toMatchObject({ phase: 'off' })
    expect(statuses.some((s) => s.phase === 'error')).toBe(false)
  })

  it('goes quiet when turned off', async () => {
    const { r, time, statuses } = runner(async () => REPORT)
    await time.advance(0)
    r.configure(undefined)
    expect(time.pendingIn()).toBeUndefined()
    expect(statuses.at(-1)).toMatchObject({ phase: 'off' })
    r.noteChange()
    expect(time.pendingIn()).toBeUndefined()
  })
})
