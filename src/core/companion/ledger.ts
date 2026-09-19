/**
 * Per-provider accrual ledger.
 *
 * This decides how many *new* tokens a refresh contributes to growth. It is dense with
 * defect prevention, and each branch below exists because a specific way of getting it wrong
 * either lost usage or granted it twice. Extracted as a pure function so every branch is
 * reachable from a test.
 */

import type { CompanionState } from './model.js'
import { MilestoneBalance, StreakBalance, grantLegendaryEncounter } from './encounters.js'

export interface LedgerObservation {
  /** Today's cumulative tokens per provider id. Only providers whose date was confirmed. */
  todayTokensByProvider: Record<string, number>
  /** `yyyy-MM-dd`, local. */
  todayDate: string
  /** Whether a displayable snapshot exists at all. */
  hasUsageData: boolean
}

export interface LedgerResult {
  state: CompanionState
  /** New tokens to apply to growth. Zero when this refresh contributes nothing. */
  delta: number
  /** Diagnostics worth logging; never shown to the user. */
  notes: string[]
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((a, b) => a + b, 0)
}

/**
 * Folds one observation into the ledger.
 *
 * `hasUsageData` only says a snapshot exists for display; the map holds providers whose date
 * was actually confirmed. A stale snapshot, or one carrying only `today == nil`, must not be
 * treated as an observation that can move the baseline.
 */
export function applyProviderLedger(
  previous: CompanionState,
  observation: LedgerObservation,
): LedgerResult {
  const { todayTokensByProvider, todayDate, hasUsageData } = observation
  const state: CompanionState = { ...previous }
  const notes: string[] = []

  const hasCurrentProviderData = hasUsageData && Object.keys(todayTokensByProvider).length > 0

  if (!state.installBaselineSet) {
    // Install baseline: taken from the first refresh that actually carries data, so prior
    // usage is not counted. Never taken from the empty refresh right after startup.
    if (!hasCurrentProviderData) return { state, delta: 0, notes }
    state.installBaselineSet = true
    state.claimedTodayTokensByProvider = { ...todayTokensByProvider }
    state.lastDate = todayDate
    return { state, delta: 0, notes }
  }

  // A refresh where only `today == nil` carriers remain, or where parsing failed, arrives
  // with an empty map. Letting that move the date or the ledger would make the next healthy
  // snapshot look like a whole day of brand-new usage.
  if (!hasCurrentProviderData) return { state, delta: 0, notes }

  if (state.claimedTodayTokensByProvider === undefined) {
    // An older save only had an aggregate high-water mark, which cannot be split per
    // provider. Store the first valid observation as the new ledger's baseline only, so past
    // usage is not retroactively granted.
    state.claimedTodayTokensByProvider = { ...todayTokensByProvider }
    state.lastDate = todayDate
    notes.push(
      `ledger seeded date=${todayDate} providers=${Object.keys(todayTokensByProvider).sort().join(',')}`,
    )
    return { state, delta: 0, notes }
  }

  if (todayDate !== state.lastDate) {
    // Snapshots from different days are not comparable, so the whole of today's cumulative
    // value counts as this day's usage rather than being diffed against yesterday.
    //
    // A provider known yesterday can be missing from the first refresh of a new day (no data
    // yet, a stale response, a transient failure). Dropping it from the ledger entirely would
    // mean that when it recovers later the same day, its current cumulative value gets seeded
    // as "already granted" and that usage is lost. So known providers are opened at 0 for the
    // new day; a recovered value then accrues as real usage, and a partial response later the
    // same day preserves this baseline.
    const newLedger: Record<string, number> = {}
    for (const providerID of Object.keys(state.claimedTodayTokensByProvider)) newLedger[providerID] = 0
    for (const [providerID, current] of Object.entries(todayTokensByProvider)) {
      newLedger[providerID] = current
    }
    state.claimedTodayTokensByProvider = newLedger
    state.lastDate = todayDate
    return { state, delta: sum(todayTokensByProvider), notes }
  }

  const ledger = { ...state.claimedTodayTokensByProvider }
  let delta = 0
  for (const [providerID, current] of Object.entries(todayTokensByProvider)) {
    const previousValue = ledger[providerID]
    if (previousValue === undefined) {
      // A newly observed provider's history is not back-paid. Seed the current value so its
      // increments are tracked from the next refresh onward.
      ledger[providerID] = current
      continue
    }
    if (current < previousValue) {
      // Rebase only this provider's line, not the aggregate. A provider that did not report
      // in this refresh has no line in the map at all, so its baseline is left untouched.
      ledger[providerID] = current
      notes.push(
        `usage regression provider=${providerID} date=${todayDate} previous=${previousValue} current=${current} drop=${previousValue - current} — rebased provider ledger`,
      )
      continue
    }
    delta += current - previousValue
    ledger[providerID] = current
  }
  state.claimedTodayTokensByProvider = ledger
  return { state, delta, notes }
}

