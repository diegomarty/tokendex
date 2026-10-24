/**
 * When sync rounds run, in the worker. The round itself is `SyncEngine.runOnce`; this owns the
 * clock around it, which core may not (no timers in core: `scanLease.ts`).
 *
 * - **One window per machine talks to GitHub**: the scan lease holder. Every window has a
 *   runner, because the lease can move; a follower only re-checks the flag, with no request.
 * - **Soon after a change, rarely otherwise.** A change (a catch, a scan that accrued) pulls the
 *   next round forward to the debounce; with nothing happening, one round per period picks up the
 *   other machines' progress. A quiet round is a conditional GET answered 304, which GitHub does
 *   not count against the rate limit.
 * - **One round at a time**, manual ones included, so two never fold into the save at once.
 * - **Failure backs off** (`retryDelay`), and a refused credential stops the runner until the
 *   host configures a new one: it would only be refused again.
 */

import { type RoundOptions, type SyncReport, retryDelay } from '../core/sync/engine.js'
import { SyncError, type SyncErrorReason } from '../core/sync/transport.js'

/** How long after a change the next round runs. */
export const SYNC_DEBOUNCE_MS = 2 * 60_000
/** The round that runs with nothing happening, for the other machines' progress. */
export const SYNC_PERIOD_MS = 10 * 60_000
/** How often a follower checks whether it now holds the lease. No request is made. */
export const SYNC_LEADER_RECHECK_MS = 60_000

/** One round, with the merge options a manual round may carry. */
export type SyncRound = (options: RoundOptions) => Promise<SyncReport>

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  /** Epoch milliseconds of the last round that completed. */
  lastSyncAt?: number
  lastError?: SyncErrorReason | 'unknown'
  /** For the log only; never shown raw to the player. */
  errorMessage?: string
}

export interface SyncRunnerDeps {
  isLeader: () => boolean
  onStatus: (status: SyncStatus) => void
  onReport: (report: SyncReport) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (timer: NodeJS.Timeout) => void
}

export class SyncRunner {
  private round: SyncRound | undefined
  private timer: NodeJS.Timeout | undefined
  private dueAt = Infinity
  private inFlight: Promise<SyncReport> | undefined
  private failures = 0
  /** Nothing automatic until a manual round succeeds: see `configure`. */
  private paused = false
  private status: SyncStatus = { phase: 'off' }
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (timer: NodeJS.Timeout) => void
  private readonly now: () => number

  constructor(private readonly deps: SyncRunnerDeps) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms)
        // The worker is kept alive by its message port; a sync timer must not hold it open.
        timer.unref?.()
        return timer
      })
    this.clearTimer = deps.clearTimer ?? clearTimeout
    this.now = deps.now ?? Date.now
  }

  /**
   * Starts (or restarts, with a new credential) the runner; `undefined` turns sync off.
   *
   * `paused`: nothing runs on its own until a manual round succeeds. Turning sync on asks the
   * player which companion continues *before* the first round, and an automatic round in between
   * would settle that fork by the rule, unasked.
   */
  configure(round: SyncRound | undefined, options: { paused?: boolean } = {}): void {
    this.cancel()
    this.round = round
    this.failures = 0
    this.paused = options.paused === true
    if (round === undefined) {
      this.publish({ phase: 'off' })
      return
    }
    this.publish({ ...this.status, phase: 'idle', ...noError })
    if (!this.paused) this.schedule(0)
  }

  /** The save changed here: the next round should not wait for the period. */
  noteChange(): void {
    if (this.round === undefined || this.paused || this.status.lastError === 'auth') return
    this.schedule(SYNC_DEBOUNCE_MS)
  }

  /**
   * A round now, whoever holds the lease — the player asked. Throws what the round throws, after
   * recording it like any other failure.
   */
  async runNow(options: RoundOptions = {}): Promise<SyncReport> {
    if (this.round === undefined) throw new Error('sync is off')
    return this.run(options)
  }

  stop(): void {
    this.cancel()
    this.round = undefined
  }

  /** Arms the timer for `delay` from now, unless one is already due sooner. */
  private schedule(delay: number): void {
    const at = this.now() + delay
    if (this.timer !== undefined && this.dueAt <= at) return
    this.cancel()
    this.dueAt = at
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.dueAt = Infinity
      void this.tick()
    }, delay)
  }

  private cancel(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
    this.dueAt = Infinity
  }

  private async tick(): Promise<void> {
    if (this.round === undefined || this.paused) return
    if (!this.deps.isLeader()) {
      this.schedule(SYNC_LEADER_RECHECK_MS)
      return
    }
    await this.run({}).catch(() => undefined)
  }

  /** Serialised: a round asked for while one runs waits for it, then runs on what it left. */
  private async run(options: RoundOptions): Promise<SyncReport> {
    while (this.inFlight !== undefined) await this.inFlight.catch(() => undefined)
    const round = this.round
    if (round === undefined) throw new Error('sync is off')
    const attempt = this.attempt(round, options)
    this.inFlight = attempt
    try {
      return await attempt
    } finally {
      if (this.inFlight === attempt) this.inFlight = undefined
    }
  }

  private async attempt(round: SyncRound, options: RoundOptions): Promise<SyncReport> {
    this.publish({ ...this.status, phase: 'syncing' })
    try {
      const report = await round(options)
      this.publish({ phase: 'idle', lastSyncAt: this.now() })
      this.deps.onReport(report)
      // Only a round of the current configuration speaks for it: one still in flight from before
      // a reconfigure must not lift the pause the enable flow has just set.
      if (this.round === round) {
        this.paused = false
        this.failures = 0
        this.schedule(report.busy ? SYNC_DEBOUNCE_MS : SYNC_PERIOD_MS)
      }
      return report
    } catch (error) {
      this.failures += 1
      const reason = error instanceof SyncError ? error.reason : 'unknown'
      this.publish({
        ...this.status,
        phase: 'error',
        lastError: reason,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      if (this.round === round && !this.paused && reason !== 'auth') {
        this.schedule(retryDelay(this.failures, error))
      }
      throw error
    }
  }

  private publish(status: SyncStatus): void {
    this.status = status
    this.deps.onStatus(status)
  }
}

const noError = { lastError: undefined, errorMessage: undefined }
