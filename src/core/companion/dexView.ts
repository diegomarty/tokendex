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
import { registrationPercent } from './registry.js'

/** Shininess stays hidden while a Ditto is disguised; the reveal is what discloses it. */
export function currentIsShiny(mon: MonState | undefined): boolean {
  if (mon === undefined) return false
  if (mon.dittoDisguise !== undefined && !mon.dittoRevealed) return false
  return mon.isShiny
}

/**
 * The forms the companion really holds: the one on stage, and the earlier ones of its road the
 * registry has obtained. `pathIDs` also carries the line's forms *before* a companion chosen at
 * an evolved stage (a wild Charmeleon), to price its stage — never obtained, so never owned
 * (code review 9.12 #1).
 */
export function reachedForms(state: CompanionState, mon: MonState): number[] {
  const reached = mon.pathIDs.slice(0, mon.stageIndex + 1)
  const current = reached[reached.length - 1]
  return reached.filter((id) => id === current || state.species[id]?.unlocked === true)
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
    chainOrder: reachedForms(state, active),
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
  /** The registry's state: how far the species is, and its shiny form. Flags, never xp. */
  status: 'seen' | 'unlocked' | 'registered'
  shiny: 'none' | 'unlocked' | 'registered'
  /** 0..100 of the registration bar. */
  percent: number
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
    for (const id of reachedForms(state, active)) {
      const a = acc.get(id) ?? { rarity: active.rarity, isShiny: false, isGraduated: false }
      const names = line?.names[id]
      if (names !== undefined) a.names = names
      if (currentIsShiny(active)) a.isShiny = true // same hidden-while-disguised rule
      acc.set(id, a)
    }
  }

  // Every species the registry knows, including those only seen in the wild — which have no
  // dex entry and no name yet, so they show by number. A species the dex shows but the registry
  // has not seeded is owned all the same: it reads unlocked at 0%.
  for (const [key, progress] of Object.entries(state.species)) {
    if (!progress.seen && !progress.unlocked && !progress.registered) continue
    const id = Number(key)
    if (!acc.has(id)) {
      acc.set(id, {
        rarity: progress.lineRarity ?? 'common',
        isShiny: false,
        // Not raising: a registry entry is permanent, the cell never disappears.
        isGraduated: true,
      })
    }
  }

  return [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, a]) => {
      const progress = state.species[id]
      const status: DexSpecies['status'] =
        progress === undefined
          ? 'unlocked'
          : progress.registered
            ? 'registered'
            : progress.unlocked || !progress.seen
              ? 'unlocked'
              : 'seen'
      const shiny: DexSpecies['shiny'] =
        progress?.shinyRegistered === true
          ? 'registered'
          : progress?.shinyUnlocked === true
            ? 'unlocked'
            : 'none'
      return {
        id,
        name: (a.names === undefined ? undefined : resolveName(lang, a.names)) ?? `#${id}`,
        rarity: a.rarity,
        isShiny: a.isShiny,
        isRaising: !a.isGraduated,
        status,
        shiny,
        percent: progress === undefined ? 0 : registrationPercent(progress),
      }
    })
}

/**
 * The species Pokédex's two counts: what is owned (the collection — a seen species is not) and
 * what is registered (the completion). One pass, so the two can never disagree with the list.
 */
export function dexTally(species: readonly Pick<DexSpecies, 'status' | 'shiny'>[]): {
  owned: number
  registered: number
  shinyRegistered: number
} {
  let owned = 0
  let registered = 0
  let shinyRegistered = 0
  for (const sp of species) {
    if (sp.status !== 'seen') owned++
    if (sp.status === 'registered') registered++
    // What the Shinydex shows: every shiny obtained, its bar full or not.
    if (sp.shiny !== 'none') shinyRegistered++
  }
  return { owned, registered, shinyRegistered }
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
