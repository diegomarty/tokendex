/**
 * Holds the official-limit signals across refreshes.
 *
 * These are the only three network calls the extension makes besides sprite downloads, and
 * every one of them is optional decoration. So the contract is: **a scan never waits on
 * them.** A refresh returns whatever was last known and kicks off a fetch for next time. A
 * user with no network sees their token numbers exactly as fast as one with.
 *
 * The other reason for the indirection is cost. The Codex path spawns a subprocess; running
 * it on the 2-minute usage cadence would put a process launch on a timer for a signal that
 * moves on the scale of hours.
 */

import { type ClaudeLimitsOptions, LimitsError, fetchClaudeLimits } from './claude.js'
import { type RunOptions, fetchCodexLimits } from './codex.js'
import { type CodexRateLimitStatus, type LimitStatus, scopedLimitEntries } from './models.js'
import { type ProviderStatus, fetchProviderStatuses } from './status.js'
import { type LimitSources, candyEligibleWindows, limitsReady } from './windows.js'
import { codexVisibleSnapshots, spendUsedPercent } from './models.js'
import type { AppLanguage, CandyWindow } from '../companion/model.js'

/** Limits move on the scale of hours; the usage scan runs every two minutes. */
export const LIMITS_INTERVAL_MS = 10 * 60_000
/** Incidents are rarer still, and the feed is a third party's. */
export const STATUS_INTERVAL_MS = 30 * 60_000
/** Fallback backoff for a 429 that names no Retry-After. */
export const RATE_LIMIT_BACKOFF_MS = 15 * 60_000

// Imported from `windows.ts`, their real home since the severity mapping moved there, and
// re-exported so the poller's callers need not know the split.
import { CRIT_THRESHOLD, WARN_THRESHOLD } from './windows.js'
export { CRIT_THRESHOLD, WARN_THRESHOLD }

export interface LimitsSnapshot {
  sources: LimitSources
  statuses: Record<string, ProviderStatus>
  /** Present once at least one provider answered — the gate for seeding candy grants. */
  ready: boolean
}

export interface PollerOptions {
  claude?: ClaudeLimitsOptions
  codex?: RunOptions
  fetcher?: typeof fetch
  now?: () => number
}

export class LimitsPoller {
  private sources: LimitSources = {}
  private statuses: Record<string, ProviderStatus> = {}
  private nextLimitsAt = 0
  private nextStatusAt = 0
  private inFlight = false

