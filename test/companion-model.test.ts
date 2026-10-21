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
  decodeTrailEntry,
  decodeWildEncounter,
  encodeCompanionState,
  parseCompanionState,
} from '../src/core/companion/persistence.js'
import { LegendaryBalance, MilestoneBalance, StreakBalance } from '../src/core/companion/encounters.js'
import { applyLegendaryTriggers } from '../src/core/companion/ledger.js'

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

  it('keeps one candy below any stage threshold', () => {
    // A candy is a share of the stage it is fed to, so it can never chain evolutions or force
    // a graduation on its own — and two of them (the cap) cover at most half a stage.
    expect(RareCandy.stageShare * RareCandy.maxPerSpecies).toBeLessThanOrEqual(0.5)
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
    // Shop prices are wallet tokens and did not move with the registration scale: the charm
    // still costs more than any line's registration, including a legendary's.
    expect(ShinyCharm.price).toBeGreaterThan(PokemonBalance.graduationTotal('legendary'))
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
        baseID: 1,
        pathIDs: [1, 2, 3],
        plannedPathIDs: [1, 2, 3],
        stageIndex: 1,
        usedAtStage: 0,
        rarity: 'common',
        totalForms: 3,
        isShiny: false,
        dittoRevealed: false,
      }),
    ).toBe(2)

    // Defensive: an out-of-range stageIndex clamps to the last form.
    expect(
      currentSpeciesID({
        baseID: 1,
        pathIDs: [1],
        plannedPathIDs: [1],
        stageIndex: 5,
        usedAtStage: 0,
        rarity: 'common',
        totalForms: 1,
        isShiny: false,
        dittoRevealed: false,
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
    expect(
      decodeMonState({
        baseID: 1,
        pathIDs: [],
        stageIndex: 0,
        usedAtStage: 0,
        rarity: 'common',
        totalForms: 1,
      }),
    ).toBeUndefined()
  })

  it('uses the realised path as the plan when none was saved', () => {
    const legacy = {
      baseID: 265,
      pathIDs: [265, 266],
      stageIndex: 1,
      usedAtStage: 0,
      rarity: 'common',
      totalForms: 3,
    }
    expect(decodeMonState(legacy)?.plannedPathIDs).toEqual([265, 266])
    expect(decodeMonState({ ...legacy, plannedPathIDs: [] })?.plannedPathIDs).toEqual([265, 266])
  })

  it('preserves a distinct planned path', () => {
    const saved = {
      baseID: 265,
      pathIDs: [265],
      plannedPathIDs: [265, 266, 267],
      stageIndex: 0,
      usedAtStage: 0,
      rarity: 'common',
      totalForms: 3,
    }
    const decoded = decodeMonState(saved)
    expect(decoded?.pathIDs).toEqual([265])
    expect(decoded?.plannedPathIDs).toEqual([265, 266, 267])
  })
})

