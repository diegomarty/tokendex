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
  PokemonOdds,
  currentSpeciesID,
  RareCandy,
  freshSpeciesProgress,
  type CompanionState,
  type MonState,
  type Rarity,
  type SpeciesProgress,
  type WildLine,
} from './model.js'

/** Tokens that register a species at `stageIndex` of a `totalForms`-form line of `rarity`. */
export function registerXP(rarity: Rarity, totalForms: number, stageIndex: number): number {
  return PokemonBalance.phaseThreshold(rarity, totalForms, stageIndex)
}

/**
 * 0..100. A registered species reads 100 whatever its xp says (the flag is the truth); before
 * the threshold is known there is nothing to measure against, so it reads the share owed (a
 * catch's) rather than a guess.
 */
export function registrationPercent(progress: SpeciesProgress): number {
  if (progress.registered) return 100
  if (progress.threshold === undefined || progress.threshold <= 0) {
    return Math.min(100, Math.floor(100 * (progress.pendingShare ?? 0)))
  }
  return Math.min(100, Math.floor((100 * progress.xp) / progress.threshold))
}

/**
 * What a species' shiny bar costs: eight times its LINE's whole total, for every form (C5) —
 * not eight times its stage, which would make Charmander's shiny 67M. Common 400M, uncommon 1B,
 * rare 1.6B, legendary 3.2B.
 */
export function shinyTarget(lineRarity: Rarity): number {
  return 8 * PokemonBalance.graduationTotal(lineRarity)
}

/**
 * A shiny obtained — caught or hatched — completes its species' shiny bar at once (C5): the
 * shiny is registered, and the bar reads full when the line's rarity says how full is full.
 */
export function obtainShiny(progress: SpeciesProgress): SpeciesProgress {
  const next: SpeciesProgress = { ...progress, shinyUnlocked: true, shinyRegistered: true }
  if (progress.lineRarity !== undefined) next.shinyXP = shinyTarget(progress.lineRarity)
  return next
}

/**
 * Registers a species' shiny — caught, hatched, boosted to full, or the dev shortcut: the flags
 * and the bar (`obtainShiny`), and the companion on stage wears it when it is that species. The
 * one path, so no caller dresses a companion another would not. A Ditto in disguise is never
 * dressed: the species it shows is not its own, and dressing it would leak the disguise.
 */
export function registerShiny(state: CompanionState, speciesID: number): CompanionState {
  const next: CompanionState = {
    ...state,
    species: { ...state.species, [speciesID]: obtainShiny(progressOf(state, speciesID)) },
  }
  const active = state.active
  const disguised = active?.dittoDisguise !== undefined && active.dittoRevealed !== true
  if (active !== undefined && !disguised && currentSpeciesID(active) === speciesID) {
    next.active = { ...active, isShiny: true }
  }
  return next
}

/**
 * Experience a share of a bar is worth, rounded **up**: rounded to nearest, 5% of 16_666_667
 * lands a token short and `registrationPercent`'s floor reads 4%.
 */
export function shareXP(share: number, threshold: number): number {
  return Math.ceil(share * threshold)
}

/**
 * Where a companion's stage meter starts on a species: where its bar already is. One rule for
 * `setCompanion` and for the growth that settles a hatch or an evolution — the meter never lags
 * the bar.
 */
export function meterStart(progress: SpeciesProgress, threshold: number): number {
  return Math.min(progress.xp, threshold)
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

/**
 * Records who the companion was on its current species before it leaves the stage — its nature
 * and whether it is shiny — so choosing that species again rebuilds the same Pokémon rather than
 * a fresh roll. No-op without a companion.
 */
export function retireCompanion(state: CompanionState): CompanionState {
  const mon = state.active
  if (mon === undefined) return state
  if (mon.dittoDisguise !== undefined && !mon.dittoRevealed) return retireDisguise(state, mon)
  const id = currentSpeciesID(mon)
  const current = progressOf(state, id)
  const next: SpeciesProgress = { ...current }
  if (mon.nature !== undefined) next.nature = mon.nature
  if (mon.isShiny) {
    next.shinyUnlocked = true
    next.companionShiny = true
  }
  return { ...state, species: { ...state.species, [id]: next } }
}

/**
 * A Ditto leaving the stage still in disguise is revealed on the way out (code review 9.12 #4),
 * by the reveal's own rules (`applyUsage`): this life's experience moves to Ditto, the shown
 * species keeps only what was its own — and its unlock only if the hatch did not give it — and
 * the nature and a shiny are Ditto's. Recorded as the species it showed, a shiny disguise used
 * to leave that species shiny, a Pokémon the player never had, and the Ditto itself was gone.
 */
function retireDisguise(state: CompanionState, mon: MonState): CompanionState {
  const shown = currentSpeciesID(mon)
  const prior = progressOf(state, shown)
  const moved = Math.min(prior.xp, mon.usedAtStage)
  const left = prior.xp - moved
  const onlyByDisguise =
    mon.disguiseUnlocked === true && left === 0 && prior.caught === 0 && !prior.registered
  const ditto = progressOf(state, PokemonOdds.dittoSpeciesID)
  let revealed: SpeciesProgress = { ...ditto, xp: ditto.xp + moved, unlocked: true }
  if (mon.nature !== undefined) revealed.nature = mon.nature
  if (mon.isShiny) revealed = { ...obtainShiny(revealed), companionShiny: true }
  return {
    ...state,
    species: {
      ...state.species,
      [shown]: { ...prior, xp: left, unlocked: prior.unlocked && !onlyByDisguise },
      [PokemonOdds.dittoSpeciesID]: revealed,
    },
  }
}

/**
 * Every shiny the Pokédex holds, registered (C5: a shiny obtained has its bar full). A shiny
 * caught or raised before the shiny bar existed left a shiny entry the registry never recorded
 * — Diego's Vulpix — so the Shinydex left it out and counted 0. The very same state when there
 * is nothing to add, so reading a consistent save rewrites nothing.
 */
export function reconcileShinies(state: CompanionState): CompanionState {
  let species: CompanionState['species'] | undefined
  for (const entry of state.dex) {
    if (!entry.isShiny) continue
    for (const id of entry.chainOrder) {
      const progress = (species ?? state.species)[id] ?? freshSpeciesProgress()
      if (progress.shinyRegistered === true) continue
      species ??= { ...state.species }
      species[id] = obtainShiny({ ...progress, unlocked: true })
    }
  }
  return species === undefined ? state : { ...state, species }
}

/**
 * Marks a species as met in the wild. With the encounter's `line` (an index with forms), it also
 * records where the species sits and its line's rarity — the Pokédex knows what it saw, and a
 * lure has something to price — without obtaining it. Idempotent.
 */
export function markSeen(state: CompanionState, speciesID: number, line?: WildLine): CompanionState {
  const current = progressOf(state, speciesID)
  const position = line !== undefined && current.lineRarity === undefined
  if (current.seen && !position) return state
  const next: SpeciesProgress = { ...current, seen: true }
  if (position) {
    next.baseID = line.baseID
    next.stageIndex = line.stageIndex
    next.totalForms = line.totalForms
    next.lineRarity = line.rarity
  }
  return { ...state, species: { ...state.species, [speciesID]: next } }
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
