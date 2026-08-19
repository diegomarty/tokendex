import { describe, expect, it } from 'vitest'
import {
  applyUsage,
  longestValidPath,
  makeEvolutionPlan,
  normalizedEvolutionState,
  pickPlannedChild,
  repairedPlan,
  stageProgress,
  tokensToNext,
} from '../src/core/companion/growth.js'
import {
  type EvoNode,
  type MonState,
  PokemonBalance,
  makeEvoLine,
} from '../src/core/companion/model.js'

const node = (id: number, children: EvoNode[] = []): EvoNode => ({ speciesID: id, children })

/** Deterministic RNG so branch choices are reproducible. */
const fixedRNG = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

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

const line = makeEvoLine(1, node(1, [node(2, [node(3)])]), 'common', {})
const thr = (stage: number) => PokemonBalance.phaseThreshold('common', 3, stage)

describe('applyUsage', () => {
  // Dropping a delta because the line has not loaded (just after restart, offline) would lose
  // it permanently: the per-provider ledger has already advanced past it.
  it('credits usage even when the line is not loaded', () => {
    const result = applyUsage(mon(), 5_000, undefined, new Set(), fixedRNG(0))
    expect(result.mon.usedAtStage).toBe(5_000)
    expect(result.events).toEqual([])
  })

  it('does not evolve below the threshold', () => {
    const result = applyUsage(mon(), thr(0) - 1, line, new Set(), fixedRNG(0))
    expect(result.mon.stageIndex).toBe(0)
    expect(result.events).toEqual([])
  })

  it('evolves at the threshold and carries the overflow', () => {
    const result = applyUsage(mon(), thr(0) + 777, line, new Set(), fixedRNG(0))
    expect(result.mon.stageIndex).toBe(1)
    expect(result.mon.pathIDs).toEqual([1, 2])
    expect(result.mon.usedAtStage).toBe(777) // overflow carried, not discarded
    expect(result.events).toEqual([{ kind: 'evolved', toSpeciesID: 2 }])
  })

  it('chains several evolutions from one large delta', () => {
    const result = applyUsage(mon(), thr(0) + thr(1) + thr(2), line, new Set(), fixedRNG(0))
    expect(result.graduated).toBe(true)
    expect(result.events.filter((e) => e.kind === 'evolved')).toHaveLength(2)
  })

  it('graduates at a leaf', () => {
    const atLast = mon({ pathIDs: [1, 2, 3], stageIndex: 2, usedAtStage: 0 })
    const result = applyUsage(atLast, thr(2), line, new Set(), fixedRNG(0))
    expect(result.graduated).toBe(true)
    expect(result.events).toEqual([{ kind: 'graduated' }])
  })

  // A disguised Ditto can become a leaf after asset normalisation, so the reveal must be
  // checked BEFORE terminal graduation or the disguise species enters the Pokédex.
  it('defers to a Ditto reveal before graduating', () => {
    const disguised = mon({ pathIDs: [1, 2, 3], stageIndex: 2, dittoDisguise: 132, dittoRevealed: false })
    const result = applyUsage(disguised, thr(2), line, new Set(), fixedRNG(0))
    expect(result.graduated).toBe(false)
    expect(result.events).toEqual([{ kind: 'dittoRevealPending' }])
  })

  it('does not defer once the Ditto is revealed', () => {
    const revealed = mon({ pathIDs: [1, 2, 3], stageIndex: 2, dittoDisguise: 132, dittoRevealed: true })
    expect(applyUsage(revealed, thr(2), line, new Set(), fixedRNG(0)).graduated).toBe(true)
  })

  it('follows the planned branch when it is still valid', () => {
    const branching = makeEvoLine(1, node(1, [node(2), node(4)]), 'common', {})
    const planned = mon({ plannedPathIDs: [1, 4], totalForms: 2 })
    const result = applyUsage(planned, PokemonBalance.phaseThreshold('common', 2, 0), branching, new Set(), fixedRNG(0))
    expect(result.mon.pathIDs).toEqual([1, 4])
  })

  it('repairs an invalid planned branch instead of failing', () => {
    const branching = makeEvoLine(1, node(1, [node(2), node(4)]), 'common', {})
    // Plan points at a species that is not a child any more.
    const stale = mon({ plannedPathIDs: [1, 99], totalForms: 2 })
    const result = applyUsage(stale, PokemonBalance.phaseThreshold('common', 2, 0), branching, new Set(), fixedRNG(0))
    expect([2, 4]).toContain(result.mon.pathIDs[1])
    expect(result.notes.join(' ')).toContain('repaired invalid planned path')
  })

  it('cannot spin forever on a malformed tree', () => {
    // Self-referential-ish: a threshold of 0 would otherwise loop indefinitely.
    const zeroThreshold = mon({ rarity: 'common', totalForms: 0, usedAtStage: 0 })
    const result = applyUsage(zeroThreshold, 10 ** 12, line, new Set(), fixedRNG(0))
    expect(result.events.length).toBeLessThanOrEqual(50)
  })
})

