import { describe, expect, it } from 'vitest'
import {
  FreshEgg,
  PokemonBalance,
  RARITIES,
  RareCandy,
  ShinyCharm,
  currentSpeciesID,
  evoDepth,
  evoFinalIDs,
  evoNodeWithID,
  makeEvoLine,
  natureName,
  rarityFrom,
  resolveName,
  shopEntryPrice,
  sortRank,
  systemDefaultLanguage,
  totalForms,
  type EvoNode,
} from '../src/core/companion/model.js'
import {
  decodeCompanionState,
  decodeMonState,
  encodeCompanionState,
  parseCompanionState,
} from '../src/core/companion/persistence.js'

// Ported from ModelLogicTests.swift (EvoLine/EvoNode/Rarity/StatePersistence sections).

const node = (id: number, children: EvoNode[] = []): EvoNode => ({ speciesID: id, children })

describe('evolution tree', () => {
  // 1 -> {2 -> 3, 4}: a three-stage branch and a two-stage one.
  const tree = node(1, [node(2, [node(3)]), node(4)])

  it('takes depth from the longest path', () => {
    expect(evoDepth(tree)).toBe(3)
    expect(evoDepth(node(20))).toBe(1)
  })

  it('looks a node up by id', () => {
    expect(evoNodeWithID(tree, 3)?.speciesID).toBe(3)
    expect(evoNodeWithID(tree, 4)?.speciesID).toBe(4)
    expect(evoNodeWithID(tree, 99)).toBeUndefined()
  })

  it('treats leaves as the final species', () => {
    expect(new Set(evoFinalIDs(tree))).toEqual(new Set([3, 4]))
    expect(evoFinalIDs(node(20))).toEqual([20])
  })

  // Even when PokéAPI's chain continues past gen V, only forms with a GIF asset may remain in
  // the line and the stage count. Example: Mankey #56 -> Primeape #57 -> Annihilape #979.
  it('keeps only forms that have an animated asset', () => {
    const line = makeEvoLine(56, node(56, [node(57, [node(979)])]), 'common', {})
    expect(totalForms(line)).toBe(2)
    expect(evoFinalIDs(line.tree)).toEqual([57])
    expect(evoNodeWithID(line.tree, 979)).toBeUndefined()
  })
})

