/**
 * Derived views for the Pokédex, the catch log and the evolution-line strip.
 *
 * Pure, so every rule below is reachable from a test — including the ones that are easy to
 * get subtly wrong (planned versus reached species, hidden shininess while a Ditto is
 * disguised, branch previews).
 */

import {
  type AppLanguage,
  type CompanionState,
  type DexEntry,
  type EvoLine,
  type EvoLineItem,
  type EvoNode,
  type MonState,
  type Rarity,
  currentSpeciesID,
  evoNodeWithID,
  localizedName,
  resolveName,
} from './model.js'

/** Shininess stays hidden while a Ditto is disguised; the reveal is what discloses it. */
export function currentIsShiny(mon: MonState | undefined): boolean {
  if (mon === undefined) return false
  if (mon.dittoDisguise !== undefined && !mon.dittoRevealed) return false
  return mon.isShiny
}

export function isFinalStage(mon: MonState, line: EvoLine | undefined): boolean {
  if (line === undefined) return false
  return (evoNodeWithID(line.tree, currentSpeciesID(mon))?.children.length ?? 0) === 0
}

// MARK: - Evolution line strip

export function realizedLineItems(pathIDs: number[], stageIndex: number): EvoLineItem[] {
  return pathIDs.map((id, i) => ({
    content: { kind: 'species', id },
    state: i === stageIndex ? 'current' : 'done',
  }))
}

/**
 * The realised path plus a preview of what comes next.
 *
 * A run of single-child steps is shown outright, because it is already determined. As soon as
 * a branch appears, the candidates collapse into **one** mystery slot — the branch was chosen
 * at hatch, but revealing it before the evolution happens would spoil it.
 */
export function lineItems(mon: MonState | undefined, line: EvoLine | undefined): EvoLineItem[] {
  if (mon === undefined || line === undefined) return []
  const out = realizedLineItems(mon.pathIDs, mon.stageIndex)

  const start = evoNodeWithID(line.tree, currentSpeciesID(mon))
  if (start === undefined) return out

  const guaranteed: EvoNode[] = []
  let node: EvoNode = start
  while (node.children.length === 1) {
    const child: EvoNode = node.children[0] as EvoNode
    guaranteed.push(child)
    node = child
  }
  for (const step of guaranteed) {
    out.push({ content: { kind: 'species', id: step.speciesID }, state: 'future' })
  }
  if (node.children.length > 1) {
    out.push({ content: { kind: 'mystery' }, state: 'future' })
  }
  return out
}

// MARK: - Catch log

/**
 * The Pokémon being raised is shown alongside permanently saved graduates, but is synthesised
 * rather than written into the persisted dex. On graduation the active one disappears and a
 * real entry appears, so the list length never jumps.
 */
export function activeDexEntry(state: CompanionState, line: EvoLine | undefined): DexEntry | undefined {
  const active = state.active
  if (active === undefined) return undefined
  const finalID = currentSpeciesID(active)
  const entry: DexEntry = {
    id: `active-${active.baseID}-${finalID}`,
    baseID: active.baseID,
    finalID,
    chainOrder: active.pathIDs,
    rarity: active.rarity,
    isShiny: currentIsShiny(active),
  }
  if (active.nature !== undefined) entry.nature = active.nature
  if (line !== undefined) {
    const names: Record<number, Record<string, string>> = {}
    for (const id of active.pathIDs) {
      const byLang = line.names[id]
      if (byLang !== undefined) names[id] = byLang
    }
    entry.names = names
  }
  return entry
}

/**
 * Display order for the catch log: the Pokémon being raised pinned first, then graduates by
 * **most recently caught**.
 *
 * Rarity used to sort first, which is the *Pokédex*'s rule. A log is a chronological record,
 * so grouping by rarity buried a Pokémon that just graduated under a rarer one caught days
 * ago. Narrowing by rarity is the filter's job now.
 */
export function dexEntriesSorted(state: CompanionState, line: EvoLine | undefined): DexEntry[] {
  // Entries with no caughtAt are older saves; they sort last, among themselves unordered.
  const graduated = [...state.dex].sort((a, b) => (b.caughtAt ?? 0) - (a.caughtAt ?? 0))
  const active = activeDexEntry(state, line)
  return active === undefined ? graduated : [active, ...graduated]
}

// MARK: - Species Pokédex

export interface DexSpecies {
  id: number
  name: string
  rarity: Rarity
  /** Whether this species has ever been held as a shiny. */
  isShiny: boolean
  /**
   * This cell exists only because of the Pokémon currently being raised — nothing has
   * graduated yet, so it is not permanent. Buying a fresh egg discards that Pokémon (the dex
   * is untouched) and the cell disappears; a Ditto reveal removes the species it was
   * disguised as. Without a marker, a shrinking species count would look like a defect.
   */
  isRaising: boolean
}

/** One species' accumulation. A single record avoids parallel maps whose key sets can drift. */
interface Accumulator {
  /** Fixed on first sight — the same species always comes from the same base line. */
  rarity: Rarity
  names?: Record<string, string>
  isShiny: boolean
  /** True once it came from a graduation, meaning the species is permanent. */
  isGraduated: boolean
}

/**
 * Owned species only, in Pokédex order.
 *
 * Included = graduated `chainOrder` plus the active Pokémon's **reached** species,
 * `pathIDs[0..stageIndex]`. `plannedPathIDs` is never used: it contains stages not yet
 * reached, and using it would list species that have not evolved yet as owned.
 */
export function dexSpecies(
  state: CompanionState,
  line: EvoLine | undefined,
  lang: AppLanguage = state.language,
): DexSpecies[] {
  const acc = new Map<number, Accumulator>()

  for (const entry of state.dex) {
    for (const id of entry.chainOrder) {
      const a = acc.get(id) ?? { rarity: entry.rarity, isShiny: false, isGraduated: false }
      // Guarded so an older, name-less entry cannot overwrite names already found.
      const names = entry.names?.[id]
      if (names !== undefined) a.names = names
      if (entry.isShiny) a.isShiny = true
      a.isGraduated = true
      acc.set(id, a)
    }
  }

  const active = state.active
  if (active !== undefined) {
    // Reached stages only. `stageIndex` is guaranteed in range by both entry points:
    // decoding clamps it, and importing a save normalises it.
    for (const id of active.pathIDs.slice(0, active.stageIndex + 1)) {
      const a = acc.get(id) ?? { rarity: active.rarity, isShiny: false, isGraduated: false }
      const names = line?.names[id]
      if (names !== undefined) a.names = names
      if (currentIsShiny(active)) a.isShiny = true // same hidden-while-disguised rule
      acc.set(id, a)
    }
  }

  return [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, a]) => ({
      id,
      name: (a.names === undefined ? undefined : resolveName(lang, a.names)) ?? `#${id}`,
      rarity: a.rarity,
      isShiny: a.isShiny,
      isRaising: !a.isGraduated,
    }))
}

/** Catch-log counts by rarity, per individual. The species Pokédex uses `dexSpecies`. */
export function dexCount(state: CompanionState, line: EvoLine | undefined, rarity: Rarity): number {
  return dexEntriesSorted(state, line).filter((e) => e.rarity === rarity).length
}

/** Resolves a catch-log entry's display name without a network call when possible. */
export function entryName(entry: DexEntry, lang: AppLanguage, line: EvoLine | undefined): string {
  const stored = entry.names?.[entry.finalID]
  const resolved = stored === undefined ? undefined : resolveName(lang, stored)
  if (resolved !== undefined) return resolved
  if (line !== undefined) return localizedName(line, entry.finalID, lang)
  return `#${entry.finalID}`
}