describe('CompanionState decoding', () => {
  // [trigger branch] "absent" is the one value that must not read as "none": a save from before
  // the registry is seeded from what it shows; a save that carries the key — even empty — has
  // been seeded once and is honoured verbatim.
  it('seeds the registry only when the key is absent', () => {
    const legacy = {
      dex: [
        {
          id: 'w1',
          baseID: 10,
          finalID: 10,
          chainOrder: [10],
          rarity: 'common',
          isShiny: false,
          source: 'wild',
        },
      ],
      collectedFinals: ['1:3'],
      active: {
        baseID: 129,
        pathIDs: [129, 130],
        stageIndex: 1,
        usedAtStage: 378_478_170,
        rarity: 'common',
        totalForms: 2,
      },
    }
    const seeded = decodeCompanionState(legacy)
    expect(
      Object.keys(seeded.species)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([1, 3, 10, 129, 130])
    expect(seeded.species[10]).toMatchObject({ unlocked: true, xp: 0 })
    // [trigger branch] The seed runs last: decoded after it, the companion brought its old-scale
    // progress back (378M against a 33M threshold) and graduated on the first fold. Found on
    // the real save, not by the suite — hence this line.
    expect(seeded.active?.usedAtStage).toBe(0)
    expect(decodeCompanionState({ ...legacy, species: {} }).species).toEqual({})
  })

  // The nature a companion left the stage with: a real one is kept, anything else is dropped
  // rather than read as a nature the player never had.
  it('keeps a species’ recorded nature only when it is one', () => {
    const state = decodeCompanionState({
      species: { '4': { unlocked: true, nature: 'bold' }, '5': { unlocked: true, nature: 'grumpy' } },
    })
    expect(state.species[4]?.nature).toBe('bold')
    expect(state.species[5]?.nature).toBeUndefined()
  })

  it('keeps that the companion on stage was chosen by hand while registered', () => {
    const active = {
      baseID: 1,
      pathIDs: [1],
      stageIndex: 0,
      usedAtStage: 0,
      rarity: 'common',
      totalForms: 2,
    }
    expect(
      decodeCompanionState({ active: { ...active, chosenWhenRegistered: true } }).active
        ?.chosenWhenRegistered,
    ).toBe(true)
    expect(decodeCompanionState({ active }).active?.chosenWhenRegistered).toBeUndefined()
  })

  it('keeps that the companion raised as a species was shiny', () => {
    const state = decodeCompanionState({
      species: {
        '4': { unlocked: true, companionShiny: true },
        '5': { unlocked: true, companionShiny: 'yes' },
      },
    })
    expect(state.species[4]?.companionShiny).toBe(true)
    expect(state.species[5]?.companionShiny).toBeUndefined()
  })

  it('reads the registry entry by entry and drops what it cannot read', () => {
    const state = decodeCompanionState({
      species: {
        '4': { xp: 12, unlocked: true, threshold: 8_333_333, lineRarity: 'common', pendingShare: 0.05 },
        '5': { xp: 1.5, unlocked: 'yes' },
        '0': { xp: 1, unlocked: true },
        abc: { xp: 1, unlocked: true },
        '7': 'nope',
      },
    })
    expect(state.species[4]).toMatchObject({
      xp: 12,
      unlocked: true,
      threshold: 8_333_333,
      lineRarity: 'common',
      pendingShare: 0.05,
    })
    // A float xp reads as 0 and a non-boolean flag as false — and an entry left with nothing
    // to say is dropped rather than kept as a blank.
    expect(state.species[5]).toBeUndefined()
    expect(state.species[0]).toBeUndefined()
    expect(state.species[7]).toBeUndefined()
    expect(Object.keys(state.species)).toHaveLength(1)
  })

  it('drops an empty entry and keeps one that only owes a share', () => {
    const state = decodeCompanionState({ species: { 9: {}, 4: { pendingShare: 0.5 } } })
    expect(state.species[9]).toBeUndefined()
    expect(state.species[4]).toMatchObject({ pendingShare: 0.5 })
  })

  // [trigger branch] A key that is present but unusable must count as absent, or a corrupt
  // `"species": null` would skip the seed and read a full Pokédex as never obtained.
  it('seeds when the registry key is present but unusable', () => {
    const legacy = {
      dex: [
        {
          id: 'w1',
          baseID: 10,
          finalID: 10,
          chainOrder: [10],
          rarity: 'common',
          isShiny: false,
          source: 'wild',
        },
      ],
    }
    expect(decodeCompanionState({ ...legacy, species: null }).species[10]?.unlocked).toBe(true)
    expect(decodeCompanionState({ ...legacy, species: 'x' }).species[10]?.unlocked).toBe(true)
  })

  it('reads the egg stock within its capacity, and grants nothing for a missing key', () => {
    expect(decodeCompanionState({}).eggStock).toEqual({ count: 0 })
    expect(decodeCompanionState({ eggStock: { count: 9, lastGrantDay: '2026-10-20' } }).eggStock).toEqual(
      {
        count: 3,
        lastGrantDay: '2026-10-20',
      },
    )
    expect(decodeCompanionState({ eggStock: { count: 1, lastGrantDay: 'today' } }).eggStock).toEqual({
      count: 1,
    })
  })

  it('reads where a species sits in its line', () => {
    const state = decodeCompanionState({
      species: { 5: { unlocked: true, baseID: 4, stageIndex: 1, totalForms: 3 } },
    })
    expect(state.species[5]).toMatchObject({ baseID: 4, stageIndex: 1, totalForms: 3 })
  })

  it('never reads a negative payout', () => {
    expect(decodeCompanionState({ earnedTokens: -5 }).earnedTokens).toBe(0)
    expect(decodeCompanionState({ earnedTokens: 5 }).earnedTokens).toBe(5)
  })

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
      active: {
        baseID: 1,
        pathIDs: [],
        stageIndex: 0,
        usedAtStage: 0,
        rarity: 'common',
        totalForms: 1,
      },
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
    expect(
      decodeCompanionState({ claimedTodayTokensByProvider: {} }).claimedTodayTokensByProvider,
    ).toEqual({})
  })

  // An existing save carries billions of lifetime tokens that predate the milestone reward.
  // Defaulting the ratchet to zero would read every one of those as unclaimed and pay a
  // legendary out on the first refresh after the update — the retro-award the candy grant's
  // `candyFeatureSeeded` already exists to prevent.
  it('seeds the milestone ratchet from an old save instead of retro-awarding', () => {
    const state = decodeCompanionState({ usedSinceInstall: MilestoneBalance.tokens * 9 + 5 })
    expect(state.milestonesAwarded).toBe(9)
    expect(applyLegendaryTriggers(state, '2026-08-19').awards).toEqual([])
    expect(state.owedLegendaryEncounters).toBe(0)
  })

  // Key present, even as zero, means the feature has already seen this save. Re-seeding it
  // would erase a ratchet on every load and hand out a legendary per launch.
  it('honours a present milestone ratchet verbatim', () => {
    const state = decodeCompanionState({
      usedSinceInstall: MilestoneBalance.tokens * 9,
      milestonesAwarded: 0,
    })
    expect(state.milestonesAwarded).toBe(0)
  })

  // No recorded days means the streak starts from the next fold that actually accrues.
  it('starts an old save with no accrual days, so no streak is retro-awarded', () => {
    const state = decodeCompanionState({ usedSinceInstall: 5 })
    expect(state.accrualDays).toEqual([])
    expect(applyLegendaryTriggers(state, '2026-08-19').awards).toEqual([])
  })

  // A duplicate would count one day twice toward "three days", and an unbounded array is read
  // on every fold.
  it('filters, de-duplicates and caps the accrual days', () => {
    const state = decodeCompanionState({
      accrualDays: ['2026-08-19', '2026-08-19', 'yesterday', 42, null, '2026-08-18'],
    })
    expect(state.accrualDays).toEqual(['2026-08-18', '2026-08-19'])

    const many = Array.from({ length: 40 }, (_, i) => `2026-07-${String((i % 28) + 1).padStart(2, '0')}`)
    expect(decodeCompanionState({ accrualDays: many }).accrualDays.length).toBeLessThanOrEqual(
      StreakBalance.windowDays,
    )
  })

  it('never decodes a negative legendary debt', () => {
    expect(decodeCompanionState({ owedLegendaryEncounters: -4 }).owedLegendaryEncounters).toBe(0)
    expect(decodeCompanionState({ owedLegendaryEncounters: 2 }).owedLegendaryEncounters).toBe(2)
  })

  it('throws only when the payload is not an object at all', () => {
    expect(() => decodeCompanionState('nope')).toThrow()
    expect(parseCompanionState('not json')).toBeUndefined()
  })
})

