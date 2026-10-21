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
import { type EvoNode, type MonState, PokemonBalance, makeEvoLine } from '../src/core/companion/model.js'

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

  // The registry rides along: the same delta that moves `usedAtStage` fills the current
  // species' bar, and evolving caps the old species at its threshold (registered) and hands the
  // overflow to the new one — the two never disagree about where the tokens went.
  it('fills the current species’ bar and fixes its threshold once the line is known', () => {
    const result = applyUsage(mon(), 1_000, line, new Set(), fixedRNG(0), {})
    expect(result.species[1]).toMatchObject({
      xp: 1_000,
      unlocked: true,
      registered: false,
      threshold: thr(0),
      lineRarity: 'common',
    })
  })

  // [trigger branch] Crediting the whole delta in one block would leave species 1 above its
  // threshold and species 2 at zero.
  it('registers the species it evolves from and carries the overflow to the next', () => {
    const result = applyUsage(mon(), thr(0) + 777, line, new Set(), fixedRNG(0), {})
    expect(result.species[1]).toMatchObject({ xp: thr(0), registered: true })
    expect(result.species[2]).toMatchObject({
      xp: 777,
      unlocked: true,
      threshold: thr(1),
      registered: false,
    })
  })

  it('accrues raw experience without a line, and settles it once there is one', () => {
    const offline = applyUsage(mon(), thr(0) + 5, undefined, new Set(), fixedRNG(0), {})
    expect(offline.species[1]).toMatchObject({ xp: thr(0) + 5, registered: false })
    expect(offline.species[1]?.threshold).toBeUndefined()
    const settled = applyUsage(offline.mon, 0, line, new Set(), fixedRNG(0), offline.species)
    expect(settled.species[1]).toMatchObject({ xp: thr(0), registered: true })
    expect(settled.species[2]).toMatchObject({ xp: 5 })
  })

  // [trigger branch] Registered at the leaf, the companion stays: no second `graduated`, the
  // meter pinned at the threshold, and nothing to evolve into.
  it('keeps a registered final form on stage and graduates it only once', () => {
    const atLast = mon({ pathIDs: [1, 2, 3], stageIndex: 2, usedAtStage: 0 })
    const first = applyUsage(atLast, thr(2), line, new Set(), fixedRNG(0), {})
    expect(first.graduated).toBe(true)
    const again = applyUsage(first.mon, thr(2), line, new Set(), fixedRNG(0), first.species)
    expect(again.graduated).toBe(false)
    expect(again.events).toEqual([])
    expect(again.mon.usedAtStage).toBe(thr(2))
    expect(again.mon.pathIDs).toEqual([1, 2, 3])
  })

  it('keeps evolving a registered species while a branch below is unregistered', () => {
    const registered = {
      xp: thr(0),
      unlocked: true,
      seen: false,
      registered: true,
      caught: 0,
      candiesUsed: 0,
    }
    const pending = applyUsage(mon(), thr(0), line, new Set(), fixedRNG(0), { 1: registered })
    expect(pending.mon.stageIndex).toBe(1)
    const done = { ...registered, xp: thr(1) }
    const settled = applyUsage(mon(), thr(0), line, new Set(), fixedRNG(0), {
      1: registered,
      2: { ...done, registered: true },
      3: { ...done, registered: true },
    })
    expect(settled.mon.stageIndex).toBe(0)
    expect(settled.mon.usedAtStage).toBe(thr(0))
  })

  // [trigger branch] The plan points at a branch that is all registered while a sibling is not:
  // the companion takes the sibling, not the dead end it would never leave.
  it('steers a registered species toward the branch that still has something to register', () => {
    const eevee = makeEvoLine(133, node(133, [node(134), node(135)]), 'rare', {})
    const t = (stage: number) => PokemonBalance.phaseThreshold('rare', 2, stage)
    const registered = {
      xp: t(0),
      unlocked: true,
      seen: false,
      registered: true,
      caught: 0,
      candiesUsed: 0,
    }
    const result = applyUsage(
      mon({ baseID: 133, pathIDs: [133], plannedPathIDs: [133, 134], totalForms: 2, rarity: 'rare' }),
      t(0),
      eevee,
      new Set([133, 134, 135]),
      fixedRNG(0),
      { 133: registered, 134: { ...registered, xp: t(1) } },
    )
    expect(result.mon.pathIDs).toEqual([133, 135])
    expect(result.mon.plannedPathIDs).toEqual([133, 135])
  })

  // [trigger branch] A species caught before its line was known owes its share; the line fixes
  // the threshold, the share becomes experience, and the meter starts where the bar is.
  it('settles a share owed by a catch once the line fixes the threshold', () => {
    const owed = {
      xp: 0,
      unlocked: true,
      seen: true,
      registered: false,
      caught: 1,
      candiesUsed: 0,
      pendingShare: 0.05,
    }
    const result = applyUsage(mon(), 0, line, new Set(), fixedRNG(0), { 1: owed })
    expect(result.species[1]?.xp).toBe(Math.ceil(0.05 * thr(0)))
    expect(result.species[1]?.pendingShare).toBeUndefined()
    expect(result.mon.usedAtStage).toBe(Math.ceil(0.05 * thr(0)))
  })

  // [trigger branch] The meter never lags the bar: a hatch into a caught species starts the
  // meter at zero while its bar already reads the catch's share.
  it('starts the meter where the species bar already is', () => {
    const caught = {
      xp: 1_000,
      unlocked: true,
      seen: true,
      registered: false,
      caught: 1,
      candiesUsed: 0,
      threshold: thr(0),
    }
    const result = applyUsage(mon(), 10, line, new Set(), fixedRNG(0), { 1: caught })
    expect(result.mon.usedAtStage).toBe(1_010)
    expect(result.species[1]?.xp).toBe(1_010)
  })

  // [trigger branch] The same rule on evolving: the next form was caught earlier and owes its
  // share, so the meter it starts with is the overflow plus that share, not the overflow alone.
  it('starts an evolved form’s meter where its bar already is', () => {
    const owed = {
      xp: 0,
      unlocked: true,
      seen: true,
      registered: false,
      caught: 1,
      candiesUsed: 0,
      pendingShare: 0.05,
    }
    const result = applyUsage(mon(), thr(0) + 7, line, new Set(), fixedRNG(0), { 2: owed })
    expect(result.mon.stageIndex).toBe(1)
    const share = Math.ceil(0.05 * thr(1))
    expect(result.species[2]?.xp).toBe(7 + share)
    expect(result.mon.usedAtStage).toBe(7 + share)
  })

  describe('the shiny bar', () => {
    const target = 8 * PokemonBalance.graduationTotal('common')
    const done = (over = {}) => ({
      xp: thr(2),
      unlocked: true,
      seen: false,
      registered: true,
      caught: 0,
      candiesUsed: 0,
      threshold: thr(2),
      lineRarity: 'common' as const,
      ...over,
    })
    const atLast = (used = thr(2)) => mon({ pathIDs: [1, 2, 3], stageIndex: 2, usedAtStage: used })

    // [trigger branch] A registered final form on stage: what it earns past its bar fills its
    // shiny bar, and its own bar stays where it was.
    it('sends a registered companion’s surplus to its shiny bar', () => {
      const result = applyUsage(atLast(), 1_000, line, new Set(), fixedRNG(0), { 3: done() })
      expect(result.species[3]).toMatchObject({ xp: thr(2), shinyXP: 1_000 })
      expect(result.mon.usedAtStage).toBe(thr(2))
    })

    // The same for a registered species with nothing left to register below it.
    it('fills the shiny bar of a registered species with nothing left below', () => {
      const species = {
        1: done({ xp: thr(0), threshold: thr(0) }),
        2: done({ xp: thr(1), threshold: thr(1) }),
        3: done(),
      }
      const result = applyUsage(mon({ usedAtStage: thr(0) }), 500, line, new Set(), fixedRNG(0), species)
      expect(result.species[1]).toMatchObject({ xp: thr(0), shinyXP: 500 })
    })

    // [trigger branch] The first registration's own overflow is surplus too.
    it('sends the overflow of the registering refresh to the shiny bar', () => {
      const fresh = done({ registered: false, xp: 0 })
      const result = applyUsage(atLast(0), thr(2) + 300, line, new Set(), fixedRNG(0), { 3: fresh })
      expect(result.graduated).toBe(true)
      expect(result.species[3]).toMatchObject({ registered: true, shinyXP: 300 })
    })

    // [trigger branch] The requirement is eight times the LINE's total for every form, not eight
    // times the stage: at 8 × the stage threshold Charmander would be nowhere near.
    it('registers the shiny at eight times the line’s total, and dresses the companion', () => {
      const stageEight = 8 * thr(2)
      const short = applyUsage(atLast(), stageEight, line, new Set(), fixedRNG(0), { 3: done() })
      expect(short.species[3]?.shinyRegistered ?? false).toBe(false)
      const full = applyUsage(atLast(), target + 5, line, new Set(), fixedRNG(0), { 3: done() })
      expect(full.species[3]).toMatchObject({
        shinyXP: target,
        shinyRegistered: true,
        shinyUnlocked: true,
      })
      expect(full.mon.isShiny).toBe(true)
      expect(full.events).toContainEqual({ kind: 'shinyRegistered', speciesID: 3 })
    })

    it('leaves a registered shiny’s bar where it is', () => {
      const shiny = done({ shinyRegistered: true, shinyXP: target })
      expect(
        applyUsage(atLast(), 1_000, line, new Set(), fixedRNG(0), { 3: shiny }).species[3]?.shinyXP,
      ).toBe(target)
    })
  })

  it('records where the species sits in its line when the threshold is fixed', () => {
    const result = applyUsage(mon(), 1, line, new Set(), fixedRNG(0), {})
    expect(result.species[1]).toMatchObject({ baseID: 1, stageIndex: 0, totalForms: 3 })
  })

  it('registers the final form on graduation', () => {
    const atLast = mon({ pathIDs: [1, 2, 3], stageIndex: 2, usedAtStage: 0 })
    const result = applyUsage(atLast, thr(2), line, new Set(), fixedRNG(0), {})
    expect(result.species[3]).toMatchObject({ xp: thr(2), registered: true, unlocked: true })
  })

  // The reveal moves what this life earned to Ditto and nothing more: a real Bulbasaur raised
  // earlier keeps its own bar.
  it('moves only this life’s experience to Ditto on the reveal', () => {
    const disguised = mon({ dittoDisguise: 132, usedAtStage: 0 })
    const prior = {
      1: { xp: 12, unlocked: true, seen: false, registered: true, caught: 0, candiesUsed: 0 },
    }
    const result = applyUsage(disguised, thr(0), line, new Set(), fixedRNG(0), prior)
    expect(result.events[0]?.kind).toBe('dittoRevealed')
    expect(result.species[1]).toMatchObject({ xp: 12, registered: true })
    expect(result.species[132]).toMatchObject({ xp: thr(0), unlocked: true })
  })

  // [trigger branch] The disguise species was unlocked by the hatch alone — never caught, never
  // raised. The reveal takes that back, or its first real catch would count as a duplicate.
  it('takes back an unlock the disguise alone gave', () => {
    const disguised = mon({ dittoDisguise: 132, usedAtStage: 0 })
    const byHatch = {
      1: { xp: 0, unlocked: true, seen: false, registered: false, caught: 0, candiesUsed: 0 },
    }
    const result = applyUsage(disguised, thr(0), line, new Set(), fixedRNG(0), byHatch)
    expect(result.events[0]?.kind).toBe('dittoRevealed')
    expect(result.species[1]?.unlocked ?? false).toBe(false)
    const caught = { 1: { ...byHatch[1], caught: 1 } }
    expect(applyUsage(disguised, thr(0), line, new Set(), fixedRNG(0), caught).species[1]?.unlocked).toBe(
      true,
    )
  })

  it('returns the very same registry when a zero delta settles nothing', () => {
    const settled = applyUsage(mon(), 1, line, new Set(), fixedRNG(0), {}).species
    const again = applyUsage(mon({ usedAtStage: 1 }), 0, line, new Set(), fixedRNG(0), settled)
    expect(again.species).toBe(settled)
  })

  // A disguised Ditto can become a leaf after asset normalisation, so the reveal must be
  // checked BEFORE terminal graduation or the disguise species enters the Pokédex.
  it('reveals the Ditto instead of graduating the species it was disguised as', () => {
    const disguised = mon({
      pathIDs: [1, 2, 3],
      stageIndex: 2,
      dittoDisguise: 132,
      dittoRevealed: false,
    })
    const result = applyUsage(disguised, thr(2), line, new Set(), fixedRNG(0))
    expect(result.graduated).toBe(false)
    expect(result.events).toEqual([{ kind: 'dittoRevealed', disguisedAsSpeciesID: 3 }])
    expect(result.mon.baseID).toBe(132)
  })

  // The reveal used to emit an event nobody handled, which left the loop breaking at the same
  // threshold on every single call: the companion stopped growing for ever.
  it('reveals at the first threshold and keeps growing afterwards', () => {
    const disguised = mon({ dittoDisguise: 132, dittoRevealed: false })
    const revealed = applyUsage(disguised, thr(0), line, new Set(), fixedRNG(0)).mon
    expect(revealed.dittoRevealed).toBe(true)
    expect(revealed.usedAtStage).toBe(thr(0)) // the spend carries over, nothing is refunded
    // Not graduated, and not stuck either: it now needs the rest of a full graduation.
    expect(tokensToNext(revealed)).toBe(PokemonBalance.graduationTotal('common') - thr(0))
  })

  // The whole point of collapsing to one form: a revealed Ditto must cost exactly what the
  // line it impersonated would have cost, never a third of it.
  it('graduates a revealed Ditto for the same total as the line it impersonated', () => {
    const dittoLine = makeEvoLine(132, node(132), 'common', {})
    const revealed = applyUsage(
      mon({ dittoDisguise: 132, dittoRevealed: false }),
      thr(0),
      line,
      new Set(),
      fixedRNG(0),
    ).mon

    const short = applyUsage(revealed, 0, dittoLine, new Set(), fixedRNG(0))
    expect(short.graduated).toBe(false) // the first threshold alone does not buy a Pokédex entry

    const full = applyUsage(revealed, tokensToNext(revealed), dittoLine, new Set(), fixedRNG(0))
    expect(full.graduated).toBe(true)
    expect(full.mon.usedAtStage).toBe(PokemonBalance.graduationTotal('common'))
  })

  it('does not defer once the Ditto is revealed', () => {
    const revealed = mon({
      pathIDs: [1, 2, 3],
      stageIndex: 2,
      dittoDisguise: 132,
      dittoRevealed: true,
    })
    expect(applyUsage(revealed, thr(2), line, new Set(), fixedRNG(0)).graduated).toBe(true)
  })

  it('follows the planned branch when it is still valid', () => {
    const branching = makeEvoLine(1, node(1, [node(2), node(4)]), 'common', {})
    const planned = mon({ plannedPathIDs: [1, 4], totalForms: 2 })
    const result = applyUsage(
      planned,
      PokemonBalance.phaseThreshold('common', 2, 0),
      branching,
      new Set(),
      fixedRNG(0),
    )
    expect(result.mon.pathIDs).toEqual([1, 4])
  })

  it('repairs an invalid planned branch instead of failing', () => {
    const branching = makeEvoLine(1, node(1, [node(2), node(4)]), 'common', {})
    // Plan points at a species that is not a child any more.
    const stale = mon({ plannedPathIDs: [1, 99], totalForms: 2 })
    const result = applyUsage(
      stale,
      PokemonBalance.phaseThreshold('common', 2, 0),
      branching,
      new Set(),
      fixedRNG(0),
    )
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
    const chosen = pickPlannedChild(parent, new Set([4]), fixedRNG(1))
    expect(chosen.speciesID).toBe(2)
  })

  it('falls back to the whole set once everything is owned', () => {
    const parent = node(1, [node(2), node(4)])
    const chosen = pickPlannedChild(parent, new Set([2, 4]), fixedRNG(1))
    expect([2, 4]).toContain(chosen.speciesID)
  })

  it('plans a full path down to a leaf', () => {
    expect(makeEvolutionPlan(node(1, [node(2, [node(3)])]), new Set(), fixedRNG(0))).toEqual([1, 2, 3])
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
