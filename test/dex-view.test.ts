import { describe, expect, it } from 'vitest'
import {
  currentIsShiny,
  dexEntriesSorted,
  dexSpecies,
  dexTally,
  entryName,
  isFinalStage,
  lineItems,
  reachedForms,
  realizedLineItems,
} from '../src/core/companion/dexView.js'
import {
  type CompanionState,
  type DexEntry,
  type EvoNode,
  type MonState,
  type SpeciesProgress,
  freshCompanionState,
  freshSpeciesProgress,
  makeEvoLine,
} from '../src/core/companion/model.js'

const node = (id: number, children: EvoNode[] = []): EvoNode => ({ speciesID: id, children })
const sp = (over: Partial<SpeciesProgress>): SpeciesProgress => ({ ...freshSpeciesProgress(), ...over })

const mon = (over: Partial<MonState> = {}): MonState => ({
  baseID: 1,
  pathIDs: [1],
  plannedPathIDs: [1, 2, 3],
  stageIndex: 0,
  usedAtStage: 0,
  rarity: 'common',
  totalForms: 3,
  isShiny: false,
  dittoRevealed: false,
  ...over,
})

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

const dexEntry = (over: Partial<DexEntry> = {}): DexEntry => ({
  id: 'g1',
  baseID: 1,
  finalID: 3,
  chainOrder: [1, 2, 3],
  rarity: 'rare',
  isShiny: false,
  ...over,
})

describe('currentIsShiny', () => {
  // A disguised Ditto must not leak that it is shiny before the reveal.
  it('hides shininess while a Ditto is disguised', () => {
    expect(currentIsShiny(mon({ isShiny: true, dittoDisguise: 132, dittoRevealed: false }))).toBe(false)
    expect(currentIsShiny(mon({ isShiny: true, dittoDisguise: 132, dittoRevealed: true }))).toBe(true)
    expect(currentIsShiny(mon({ isShiny: true }))).toBe(true)
  })
})

describe('evolution line strip', () => {
  it('marks the realised path with the current stage', () => {
    expect(realizedLineItems([1, 2, 3], 1).map((i) => i.state)).toEqual(['done', 'current', 'done'])
  })

  it('shows a determined single-child run outright', () => {
    const line = makeEvoLine(1, node(1, [node(2, [node(3)])]), 'common', {})
    const items = lineItems(mon({ pathIDs: [1], stageIndex: 0 }), line)
    expect(items.map((i) => (i.content.kind === 'species' ? i.content.id : 'mystery'))).toEqual([1, 2, 3])
    expect(items.map((i) => i.state)).toEqual(['current', 'future', 'future'])
  })

  // The branch was chosen at hatch, but revealing it before the evolution happens spoils it.
  it('collapses a branch into a single mystery slot', () => {
    const line = makeEvoLine(1, node(1, [node(2), node(4)]), 'common', {})
    const items = lineItems(mon({ pathIDs: [1], stageIndex: 0, plannedPathIDs: [1, 4] }), line)
    expect(items).toHaveLength(2)
    expect(items[1]?.content.kind).toBe('mystery')
  })

  it('shows the determined prefix before the mystery', () => {
    // 1 -> 2 -> {3, 5}: step 2 is certain, what follows is not.
    const line = makeEvoLine(1, node(1, [node(2, [node(3), node(5)])]), 'common', {})
    const items = lineItems(mon({ pathIDs: [1], stageIndex: 0 }), line)
    expect(items.map((i) => (i.content.kind === 'species' ? i.content.id : 'mystery'))).toEqual([
      1,
      2,
      'mystery',
    ])
  })

  it('adds nothing beyond a final form', () => {
    const line = makeEvoLine(1, node(1), 'common', {})
    expect(lineItems(mon({ pathIDs: [1], stageIndex: 0 }), line)).toHaveLength(1)
  })

  it('is empty without a Pokémon or a line', () => {
    expect(lineItems(undefined, undefined)).toEqual([])
    expect(lineItems(mon(), undefined)).toEqual([])
  })

  it('detects the final stage', () => {
    const branching = makeEvoLine(1, node(1, [node(2)]), 'common', {})
    expect(isFinalStage(mon({ pathIDs: [1], stageIndex: 0 }), branching)).toBe(false)
    expect(isFinalStage(mon({ pathIDs: [1, 2], stageIndex: 1 }), branching)).toBe(true)
  })
})