describe('decoding the wild area', () => {
  // A save from before the encounter overhaul must load with nothing lost and every new field at
  // its default.
  it('loads an older save with empty finds and trail, armed notice and no mood', () => {
    const state = decodeCompanionState({
      usedSinceInstall: 10,
      wild: [{ id: 'w1', speciesID: 10, captureRate: 255, rarity: 'common', appearedAt: 1, throws: 2 }],
    })
    expect(state.finds).toEqual([])
    expect(state.legendaryTrail).toEqual([])
    expect(state.queueFullArmed).toBe(true)
    expect(state.wild[0]).toEqual({
      id: 'w1',
      speciesID: 10,
      captureRate: 255,
      rarity: 'common',
      isShiny: false,
      appearedAt: 1,
      throws: 2,
    })
  })

  // A hand-edited Master Ball lying in the queue would be a free one, a click away.
  it('drops a find for an item that cannot be found', () => {
    const state = decodeCompanionState({
      finds: [
        { id: 'a', item: 'masterBall', count: 1, rarity: 'legendary', appearedAt: 1 },
        { id: 'b', item: 'pokeBall', count: 99, rarity: 'common', appearedAt: 1 },
        { id: 'c', item: 'greatBall', count: 2, rarity: 'uncommon', appearedAt: 1 },
      ],
    })
    expect(state.finds.map((f) => f.id)).toEqual(['c'])
  })

  // Out of range reads as "no mood", which is the initial mood — never as furious.
  it('drops a mood or temperament that is out of range rather than trusting it', () => {
    const state = decodeCompanionState({
      wild: [
        {
          id: 'w1',
          speciesID: 10,
          captureRate: 255,
          rarity: 'common',
          mood: { anger: 1e9, nervousness: 0, trust: 0 },
          temperament: { aggression: 50, skittishness: 50, appetite: 50 },
          nature: 'not-a-nature',
        },
      ],
    })
    expect(state.wild[0]!.mood).toBeUndefined()
    expect(state.wild[0]!.temperament).toEqual({ aggression: 50, skittishness: 50, appetite: 50 })
    expect(state.wild[0]!.nature).toBeUndefined()
  })

  it('caps the legendaries owed at their own ceiling', () => {
    expect(decodeCompanionState({ owedLegendaryEncounters: 1e6 }).owedLegendaryEncounters).toBe(
      LegendaryBalance.maxOwed,
    )
  })
})

describe('wild types on disk', () => {
  const base = { id: 'w', speciesID: 6, captureRate: 45, rarity: 'rare' }

  // A Pokémon has one type or two. A hand-edited or future save may say anything; what this
  // build does not know is dropped, and nothing valid left reads as "no types", never a guess.
  it('keeps the known types, primary first, at most two', () => {
    expect(
      decodeWildEncounter({ ...base, types: ['fire', 'shadow', 'flying', 'dragon'] })?.types,
    ).toEqual(['fire', 'flying'])
    expect(decodeWildEncounter({ ...base, types: ['shadow'] })?.types).toBeUndefined()
    expect(decodeWildEncounter({ ...base, types: 'fire' })?.types).toBeUndefined()
  })

  it('carries them on a legendary trail', () => {
    expect(
      decodeTrailEntry({ id: 'm', speciesID: 150, captureRate: 3, lostAt: 1, types: ['psychic'] })?.types,
    ).toEqual(['psychic'])
  })
})
