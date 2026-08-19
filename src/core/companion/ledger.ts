/**
 * Per-provider accrual ledger.
 *
 * This decides how many *new* tokens a refresh contributes to growth. It is dense with
 * defect prevention, and each branch below exists because a specific way of getting it wrong
 * either lost usage or granted it twice. Extracted as a pure function so every branch is
 * reachable from a test.
 */

import type { CompanionState } from './model.js'

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
