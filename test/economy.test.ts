import { describe, expect, it } from 'vitest'
import { EconomyBalance } from '../src/core/companion/economy.js'
import { encounterCatchChance } from '../src/core/companion/encounters.js'
import {
  FreshEgg,
  Mint,
  Pokeball,
  PokemonBalance,
  RARITIES,
  RareCandy,
  captureRateCeiling,
  type BallKind,
  type Rarity,
  type WildEncounter,
} from '../src/core/companion/model.js'

// A duplicate catch pays tokens, so catching duplicates must never be a farm: the reward stays
// strictly below half the expected cost of the catch. The binding case is the CHEAPEST catch in
// each rarity band — the band's ceiling capture rate, which is the one a player would farm —
// thrown with the right ball at a Pokémon of neutral temperament (its initial mood: anger 10).
//
// Measured with the engine itself (`encounterCatchChance`, cost = ball price ÷ one throw's odds):
//
//   common     Poké Ball  capture 255  P 0.852  cost  5.9M  half  2.9M  → reward  2M
//   uncommon   Poké Ball  capture 120  P 0.484  cost 10.3M  half  5.2M  → reward  4M
//   rare       Ultra Ball capture  45  P 0.391  cost  102M  half   51M  → reward 30M
//   legendary  Ultra Ball capture  45  P 0.391  cost  102M  half   51M  → reward 40M
//
// The plan first proposed 10M and 80M for uncommon and legendary; both fail here (an uncommon at
// capture 120 costs 10.3M, and the mythicals at capture 45 are as cheap as a rare).

/** The ball each band is caught with, as the anti-farm rule prices it. */
const RIGHT_BALL: Record<Rarity, BallKind> = {
  common: 'pokeBall',
  uncommon: 'pokeBall',
  rare: 'ultraBall',
  legendary: 'ultraBall',
}

/** Capture rate is no rarity signal for legendaries; every one of them is at or below 45. */
const LEGENDARY_CEILING = 45

function cheapestCatch(rarity: Rarity): number {
  const encounter: WildEncounter = {
    id: 'probe',
    speciesID: 1,
    captureRate: captureRateCeiling(rarity) ?? LEGENDARY_CEILING,
    rarity,
    isShiny: false,
    appearedAt: 0,
    throws: 0,
    temperament: { aggression: 50, skittishness: 50, appetite: 50 },
  }
  const ball = RIGHT_BALL[rarity]
  return Pokeball.price[ball] / encounterCatchChance(encounter, ball)
}

describe('EconomyBalance', () => {
  it.each(RARITIES)('keeps a %s duplicate below half its cheapest expected catch', (rarity) => {
    expect(EconomyBalance.duplicateReward[rarity]).toBeGreaterThan(0)
    expect(EconomyBalance.duplicateReward[rarity]).toBeLessThan(cheapestCatch(rarity) / 2)
  })

  it('rewards a rarer duplicate at least as well as a commoner one', () => {
    const rewards = RARITIES.map((rarity) => EconomyBalance.duplicateReward[rarity])
    expect(rewards).toEqual([...rewards].sort((a, b) => a - b))
  })

  // The shiny bar must always be partly played: the wallet buys half of it at most.
  it('caps the shiny boost at half the bar', () => {
    expect(EconomyBalance.shinyBoostShare).toBeGreaterThan(0)
    expect(EconomyBalance.shinyBoostShare).toBeLessThanOrEqual(0.5)
  })

  // A re-export, never a copy: a second table with the same numbers is a second source of truth.
  it('re-exports the existing tables rather than copying them', async () => {
    const model = await import('../src/core/companion/model.js')
    const encounters = await import('../src/core/companion/encounters.js')
    const economy = await import('../src/core/companion/economy.js')
    expect(economy.Pokeball).toBe(model.Pokeball)
    expect(economy.RareCandy).toBe(model.RareCandy)
    expect(economy.StealBalance).toBe(encounters.StealBalance)
    expect(economy.FIND_TABLE).toBe(encounters.FIND_TABLE)
  })
})

// Phase 4: what the shop charges, against what it buys. The scale stays at a fifteenth (Diego),
// so the prices move to it rather than the other way round.
describe('shop prices', () => {
  /** The most a candy is ever worth: its share of the costliest stage of any line. */
  const bestCandyXP = Math.max(
    ...RARITIES.flatMap((rarity) =>
      [1, 2, 3].flatMap((forms) =>
        Array.from(
          { length: forms },
          (_, stage) => RareCandy.stageShare * PokemonBalance.phaseThreshold(rarity, forms, stage),
        ),
      ),
    ),
  )

  // Bought, a candy is never cheap experience: it costs more than it is worth at its best, so
  // the free grant at a full limit window stays the good deal and the shop one is a sink.
  it('prices a candy above the most experience it can ever give', () => {
    expect(RareCandy.price).toBeGreaterThan(bestCandyXP)
    expect(RareCandy.price).toBeLessThanOrEqual(2 * bestCandyXP)
  })

  it('prices a mint at a fifth of a candy', () => {
    expect(Mint.price).toBe(RareCandy.price / 5)
  })

  // Eggs arrive free, one a day; the shop sells only the guarantee on the one incubating.
  // The guarantees are tiers; the egg itself is the untiered entry, priced at the base — above
  // the cheapest catch (an egg hatches something new) and below every guarantee.
  it('prices the egg itself under every guarantee and above the cheapest catch', () => {
    expect(FreshEgg.shopTiers).not.toContain(undefined)
    expect(FreshEgg.price).toBeGreaterThan(cheapestCatch('common'))
    for (const tier of FreshEgg.shopTiers) expect(FreshEgg.price).toBeLessThan(FreshEgg.price_(tier))
  })

  // A guaranteed rare is a shortcut, limited by the one egg a day — cheaper than the cheapest
  // rare catch, so it is worth buying, but not by a margin that makes catching pointless.
  it('prices a rare guarantee below the cheapest rare catch', () => {
    expect(FreshEgg.price_('rare')).toBeLessThan(cheapestCatch('rare'))
    expect(FreshEgg.price_('rare')).toBeGreaterThan(cheapestCatch('rare') / 2)
  })
})

describe('the lure', () => {
  // A lure is worth more than one catch of its band — it steers a whole day of encounters — and
  // rarer lines cost more. Legendaries have no lure: they have their own roads.
  it('prices a lure above the cheapest catch of its band, rising with rarity', () => {
    const bands = ['common', 'uncommon', 'rare'] as const
    for (const band of bands) expect(EconomyBalance.lure.price[band]).toBeGreaterThan(cheapestCatch(band))
    const prices = bands.map((b) => EconomyBalance.lure.price[b] ?? 0)
    expect(prices).toEqual([...prices].sort((a, b) => a - b))
    expect('legendary' in EconomyBalance.lure.price).toBe(false)
  })
})

describe('challenges', () => {
  // A day of challenges pays less than the catches it asks for cost, so they reward playing,
  // never replace it; the weekly one pays more than a day's, for the longer commitment.
  it('pays a daily challenge less than three of the cheapest catches, and the weekly more', () => {
    expect(EconomyBalance.challenge.dailyReward).toBeLessThan(3 * cheapestCatch('common'))
    expect(EconomyBalance.challenge.weeklyReward).toBeGreaterThan(
      2 * EconomyBalance.challenge.dailyReward,
    )
  })
})