describe('rarity boundaries', () => {
  it('classifies by capture rate at the exact thresholds', () => {
    expect(rarityFrom(45, false, false)).toBe('rare')
    expect(rarityFrom(46, false, false)).toBe('uncommon')
    expect(rarityFrom(120, false, false)).toBe('uncommon')
    expect(rarityFrom(121, false, false)).toBe('common')
  })

  it('lets legendary and mythical override the capture rate', () => {
    expect(rarityFrom(255, true, false)).toBe('legendary')
    expect(rarityFrom(255, false, true)).toBe('legendary')
  })

  // The premium-egg guarantee gate compares these ranks. Inverting the order would silently
  // let an expensive egg hatch below the tier that was paid for.
  it('orders rarity ascending by value', () => {
    const ranks = RARITIES.map(sortRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(sortRank('legendary')).toBeGreaterThan(sortRank('rare'))
  })
})

describe('balance', () => {
  it('splits a graduation total exactly across the stages', () => {
    for (const rarity of RARITIES) {
      for (const forms of [1, 2, 3]) {
        const sum = Array.from({ length: forms }, (_, i) =>
          PokemonBalance.phaseThreshold(rarity, forms, i),
        ).reduce((a, b) => a + b, 0)
        // Rounding per stage, so allow a token or two of drift.
        expect(Math.abs(sum - PokemonBalance.graduationTotal(rarity))).toBeLessThanOrEqual(forms)
      }
    }
  })

  it('makes later stages more expensive', () => {
    const first = PokemonBalance.phaseThreshold('common', 3, 0)
    const last = PokemonBalance.phaseThreshold('common', 3, 2)
    expect(last).toBeGreaterThan(first)
  })

  it('keeps one candy below the cheapest evolution threshold', () => {
    // Otherwise a single candy could chain evolutions or force a graduation.
    expect(RareCandy.xp).toBeLessThan(PokemonBalance.phaseThreshold('common', 1, 0))
  })

  // Pricing eggs by probability ratio would make two uncommon eggs beat one rare egg on every
  // axis, leaving the top tier strictly inferior. The graduation ratio avoids that.
  it('prices guaranteed eggs so the higher tier is not a worse deal', () => {
    const uncommon = FreshEgg.price_('uncommon')
    const rare = FreshEgg.price_('rare')
    expect(FreshEgg.price_(undefined)).toBe(FreshEgg.price)
    expect(uncommon).toBe(2_500_000_000)
    expect(rare).toBe(4_000_000_000)
    expect(rare).toBeLessThan(uncommon * 2) // one rare egg beats two uncommon ones on price
  })

  it('prices the shiny charm as a premium permanent upgrade', () => {
    expect(ShinyCharm.price).toBe(PokemonBalance.graduationTotal('rare'))
    expect(ShinyCharm.shinyDenominator).toBeLessThan(64) // strictly better odds than the base
  })

  it('prices shop entries from a single source', () => {
    expect(shopEntryPrice({ kind: 'item', item: 'rareCandy' })).toBe(RareCandy.price)
    expect(shopEntryPrice({ kind: 'egg', tier: 'rare' })).toBe(FreshEgg.price_('rare'))
  })
})

describe('language', () => {
  it('falls back through apiCodes then English', () => {
    expect(resolveName('ja', { 'ja-Hrkt': 'ヒトカゲ', en: 'Charmander' })).toBe('ヒトカゲ')
    expect(resolveName('ja', { en: 'Charmander' })).toBe('Charmander')
    expect(resolveName('ko', {})).toBeUndefined()
  })

  it('infers a default without forcing Korean on the world', () => {
    expect(systemDefaultLanguage('ko-KR')).toBe('ko')
    expect(systemDefaultLanguage('ja')).toBe('ja')
    expect(systemDefaultLanguage('es-ES')).toBe('es')
    expect(systemDefaultLanguage('de-DE')).toBe('en')
    expect(systemDefaultLanguage('pt-BR')).toBe('en')
  })

  it('translates natures in all four languages', () => {
    expect(natureName('hardy', 'ko')).toBe('노력')
    expect(natureName('hardy', 'en')).toBe('Hardy')
    expect(natureName('hardy', 'ja')).toBe('がんばりや')
    expect(natureName('hardy', 'es')).toBe('Fuerte')
  })
})

describe('MonState', () => {
  it('clamps currentID to the realised path', () => {
    expect(
      currentSpeciesID({
        baseID: 1, pathIDs: [1, 2, 3], plannedPathIDs: [1, 2, 3], stageIndex: 1,
        usedAtStage: 0, rarity: 'common', totalForms: 3, isShiny: false, dittoRevealed: false,
      }),
    ).toBe(2)

    // Defensive: an out-of-range stageIndex clamps to the last form.
    expect(
      currentSpeciesID({
        baseID: 1, pathIDs: [1], plannedPathIDs: [1], stageIndex: 5,
        usedAtStage: 0, rarity: 'common', totalForms: 1, isShiny: false, dittoRevealed: false,
      }),
    ).toBe(1)
  })

  it('clamps a decoded stageIndex into the path bounds', () => {
    const base = { baseID: 1, pathIDs: [1, 2], usedAtStage: 0, rarity: 'common', totalForms: 2 }
    expect(decodeMonState({ ...base, stageIndex: 5 })?.stageIndex).toBe(1)
    expect(decodeMonState({ ...base, stageIndex: -1 })?.stageIndex).toBe(0)
  })

  // Empty pathIDs means a corrupt save. Rejecting it makes the whole state fall back to an
  // egg instead of rendering an out-of-bounds species on every frame.
  it('rejects empty pathIDs', () => {
    expect(decodeMonState({ baseID: 1, pathIDs: [], stageIndex: 0, usedAtStage: 0, rarity: 'common', totalForms: 1 })).toBeUndefined()
  })

  it('uses the realised path as the plan when none was saved', () => {
    const legacy = { baseID: 265, pathIDs: [265, 266], stageIndex: 1, usedAtStage: 0, rarity: 'common', totalForms: 3 }
    expect(decodeMonState(legacy)?.plannedPathIDs).toEqual([265, 266])
    expect(decodeMonState({ ...legacy, plannedPathIDs: [] })?.plannedPathIDs).toEqual([265, 266])
  })

  it('preserves a distinct planned path', () => {
    const saved = { baseID: 265, pathIDs: [265], plannedPathIDs: [265, 266, 267], stageIndex: 0, usedAtStage: 0, rarity: 'common', totalForms: 3 }
    const decoded = decodeMonState(saved)
    expect(decoded?.pathIDs).toEqual([265])
    expect(decoded?.plannedPathIDs).toEqual([265, 266, 267])
  })
})

describe('CompanionState decoding', () => {
  it('round-trips', () => {
    const state = decodeCompanionState({
      installBaselineSet: true,
      usedSinceInstall: 42,
      eggUsage: 1234,
      claimedTodayTokensByProvider: { test: 7 },
      lastDate: '2026-06-27',
      collectedFinals: ['1:3', '10:12'],
      language: 'ja',
      dex: [{ baseID: 1, finalID: 3, chainOrder: [1, 2, 3], rarity: 'rare' }],
    })
    const again = parseCompanionState(encodeCompanionState(state))
    expect(again).toEqual(state)
    expect(again?.language).toBe('ja')
    expect(again?.dex).toHaveLength(1)
  })

  // Partial recovery beats a full reset: months of Pokédex must survive one broken field.
  it('absorbs a broken field without losing the rest', () => {
    const state = decodeCompanionState({
      usedSinceInstall: 'not a number',
      inventory: { rareCandy: 3 },
      dex: [{ baseID: 1, finalID: 3, chainOrder: [1, 2, 3], rarity: 'rare' }],
    })
    expect(state.usedSinceInstall).toBe(0)
    expect(state.inventory).toEqual({ rareCandy: 3 })
    expect(state.dex).toHaveLength(1)
  })

  it('isolates a corrupt dex entry from the rest of the list', () => {
    const state = decodeCompanionState({
      dex: [
        { baseID: 1, finalID: 3, chainOrder: [1, 2, 3], rarity: 'rare' },
        { baseID: 'broken' },
        { baseID: 4, finalID: 6, chainOrder: [4, 5, 6], rarity: 'common' },
      ],
    })
    expect(state.dex.map((e) => e.baseID)).toEqual([1, 4])
  })

  it('falls back to an egg on a corrupt active while keeping the dex', () => {
    const state = decodeCompanionState({
      active: { baseID: 1, pathIDs: [], stageIndex: 0, usedAtStage: 0, rarity: 'common', totalForms: 1 },
      dex: [{ baseID: 1, finalID: 3, chainOrder: [1, 2, 3], rarity: 'rare' }],
    })
    expect(state.active).toBeUndefined()
    expect(state.dex).toHaveLength(1)
  })

  // Degrading to "no guarantee" is the safe direction: inventing a guarantee nobody paid for
  // would be worse than losing one.
  it('degrades an unknown eggTier to no guarantee', () => {
    expect(decodeCompanionState({ eggTier: 'mythic' }).eggTier).toBeUndefined()
    expect(decodeCompanionState({ eggTier: 'rare' }).eggTier).toBe('rare')
  })

  // An absent key means an old aggregate-only save that must be seeded without back-paying;
  // an empty map means already seeded with nothing reported today. They must stay distinct.
  it('distinguishes an absent provider map from an empty one', () => {
    expect(decodeCompanionState({}).claimedTodayTokensByProvider).toBeUndefined()
    expect(decodeCompanionState({ claimedTodayTokensByProvider: {} }).claimedTodayTokensByProvider).toEqual({})
  })

  it('throws only when the payload is not an object at all', () => {
    expect(() => decodeCompanionState('nope')).toThrow()
    expect(parseCompanionState('not json')).toBeUndefined()
  })
})
