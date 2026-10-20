import { describe, expect, it } from 'vitest'
import {
  PokemonBalance,
  RareCandy,
  freshCompanionState,
  freshSpeciesProgress,
  type CompanionState,
  type DexEntry,
  type MonState,
} from '../src/core/companion/model.js'
import {
  rareCandyXP,
  registerXP,
  registrationPercent,
  seedRegistry,
} from '../src/core/companion/registry.js'

const mon = (over: Partial<MonState> = {}): MonState => ({
  baseID: 129,
  pathIDs: [129, 130],
  plannedPathIDs: [129, 130],
  stageIndex: 1,
  usedAtStage: 378_478_170,
  rarity: 'common',
  totalForms: 2,
  isShiny: false,
  dittoRevealed: false,
  ...over,
})

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...freshCompanionState('en'),
  ...over,
})

const graduated = (base: number, chain: number[], rarity: DexEntry['rarity'] = 'common'): DexEntry => ({
  id: `${base}-${chain[chain.length - 1]}-1`,
  baseID: base,
  finalID: chain[chain.length - 1]!,
  chainOrder: chain,
  rarity,
  isShiny: false,
})

const wild = (id: number): DexEntry => ({
  id: `wild-w${id}`,
  baseID: id,
  finalID: id,
  chainOrder: [id],
  rarity: 'common',
  isShiny: false,
  source: 'wild',
})

describe('registerXP', () => {
  // The stage thresholds of a line sum to its graduation total, so registering every form of
  // a line costs exactly what graduating it did — at the new scale.
  it('is the stage threshold inside the line, and the stages sum to the line', () => {
    const total = PokemonBalance.graduationTotal('common')
    const stages = [0, 1, 2].map((i) => registerXP('common', 3, i))
    expect(stages).toEqual([
      Math.round(total / 6),
      Math.round((total * 2) / 6),
      Math.round((total * 3) / 6),
    ])
    expect(stages.reduce((a, b) => a + b, 0)).toBe(total)
    expect(registerXP('legendary', 1, 0)).toBe(PokemonBalance.graduationTotal('legendary'))
  })

  it('prices a full Pokédex at one to two years for a hundred million a day', () => {
    // 328 lines in the gen 1–5 index: 175 common, 33 uncommon, 72 rare, 48 legendary.
    const lines = { common: 175, uncommon: 33, rare: 72, legendary: 48 } as const
    const total = (Object.keys(lines) as (keyof typeof lines)[]).reduce(
      (sum, r) => sum + lines[r] * PokemonBalance.graduationTotal(r),
      0,
    )
    const days = total / 100_000_000
    expect(days).toBeGreaterThan(365)
    expect(days).toBeLessThan(2 * 365)
  })
})

describe('registrationPercent', () => {
  it('clamps to 100 and reads zero before the threshold is known', () => {
    expect(registrationPercent({ ...freshSpeciesProgress(), xp: 5, threshold: 10 })).toBe(50)
    expect(registrationPercent({ ...freshSpeciesProgress(), xp: 50, threshold: 10 })).toBe(100)
    expect(registrationPercent({ ...freshSpeciesProgress(), xp: 50 })).toBe(0)
    // Registered is a flag: a registered species reads 100 whatever its xp says.
    expect(registrationPercent({ ...freshSpeciesProgress(), xp: 0, registered: true })).toBe(100)
  })
})

describe('rareCandyXP', () => {
  it('is a quarter of the current stage, whatever the stage', () => {
    for (const m of [mon(), mon({ rarity: 'legendary', totalForms: 1, stageIndex: 0 })]) {
      expect(rareCandyXP(m)).toBe(
        Math.round(
          RareCandy.stageShare * PokemonBalance.phaseThreshold(m.rarity, m.totalForms, m.stageIndex),
        ),
      )
    }
    expect(RareCandy.stageShare).toBe(0.25)
    expect(RareCandy.maxPerSpecies).toBe(2)
  })
})

describe('seedRegistry', () => {
  // Everything at 0%: flags and zeros only, so the seed needs no threshold, no line and no
  // network, and can never register or shiny a species retroactively.
  it('unlocks every species the save already had, at zero', () => {
    const seeded = seedRegistry(
      state({
        dex: [graduated(1, [1, 2, 3]), wild(10), wild(129)],
        collectedFinals: ['1:3'],
        active: mon(),
      }),
    )
    const ids = Object.keys(seeded.species)
      .map(Number)
      .sort((a, b) => a - b)
    expect(ids).toEqual([1, 2, 3, 10, 129, 130])
    for (const id of ids) {
      expect(seeded.species[id]).toMatchObject({ unlocked: true, xp: 0, registered: false })
      expect(seeded.species[id]!.threshold).toBeUndefined()
    }
  })

  // [trigger branch] The companion's progress restarts: 378M at the old scale is an hour at the
  // new one, not worth a conversion that would otherwise graduate it on the first fold.
  it('resets the companion’s stage progress', () => {
    const seeded = seedRegistry(state({ active: mon() }))
    expect(seeded.active?.usedAtStage).toBe(0)
    expect(seeded.active?.pathIDs).toEqual([129, 130])
  })

  it('leaves the wallet and the history alone', () => {
    const before = state({ usedSinceInstall: 4_429_449_978, spentTokens: 765_000_000, dex: [wild(10)] })
    const seeded = seedRegistry(before)
    expect(seeded.usedSinceInstall).toBe(before.usedSinceInstall)
    expect(seeded.spentTokens).toBe(before.spentTokens)
    expect(seeded.dex).toEqual(before.dex)
  })
})
