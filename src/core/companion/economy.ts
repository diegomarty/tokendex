/**
 * The economy in one place.
 *
 * `EconomyBalance` holds the constants the new economy adds — what a duplicate catch pays and how
 * much of the shiny bar the wallet may buy. Every existing source and sink keeps its own table
 * where the code that uses it lives; they are re-exported here (never copied, which would be a
 * second source of truth) so a reader finds the whole economy in one module. `docs/game-design.md`
 * lists the values.
 *
 * A catch reads `catchShare` and `duplicateReward` (`encounters.ts`); phase 5 (shiny) will read
 * `shinyBoostShare`.
 */

import type { Rarity } from './model.js'

export { Berry, FreshEgg, Mint, Pokeball, PokemonBalance, RareCandy, ShinyCharm } from './model.js'
export {
  EncounterBalance,
  FIND_TABLE,
  LegendaryBalance,
  MilestoneBalance,
  StealBalance,
  StreakBalance,
  TrailBalance,
} from './encounters.js'

export const EconomyBalance = {
  /**
   * The share of a species' registration its first catch fills. Small on purpose: catching
   * obtains the species, raising it is what registers it.
   */
  catchShare: 0.05,

  /**
   * Tokens a duplicate catch pays into `earnedTokens`, by the line's rarity. Each stays strictly
   * below half the cheapest expected catch in its band, so duplicates are never a farm; the
   * derivation and the measured costs are in `test/economy.test.ts`, which enforces it.
   */
  duplicateReward: {
    common: 2_000_000,
    uncommon: 4_000_000,
    rare: 30_000_000,
    legendary: 40_000_000,
  } as Record<Rarity, number>,

  /**
   * The share of a species' shiny bar the wallet may buy, 1 token for 1 experience. Half at most,
   * so the shiny is always partly played.
   */
  shinyBoostShare: 0.5,

  /**
   * The lure (phase 6): a day aimed at one seen species. Its line weighs `lineWeight` times in
   * the wild draw, and inside the line its stage takes `stageShare` of the draws. Priced by the
   * line's rarity, above the cheapest catch of that band (`test/economy.test.ts`); no legendary
   * lure — they have their own roads (milestones, streak, trail).
   */
  lure: {
    durationMs: 24 * 3_600_000,
    lineWeight: 40,
    stageShare: 0.6,
    price: { common: 20_000_000, uncommon: 50_000_000, rare: 150_000_000 } as Partial<
      Record<Rarity, number>
    >,
  },
} as const