// MARK: - Accrual days

/**
 * `yyyy-MM-dd` as a whole number of days.
 *
 * Parsed at UTC midnight on purpose. These strings are *local* calendar labels the ledger
 * already speaks (`todayKey`), and this function only ever subtracts two of them — reading
 * both at the same fixed offset makes the difference the calendar difference, with no second
 * notion of "day" and nothing for a DST boundary or a host timezone to move. Constructing a
 * local `new Date(...)` here would reintroduce exactly the divergence the ledger avoids.
 *
 * `undefined` for anything that is not the expected shape, so a hand-edited or legacy value
 * neither extends nor resets a streak.
 */
export function dayNumber(date: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) return undefined
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(utc) ? undefined : Math.round(utc / 86_400_000)
}

/** The recorded accrual days that fall inside the window ending at `today`, oldest first. */
export function accrualDaysWithin(days: readonly string[], today: string, windowDays: number): string[] {
  const end = dayNumber(today)
  if (end === undefined) return []
  return days
    .filter((day) => {
      const n = dayNumber(day)
      // A future day is kept rather than dropped: a clock that ran ahead once must not cost
      // the user the day they actually worked.
      return n !== undefined && end - n < windowDays
    })
    .sort()
}

/**
 * Records that usage really accrued on `date`.
 *
 * Called only from a fold that produced a positive delta, which is what makes this a record of
 * *work* rather than of the editor being open. Idempotent within a day — a day already present
 * is not added again, so however many refreshes land in it, it counts once.
 */
export function noteAccrualDay(state: CompanionState, date: string): CompanionState {
  if (dayNumber(date) === undefined) return state
  const kept = accrualDaysWithin(state.accrualDays, date, StreakBalance.windowDays)
  if (kept.includes(date)) {
    // Still write back when pruning actually removed something, so the array stays bounded
    // even for someone who works every single day.
    return kept.length === state.accrualDays.length ? state : { ...state, accrualDays: kept }
  }
  return { ...state, accrualDays: [...kept, date].sort() }
}

// MARK: - Legendary triggers

/**
 * One trigger firing. The caller turns each into its own toast, which is why the detail that
 * makes the copy worth reading travels with it.
 */
export type LegendaryAward = { kind: 'streak'; days: number } | { kind: 'milestone'; tokens: number }

export interface LegendaryTriggerResult {
  state: CompanionState
  /** Empty on almost every fold. One entry per trigger that fired. */
  awards: LegendaryAward[]
  notes: string[]
}

/**
 * Decides whether this fold earned any guaranteed-legendary encounters.
 *
 * The "decide" half of the reward; `grantLegendaryEncounter` is the "deliver" half and knows
 * nothing about either rule. Both triggers can fire in the same fold — a milestone crossed on
 * the third day of a streak — and each then owes its own legendary rather than one overwriting
 * the other. They are *entitlements*: the store delivers one per refresh, so the queue never
 * receives two at once and nothing is dropped to make that true.
 *
 * Evaluated only on a fold that accrued (see `update`). Rewards are earned by using the tools;
 * an idle refresh must not be able to tip either rule over on its own.
 */
