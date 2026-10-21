/**
 * Eggs: one free a day, up to three in stock, and one incubating at a time. Pure.
 *
 * Incubating is a companion choice: the stage shows the egg, the companion steps aside, and
 * nothing of its progress is lost — that lives in the registry. Choosing a companion back
 * *pauses* the egg (its usage and its guarantee stay); `incubateEgg` resumes it before it
 * ever spends the stock.
 */

import { EGG_STOCK_MAX, type CompanionState } from './model.js'
import { retireCompanion } from './registry.js'

/** One egg per day with real usage, never past the stock's capacity. Idempotent within a day. */
export function grantDailyEgg(state: CompanionState, day: string): CompanionState {
  const stock = state.eggStock
  if (stock.lastGrantDay === day) return state
  return {
    ...state,
    eggStock: { count: Math.min(EGG_STOCK_MAX, stock.count + 1), lastGrantDay: day },
  }
}

export type IncubateOutcome = 'started' | 'resumed' | 'alreadyIncubating' | 'noEggs'

/**
 * Nothing obtained yet and no egg under way: the game is waiting for its starter. The one
 * definition — the panel's starter screen, the store's `chooseStarter` gate, the ledger and the
 * shop all read it, so they can never disagree about whether the game has begun.
 *
 * *Obtained*, not merely present: wild encounters still spawn on a new game and mark species as
 * seen, and seeing a Pokémon is not having started.
 */
export function isFreshGame(state: CompanionState): boolean {
  return (
    !Object.values(state.species).some((p) => p.unlocked) &&
    state.active === undefined &&
    !eggHasProgress(state)
  )
}

/** Usage, a pre-roll or a paid guarantee: anything that would be lost by starting a fresh egg. */
export function eggHasProgress(state: CompanionState): boolean {
  return state.eggUsage > 0 || state.pendingHatchID !== undefined || state.eggTier !== undefined
}

/** An egg is the one on stage: no companion, and the game has begun. */
export function eggOnStage(state: CompanionState): boolean {
  return state.active === undefined && !isFreshGame(state)
}

/** An egg is paused when a companion is on stage while one has progress. */
export function eggIsPaused(state: CompanionState): boolean {
  return state.active !== undefined && eggHasProgress(state)
}

/**
 * Takes the egg on stage off it, for a companion about to step on. One with progress is paused
 * and kept; one with none goes back to the stock it came from, so setting an egg aside before
 * it earned anything never costs the egg.
 */
export function setEggAside(state: CompanionState): CompanionState {
  if (!eggOnStage(state) || eggHasProgress(state)) return state
  return {
    ...state,
    eggStock: { ...state.eggStock, count: Math.min(EGG_STOCK_MAX, state.eggStock.count + 1) },
  }
}

export function canIncubate(state: CompanionState): boolean {
  return state.active !== undefined && (eggIsPaused(state) || state.eggStock.count > 0)
}

/**
 * Puts an egg on the stage: the paused one if there is one, else one from the stock. The
 * companion stepping off is retired first (`retireCompanion`), so it comes back as itself.
 */
export function incubateEgg(state: CompanionState): { state: CompanionState; outcome: IncubateOutcome } {
  if (state.active === undefined) return { state, outcome: 'alreadyIncubating' }
  if (eggIsPaused(state)) {
    const next = retireCompanion(state)
    delete next.active
    return { state: next, outcome: 'resumed' }
  }
  if (state.eggStock.count <= 0) return { state, outcome: 'noEggs' }
  const next: CompanionState = {
    ...retireCompanion(state),
    eggUsage: 0,
    eggStock: { ...state.eggStock, count: state.eggStock.count - 1 },
  }
  delete next.active
  delete next.eggTier
  delete next.pendingHatchID
  return { state: next, outcome: 'started' }
}