describe('branch diversity', () => {
  it('prefers a branch whose finals are not collected yet', () => {
    const parent = node(1, [node(2), node(4)])
    // 4 is already owned, so 2 must be chosen regardless of the RNG value.
    const chosen = pickPlannedChild(parent, 1, new Set(['1:4']), fixedRNG(1))
    expect(chosen.speciesID).toBe(2)
  })

  it('falls back to the whole set once everything is owned', () => {
    const parent = node(1, [node(2), node(4)])
    const chosen = pickPlannedChild(parent, 1, new Set(['1:2', '1:4']), fixedRNG(1))
    expect([2, 4]).toContain(chosen.speciesID)
  })

  it('plans a full path down to a leaf', () => {
    expect(makeEvolutionPlan(node(1, [node(2, [node(3)])]), 1, new Set(), fixedRNG(0))).toEqual([1, 2, 3])
  })
})

describe('path repair', () => {
  it('joins a fallback route onto the realised prefix', () => {
    expect(repairedPlan([1, 2], 1, [2, 5, 6])).toEqual([1, 2, 5, 6])
  })

  // Grafting a route that starts elsewhere would invent an evolution that never happened.
  it('keeps only the prefix when the route does not connect', () => {
    expect(repairedPlan([1, 2], 1, [9, 10])).toEqual([1, 2])
  })

  it('uses the fallback wholesale when there is no realised path', () => {
    expect(repairedPlan([], 0, [1, 2])).toEqual([1, 2])
  })
})

describe('longestValidPath', () => {
  const tree = node(1, [node(2, [node(3)])])

  it('stops at the first id that does not connect', () => {
    expect(longestValidPath([1, 2, 99], tree).path).toEqual([1, 2])
  })

  it('recovers to the root when the first id is wrong', () => {
    expect(longestValidPath([99, 2], tree).path).toEqual([1])
  })
})

describe('normalizedEvolutionState', () => {
  const tree = node(1, [node(2, [node(3)])])

  // Rerolling on every restart would silently change someone's branch.
  it('reuses a complete plan without consuming RNG', () => {
    let calls = 0
    const rng = () => {
      calls += 1
      return 0
    }
    const saved = mon({ pathIDs: [1, 2], plannedPathIDs: [1, 2, 3], stageIndex: 1 })
    const normalized = normalizedEvolutionState(saved, tree, new Set(), rng)
    expect(normalized.plannedPathIDs).toEqual([1, 2, 3])
    expect(calls).toBe(0)
  })

  it('rebuilds an incomplete plan from the realised path', () => {
    const saved = mon({ pathIDs: [1, 2], plannedPathIDs: [1, 2], stageIndex: 1 })
    const normalized = normalizedEvolutionState(saved, tree, new Set(), fixedRNG(0))
    expect(normalized.plannedPathIDs).toEqual([1, 2, 3])
    expect(normalized.totalForms).toBe(3)
  })

  it('trims a path the current asset tree no longer supports', () => {
    const saved = mon({ pathIDs: [1, 2, 99], plannedPathIDs: [1, 2, 99], stageIndex: 2 })
    const normalized = normalizedEvolutionState(saved, tree, new Set(), fixedRNG(0))
    expect(normalized.pathIDs).toEqual([1, 2])
    expect(normalized.stageIndex).toBe(1)
  })
})

describe('progress helpers', () => {
  it('reports the remaining tokens and the fraction done', () => {
    const half = mon({ usedAtStage: Math.floor(thr(0) / 2) })
    expect(tokensToNext(half)).toBe(thr(0) - Math.floor(thr(0) / 2))
    expect(stageProgress(half)).toBeCloseTo(0.5, 2)
  })

  it('clamps progress at 1 and never reports negative remaining', () => {
    const over = mon({ usedAtStage: thr(0) * 3 })
    expect(stageProgress(over)).toBe(1)
    expect(tokensToNext(over)).toBe(0)
  })
})