export function applyLegendaryTriggers(state: CompanionState, today: string): LegendaryTriggerResult {
  let next = state
  const awards: LegendaryAward[] = []
  const notes: string[] = []

  // Streak. The two rules share this one count: three days inside the window, consecutive or
  // not (three consecutive days are three days inside seven, so the consecutive rule cannot
  // fire alone). One award per rolling window, whichever rule got there.
  const recent = accrualDaysWithin(next.accrualDays, today, StreakBalance.windowDays)
  const sinceAward = daysSinceStreakAward(next.lastStreakAwardDate, today)
  // A *future* award date (a clock that ran ahead, an imported save) reads as `undefined`
  // rather than blocking: otherwise one bad timestamp freezes the reward until the calendar
  // catches up with it.
  const windowClear = sinceAward === undefined || sinceAward >= StreakBalance.windowDays
  if (recent.length >= StreakBalance.days && windowClear) {
    next = { ...next, lastStreakAwardDate: today }
    awards.push({ kind: 'streak', days: recent.length })
    notes.push(`streak legendary earned days=${recent.join(',')}`)
  }

  // Milestone. The ratchet jumps to the multiple actually reached rather than stepping by one,
  // so a first scan (or an import) that crosses five at once awards exactly one — and the next
  // award needs a genuinely new milestone rather than replaying the four it skipped.
  const reached = Math.floor(Math.max(0, next.usedSinceInstall) / MilestoneBalance.tokens)
  if (reached > next.milestonesAwarded) {
    next = { ...next, milestonesAwarded: reached }
    awards.push({ kind: 'milestone', tokens: reached * MilestoneBalance.tokens })
    notes.push(`milestone legendary earned reached=${reached}`)
  }

  for (const _ of awards) next = grantLegendaryEncounter(next)
  return { state: next, awards, notes }
}

// MARK: - Streak, for display

/** What one dot of the streak row means. Style tokens; the label beside them is the text. */
export type StreakDay = 'off' | 'on' | 'award'

export interface StreakWindow {
  /** One entry per day of the rolling window, oldest first, ending today. */
  days: StreakDay[]
  /** Accrual days inside the window. Can exceed `StreakBalance.days` — the run keeps going. */
  count: number
  /** Days needed for the award, so the view never has to know the balance constant. */
  needed: number
  /**
   * Whether this window's legendary has already been earned. Computed from the *same* guard the
   * trigger uses, so the row cannot say "one more day" while the rule says the week is spent.
   */
  earned: boolean
}

/**
 * The rolling window as something to draw: one entry per day, oldest first.
 *
 * Here rather than in the panel builder (let alone the webview) because it is the streak rule
 * read backwards — the day set, the window width and the award guard are all in this file, and
 * a second implementation of "which days count" is exactly how an indicator starts disagreeing
 * with the thing it indicates.
 */
export function streakWindow(state: CompanionState, today: string): StreakWindow {
  const width = StreakBalance.windowDays
  const end = dayNumber(today)
  const sinceAward = daysSinceStreakAward(state.lastStreakAwardDate, today)
  const earned = sinceAward !== undefined && sinceAward < width
  if (end === undefined) {
    return {
      days: Array.from({ length: width }, () => 'off'),
      count: 0,
      needed: StreakBalance.days,
      earned,
    }
  }

  // Compared as day numbers rather than by formatting each column back into `yyyy-MM-dd`:
  // one parse per stored value, and no second date formatter to drift from `todayKey`.
  const accrued = new Set(
    accrualDaysWithin(state.accrualDays, today, width)
      .map(dayNumber)
      .filter((n): n is number => n !== undefined),
  )
  const awardDay = dayNumber(state.lastStreakAwardDate ?? '')
  const days: StreakDay[] = []
  for (let offset = width - 1; offset >= 0; offset--) {
    const day = end - offset
    days.push(accrued.has(day) ? (day === awardDay ? 'award' : 'on') : 'off')
  }
  return { days, count: accrued.size, needed: StreakBalance.days, earned }
}

/** Whole days from the last streak award to `today`; `undefined` when there is nothing to compare. */
function daysSinceStreakAward(lastAward: string | undefined, today: string): number | undefined {
  if (lastAward === undefined) return undefined
  const from = dayNumber(lastAward)
  const to = dayNumber(today)
  if (from === undefined || to === undefined) return undefined
  const since = to - from
  return since < 0 ? undefined : since
}

/**
 * Routes an accrued delta into either egg incubation or the active Pokémon's growth meter.
 * Growth itself (evolution, graduation) is handled separately in `growth.ts`.
 */
export function creditDelta(state: CompanionState, delta: number): CompanionState {
  if (delta <= 0) return state
  const next: CompanionState = { ...state, usedSinceInstall: state.usedSinceInstall + delta }
  if (next.active === undefined) {
    next.eggUsage = next.eggUsage + delta
  } else {
    next.active = { ...next.active, usedAtStage: next.active.usedAtStage + delta }
  }
  return next
}

/** Spendable currency: what has been used, minus what has been spent in the shop. */
export function spendableBalance(state: CompanionState): number {
  return Math.max(0, state.usedSinceInstall - state.spentTokens)
}