describe('catch log', () => {
  const line = makeEvoLine(1, node(1, [node(2)]), 'common', { 1: { en: 'Base' }, 2: { en: 'Evo' } })

  // [trigger branch] Diego: choosing a companion put it in the catch log, as a "Raising" row
  // pinned on top. The log records what happened — catches and graduations — newest first; the
  // companion on stage is the scene's and the Pokédex's, not a record.
  it('lists only records, newest first, never the companion on stage', () => {
    const s = state({
      active: mon(),
      dex: [dexEntry({ id: 'old', caughtAt: 1000 }), dexEntry({ id: 'new', caughtAt: 5000 })],
    })
    expect(dexEntriesSorted(s, line).map((e) => e.id)).toEqual(['new', 'old'])
  })

  // Grouping by rarity first would bury a just-graduated Pokémon under a rarer, older one.
  it('does not order the log by rarity', () => {
    const s = state({
      dex: [
        dexEntry({ id: 'commonRecent', rarity: 'common', caughtAt: 9000 }),
        dexEntry({ id: 'legendaryOld', rarity: 'legendary', caughtAt: 100 }),
      ],
    })
    expect(dexEntriesSorted(s, line)[0]?.id).toBe('commonRecent')
  })

  it('sorts entries with no caughtAt last', () => {
    const s = state({ dex: [dexEntry({ id: 'legacy' }), dexEntry({ id: 'dated', caughtAt: 10 })] })
    expect(dexEntriesSorted(s, line).map((e) => e.id)).toEqual(['dated', 'legacy'])
  })

  it('names an entry from its stored names, falling back to the line then the number', () => {
    expect(entryName(dexEntry({ finalID: 2, names: { 2: { en: 'Evo' } } }), 'en', undefined)).toBe('Evo')
    expect(entryName(dexEntry({ finalID: 2 }), 'en', line)).toBe('Evo')
    expect(entryName(dexEntry({ finalID: 99 }), 'en', undefined)).toBe('#99')
  })
})

describe('species pokédex', () => {
  const line = makeEvoLine(1, node(1, [node(2, [node(3)])]), 'common', {
    1: { en: 'Base' },
    2: { en: 'Mid' },
    3: { en: 'Final' },
  })

  it('lists every species of a graduated chain, in number order', () => {
    const s = state({ dex: [dexEntry({ chainOrder: [3, 1, 2] })] })
    expect(dexSpecies(s, line).map((x) => x.id)).toEqual([1, 2, 3])
  })

  // [trigger branch] Using plannedPathIDs would list species that have not evolved yet.
  it('counts only the stages actually reached for the active Pokémon', () => {
    const s = state({
      active: mon({ pathIDs: [1, 2], plannedPathIDs: [1, 2, 3], stageIndex: 1 }),
      species: { 1: sp({ unlocked: true }), 2: sp({ unlocked: true }) },
    })
    expect(dexSpecies(s, line).map((x) => x.id)).toEqual([1, 2])
  })

  // [trigger branch] Code review 9.12 #1: a companion chosen at an evolved form (a wild
  // Charmeleon) carries its line's earlier forms in `pathIDs` to price its stage — they were
  // never obtained, and must not read as owned, be offered as a companion, or be graduated.
  it('never counts an earlier form the companion did not hold', () => {
    const s = state({
      active: mon({ pathIDs: [1, 2], plannedPathIDs: [1, 2, 3], stageIndex: 1 }),
      species: { 2: sp({ unlocked: true, caught: 1 }) },
    })
    expect(reachedForms(s, s.active!)).toEqual([2])
    expect(dexSpecies(s, line).map((x) => x.id)).toEqual([2])
  })

  // Without the marker, a species count that shrinks (fresh egg, Ditto reveal) looks like a bug.
  it('marks a species backed only by the Pokémon being raised', () => {
    const s = state({ active: mon() })
    expect(dexSpecies(s, line)[0]?.isRaising).toBe(true)
  })

  it('does not mark a species that has ever graduated, even while raising it again', () => {
    const s = state({ dex: [dexEntry({ chainOrder: [1] })], active: mon({ pathIDs: [1] }) })
    expect(dexSpecies(s, line)[0]?.isRaising).toBe(false)
  })

  it('remembers a species was held shiny', () => {
    const s = state({ dex: [dexEntry({ chainOrder: [1], isShiny: true })] })
    expect(dexSpecies(s, line)[0]?.isShiny).toBe(true)
  })

  it('hides shininess of a still-disguised Ditto', () => {
    const s = state({ active: mon({ isShiny: true, dittoDisguise: 132, dittoRevealed: false }) })
    expect(dexSpecies(s, line)[0]?.isShiny).toBe(false)
  })

  // A name-less older entry must not wipe names already found for that species.
  it('does not let a name-less entry overwrite known names', () => {
    const s = state({
      dex: [
        dexEntry({ id: 'named', chainOrder: [1], names: { 1: { en: 'Base' } } }),
        dexEntry({ id: 'legacy', chainOrder: [1] }),
      ],
    })
    expect(dexSpecies(s, line)[0]?.name).toBe('Base')
  })

  it('falls back to the species number when no name is known', () => {
    const s = state({ dex: [dexEntry({ chainOrder: [77] })] })
    expect(dexSpecies(s, undefined)[0]?.name).toBe('#77')
  })
})

