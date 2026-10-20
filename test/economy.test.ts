import { describe, expect, it } from 'vitest'
import { EconomyBalance } from '../src/core/companion/economy.js'
import { encounterCatchChance } from '../src/core/companion/encounters.js'
import {
  Pokeball,
  RARITIES,
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
