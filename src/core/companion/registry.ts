/**
 * Registration per species: the Pokédex as a set of bars, one per species, filled by the
 * experience the companion earns while it *is* that species.
 *
 * Pure. The rules worth stating:
 *
 *  - **What a bar costs** is the species' stage threshold inside its line (`registerXP`), the
 *    same number that evolves the companion — one bar, one meaning. The thresholds of a line sum
 *    to its `graduationTotal`, so registering every form of a line costs what graduating it did.
 *  - **The threshold needs the line**, which is network. Until it is known, xp accrues raw, the
 *    percentage is clamped, and nothing is marked registered. `registered` and the other states
 *    are **flags**: they only ever turn on, so a merge or a migration can add to the Pokédex and
 *    never take from it.
 *  - **Migration is flags and zeros** (`seedRegistry`): every species a save already had is
 *    unlocked at 0%, the companion's stage progress restarts, and the wallet and the catch
 *    history are untouched. No threshold, no network, nothing retroactive.
 */

import {
  PokemonBalance,
  RareCandy,
  freshSpeciesProgress,
  type CompanionState,
  type MonState,
  type Rarity,
  type SpeciesProgress,
} from './model.js'

/** Tokens that register a species at `stageIndex` of a `totalForms`-form line of `rarity`. */
export function registerXP(rarity: Rarity, totalForms: number, stageIndex: number): number {
  return PokemonBalance.phaseThreshold(rarity, totalForms, stageIndex)
}

/**
 * 0..100. A registered species reads 100 whatever its xp says (the flag is the truth); before
 * the threshold is known there is nothing to measure against, so it reads 0 rather than a
 * guess.
 */
export function registrationPercent(progress: SpeciesProgress): number {
  if (progress.registered) return 100
  if (progress.threshold === undefined || progress.threshold <= 0) return 0
  return Math.min(100, Math.floor((100 * progress.xp) / progress.threshold))
}

/** What one Rare Candy is worth to this companion: a share of its current stage. */
export function rareCandyXP(mon: MonState): number {
  return Math.round(
    RareCandy.stageShare * PokemonBalance.phaseThreshold(mon.rarity, mon.totalForms, mon.stageIndex),
  )
}

/**
 * Credits `delta` of experience to a species, raw: no threshold is consulted, so this is what a
 * fold or a merge calls before the growth rules settle it (`applyUsage`). Unlocks the species.
 */
export function creditSpeciesXP(state: CompanionState, speciesID: number, delta: number): CompanionState {
  if (delta <= 0) return state
  const current = progressOf(state, speciesID)
  return {
    ...state,
    species: { ...state.species, [speciesID]: { ...current, xp: current.xp + delta, unlocked: true } },
  }
}

/** Every species the player has obtained — what the branch and spawn rules steer away from. */
export function unlockedSpecies(state: CompanionState): Set<number> {
  const out = new Set<number>()
  for (const [id, progress] of Object.entries(state.species)) {
    if (progress.unlocked) out.add(Number(id))
  }
  return out
}

/** The species' entry, or a fresh one — never mutates the map. */
export function progressOf(state: CompanionState, speciesID: number): SpeciesProgress {
  return state.species[speciesID] ?? freshSpeciesProgress()
}

/** Marks a species as obtained. Idempotent; keeps everything else it had. */
export function unlockSpecies(state: CompanionState, speciesID: number): CompanionState {
  const current = progressOf(state, speciesID)
  if (current.unlocked) return state
  return { ...state, species: { ...state.species, [speciesID]: { ...current, unlocked: true } } }
}

/** Marks a species as met in the wild. Idempotent. */
export function markSeen(state: CompanionState, speciesID: number): CompanionState {
  const current = progressOf(state, speciesID)
  if (current.seen) return state
  return { ...state, species: { ...state.species, [speciesID]: { ...current, seen: true } } }
}

/**
 * Seeds the registry for a save from before it existed, from what the save already shows:
 * every form of every Pokédex entry, every collected final and every form the companion has
 * been. All unlocked at zero. Called only when the `species` key is absent — a save that has
 * the key, even empty, has already been seeded.
 */
export function seedRegistry(state: CompanionState): CompanionState {
  const species: Record<number, SpeciesProgress> = {}
  const unlock = (id: number) => {
    if (!Number.isInteger(id) || id <= 0) return
    species[id] = { ...(species[id] ?? freshSpeciesProgress()), unlocked: true }
  }
  for (const entry of state.dex) {
    for (const id of entry.chainOrder) unlock(id)
    unlock(entry.finalID)
  }
  for (const key of state.collectedFinals) {
    const [base, final] = key.split(':').map(Number)
    if (base !== undefined) unlock(base)
    if (final !== undefined) unlock(final)
  }
  const next: CompanionState = { ...state, species }
  if (state.active !== undefined) {
    for (const id of state.active.pathIDs) unlock(id)
    unlock(state.active.baseID)
    next.active = { ...state.active, usedAtStage: 0 }
  }
  return next
}