  constructor(private readonly options: PollerOptions = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  snapshot(): LimitsSnapshot {
    return { sources: this.sources, statuses: this.statuses, ready: limitsReady(this.sources) }
  }

  /**
   * Starts a refresh if one is due, and resolves immediately with what is already known.
   *
   * The `inFlight` guard is not an optimisation: without it a slow Codex spawn overlaps with
   * the next refresh, and two app-servers race to write the same field.
   */
  refresh(): LimitsSnapshot {
    if (!this.inFlight && this.now() >= Math.min(this.nextLimitsAt, this.nextStatusAt)) {
      this.inFlight = true
      void this.fetchDue().finally(() => {
        this.inFlight = false
      })
    }
    return this.snapshot()
  }

  /** Awaits the refresh instead of firing and forgetting. For tests and for a manual refresh. */
  async refreshNow(): Promise<LimitsSnapshot> {
    this.nextLimitsAt = 0
    this.nextStatusAt = 0
    await this.fetchDue()
    return this.snapshot()
  }

  private async fetchDue(): Promise<void> {
    const now = this.now()
    const work: Promise<void>[] = []
    if (now >= this.nextLimitsAt) work.push(this.fetchLimits(now))
    if (now >= this.nextStatusAt) work.push(this.fetchStatuses(now))
    await Promise.all(work)
  }

  private async fetchLimits(now: number): Promise<void> {
    this.nextLimitsAt = now + LIMITS_INTERVAL_MS

    // Independent: a Codex user with no Claude credentials must still get Codex limits.
    const [claude, codex] = await Promise.all([
      fetchClaudeLimits(this.options.claude ?? {}).catch((e: unknown) => {
        // A 429 is the one failure worth respecting — retrying on schedule earns another.
        if (e instanceof LimitsError && e.failure.reason === 'rateLimited') {
          const retryAfter = e.failure.retryAfter
          this.nextLimitsAt = Math.max(
            this.nextLimitsAt,
            now + (retryAfter === undefined ? RATE_LIMIT_BACKOFF_MS : retryAfter * 1000),
          )
        }
        return undefined
      }),
      fetchCodexLimits(this.options.codex ?? {}).catch(() => undefined),
    ])

    // A failed fetch keeps the previous value rather than blanking the section: the limits
    // did not become unknown, we just could not ask this time.
    if (claude !== undefined) this.sources = { ...this.sources, claude }
    if (codex !== undefined) this.sources = { ...this.sources, codex }
  }

  private async fetchStatuses(now: number): Promise<void> {
    this.nextStatusAt = now + STATUS_INTERVAL_MS
    const statuses = await fetchProviderStatuses(this.options.fetcher ?? fetch)
    // Same rule, per provider: an omitted id keeps whatever it had.
    if (Object.keys(statuses).length > 0) this.statuses = { ...this.statuses, ...statuses }
  }
}

/**
 * Every utilization across both providers.
 *
 * Two knobs, and the warning line and the compact number set them differently on purpose:
 *
 * - `usedToday` narrows to providers the user actually touched today. The warning ignores it
 *   (a weekly limit is worth flagging whether or not you coded in the last few hours); the
 *   compact surfaces pass it, or a Codex-only user sees a Claude percentage as "their" number.
 * - `spendCap` includes Codex's dollar cap. The warning wants it — running out of credit stops
 *   you just as dead. The compact number does not: it reads as a rate, and a spend cap is not.
 */
export function allUtilizations(
  sources: LimitSources,
  options: { usedToday?: ReadonlySet<string>; spendCap?: boolean } = {},
): number[] {
  const usedToday = options.usedToday
  const values: number[] = []
  const claude = usedToday !== undefined && !usedToday.has('claude_code') ? undefined : sources.claude
  const codex = usedToday !== undefined && !usedToday.has('codex') ? undefined : sources.codex
  if (claude !== undefined) {
    for (const window of [claude.fiveHour, claude.sevenDay, claude.sevenDayOpus, claude.sevenDaySonnet]) {
      if (window?.utilization !== undefined) values.push(window.utilization)
    }
    for (const entry of scopedLimitEntries(claude)) {
      if (entry.percent !== undefined) values.push(entry.percent)
    }
  }
  if (codex !== undefined) {
    for (const bucket of codexVisibleSnapshots(codex)) {
      if (bucket.primary !== undefined) values.push(bucket.primary.usedPercent)
      if (bucket.secondary !== undefined) values.push(bucket.secondary.usedPercent)
      // Never in `candyEligibleWindows` either way: a spend cap sits under a headline window,
      // so paying a candy for it would pay twice for one exhaustion.
      if (options.spendCap === true && bucket.individualLimit !== undefined) {
        values.push(spendUsedPercent(bucket.individualLimit))
      }
    }
  }
  return values
}

/**
 * Whether any window has crossed the critical line.
 *
 * Checks **every** window, not just the 5-hour one: a comfortable session with the weekly
 * already at 100% is exactly the case a session-only check misses.
 */
export function isLimitWarning(sources: LimitSources, threshold: number = CRIT_THRESHOLD): boolean {
  return allUtilizations(sources, { spendCap: true }).some((u) => u >= threshold)
}

/** The highest utilization among providers used today, for surfaces showing a single number. */
export function highestUtilization(
  sources: LimitSources,
  usedToday: ReadonlySet<string>,
): number | undefined {
  const values = allUtilizations(sources, { usedToday })
  return values.length === 0 ? undefined : Math.max(...values)
}

export function pollerCandyWindows(snapshot: LimitsSnapshot, lang: AppLanguage): CandyWindow[] {
  return candyEligibleWindows(snapshot.sources, lang)
}

export type { CodexRateLimitStatus, LimitStatus }
