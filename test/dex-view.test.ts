import { describe, expect, it } from 'vitest'
import {
  activeDexEntry,
  currentIsShiny,
  dexEntriesSorted,
  dexSpecies,
  entryName,
  isFinalStage,
  lineItems,
  realizedLineItems,
} from '../src/core/companion/dexView.js'
import {
  type CompanionState,
  type DexEntry,
  type EvoNode,
  type MonState,
  freshCompanionState,
  makeEvoLine,
} from '../src/core/companion/model.js'

const node = (id: number, children: EvoNode[] = []): EvoNode => ({ speciesID: id, children })

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

  it('synthesises the Pokémon being raised instead of persisting it', () => {
    const s = state({ active: mon() })
    const entry = activeDexEntry(s, line)
    expect(entry?.id).toBe('active-1-1')
    expect(entry?.caughtAt).toBeUndefined() // never a real catch record
    expect(s.dex).toEqual([]) // and it is not written into the persisted dex
  })

  it('pins the active Pokémon first, then graduates newest-first', () => {
    const s = state({
      active: mon(),
      dex: [dexEntry({ id: 'old', caughtAt: 1000 }), dexEntry({ id: 'new', caughtAt: 5000 })],
    })
    expect(dexEntriesSorted(s, line).map((e) => e.id)).toEqual(['active-1-1', 'new', 'old'])
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
    const s = state({ active: mon({ pathIDs: [1, 2], plannedPathIDs: [1, 2, 3], stageIndex: 1 }) })
    expect(dexSpecies(s, line).map((x) => x.id)).toEqual([1, 2])
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