// The registry is what the Pokédex shows now: every species it knows, with a state on two axes
// (how far, and its shiny form) and the bar's percentage. The states are the registry's flags,
// never re-derived from xp.
describe('species pokédex from the registry', () => {
  const line = makeEvoLine(1, node(1, [node(2, [node(3)])]), 'common', { 1: { en: 'Base' } })
  const progress = (over: Partial<SpeciesProgress> = {}): SpeciesProgress => ({
    ...freshSpeciesProgress(),
    ...over,
  })

  // [trigger branch] Met in the wild and nothing else: no dex entry, no active Pokémon. Without
  // reading the registry it would not appear at all.
  it('shows a species that was only seen, by number, at 0%', () => {
    const s = state({ species: { 25: progress({ seen: true }) } })
    const only = dexSpecies(s, undefined)
    expect(only).toHaveLength(1)
    expect(only[0]).toMatchObject({ id: 25, name: '#25', status: 'seen', percent: 0 })
  })

  it('shows an unlocked species with its registration percentage', () => {
    const s = state({ species: { 7: progress({ unlocked: true, xp: 4_000_000, threshold: 8_000_000 }) } })
    expect(dexSpecies(s, undefined)[0]).toMatchObject({ id: 7, status: 'unlocked', percent: 50 })
  })

  it('reads a registered species at 100% from its flag', () => {
    const s = state({
      species: { 7: progress({ unlocked: true, registered: true, xp: 0, threshold: 8_000_000 }) },
    })
    expect(dexSpecies(s, undefined)[0]).toMatchObject({ status: 'registered', percent: 100 })
  })

  it('puts the shiny form on its own axis', () => {
    const s = state({
      species: {
        1: progress({ unlocked: true }),
        2: progress({ unlocked: true, registered: true, shinyUnlocked: true }),
        3: progress({ unlocked: true, registered: true, shinyUnlocked: true, shinyRegistered: true }),
      },
    })
    expect(dexSpecies(s, undefined).map((x) => x.shiny)).toEqual(['none', 'unlocked', 'registered'])
  })

  // An entry the dex shows but the registry has not seeded (a save mid-migration) is owned.
  it('treats a dex species missing from the registry as unlocked', () => {
    const s = state({ dex: [dexEntry({ chainOrder: [1] })] })
    expect(dexSpecies(s, line)[0]).toMatchObject({ status: 'unlocked', percent: 0 })
  })

  // A seen species that is later caught keeps one cell, not two.
  it('merges the registry and the dex into one cell per species', () => {
    const s = state({
      dex: [dexEntry({ chainOrder: [1], names: { 1: { en: 'Base' } } })],
      species: { 1: progress({ unlocked: true, registered: true }) },
    })
    expect(dexSpecies(s, line)).toHaveLength(1)
    expect(dexSpecies(s, line)[0]).toMatchObject({ name: 'Base', status: 'registered' })
  })
})

// The Pokédex's two counts — what is owned (the collection) and what is registered (the
// completion) — come from the core, so the panel never filters its own list to find them.
describe('dexTally', () => {
  it('counts owned species apart from seen ones, and registered ones apart from owned', () => {
    const s = state({
      species: {
        1: { ...freshSpeciesProgress(), seen: true },
        2: { ...freshSpeciesProgress(), unlocked: true },
        3: { ...freshSpeciesProgress(), unlocked: true, registered: true },
        4: { ...freshSpeciesProgress(), unlocked: true, registered: true },
      },
    })
    expect(dexTally(dexSpecies(s, undefined))).toEqual({ owned: 3, registered: 2, shinyRegistered: 0 })
  })

  it('counts nothing for an empty Pokédex', () => {
    expect(dexTally([])).toEqual({ owned: 0, registered: 0, shinyRegistered: 0 })
  })
})
