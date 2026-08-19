/** Display state and hatching decisions. */

import {
  type CompanionState,
  type CompanionStateKind,
  PokemonBalance,
  PokemonOdds,
  ShinyCharm,
} from './model.js'
import type { RNG } from './growth.js'
import { ownsShinyCharm } from './shop.js'

/** Burn-rate tier. */
export type BurnTier = 'idle' | 'normal' | 'fast' | 'blazing'

export interface DisplayInputs {
  burnTier: BurnTier
  limitWarning: boolean
  hasUsageData: boolean
  todayTokens: number
  /** True while a hatch/evolve/graduate celebration window is open. */
  eventActive: boolean
}

export function computeDisplayState(state: CompanionState, inputs: DisplayInputs): CompanionStateKind {
  if (state.active === undefined) return 'egg'
  if (inputs.eventActive) return 'levelUp'
  if (inputs.limitWarning) return 'tired'
  if (!inputs.hasUsageData || inputs.todayTokens === 0) return 'sleep'
  switch (inputs.burnTier) {
    case 'idle':
      return 'idle'
    case 'normal':
      return 'working'
    case 'fast':
    case 'blazing':
      return 'focus'
  }
}

// MARK: - Egg progress

export function isEgg(state: CompanionState): boolean {
  return state.active === undefined
}

export function eggProgress(state: CompanionState): number {
  return Math.min(1, Math.max(0, state.eggUsage / PokemonBalance.eggHatchThreshold))
}

export function eggTokensToHatch(state: CompanionState): number {
  return Math.max(0, PokemonBalance.eggHatchThreshold - state.eggUsage)
}

export function eggReadyToHatch(state: CompanionState): boolean {
  return isEgg(state) && state.eggUsage >= PokemonBalance.eggHatchThreshold
}

// MARK: - Hatch rolls

/**
 * Shiny is decided at the moment of hatching and never retroactively. Holding the Shiny Charm
 * lowers the denominator from 1/64 to 1/48; a Pokémon already hatched is unaffected.
 */
export function rollShiny(state: CompanionState, rng: RNG): boolean {
  const denominator = ownsShinyCharm(state) ? ShinyCharm.shinyDenominator : PokemonOdds.shinyDenominator
  return rng() % denominator === 0
}

/**
 * Ditto only disguises itself as a **common** line with two or more forms — the reveal needs
 * a first evolution threshold to fire at, so a single-form line has nowhere to spring it.
 */
export function rollDittoDisguise(
  rarity: string,
  totalForms: number,
  enabled: boolean,
  rng: RNG,
): boolean {
  if (!enabled) return false
  if (rarity !== 'common' || totalForms < 2) return false
  return rng() % PokemonOdds.dittoDisguiseDenominator === 0
}
