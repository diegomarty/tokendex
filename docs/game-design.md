# Tokendex game design

The game model every phase builds on, and the balance constants in force. The plan that leads
here, phase by phase, is [`docs/plans/00-master.md`](plans/00-master.md); this file is the
reference it settles into. When a constant changes, change it here in the same commit.

## The model in one paragraph

Every token an AI CLI spends counts twice: once as **experience** for the Pokémon you have
chosen as your companion, and once as **currency** in the wallet. Spending never takes
experience away. Experience fills a bar **per species**; a full bar **registers** the species,
evolves the companion into its next form and opens that form's bar. The Pokédex counts registered
species. Wild Pokémon walk in as you work: catching one unlocks its species, and the wallet pays
for the balls, berries, eggs and items that make the catching possible.

## Decisions

| Topic                     | Decision                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens                    | **Double use.** Each token is 1 experience for the companion and 1 token of wallet. Spending never removes experience.                                                         |
| Existing saves            | **Everything at 0%.** Every species a save already has (graduated or caught) is _unlocked_ at 0%; the companion stays the same, at 0%. The wallet and the catch log are kept. |
| Start                     | **Choose a starter** among the starters of generations 1–5.                                                                                                                     |
| Full bar                  | **Registers and evolves.** The species is registered, the companion evolves into the next form (unlocked, with its own bar), and an earlier form can always be chosen again.    |
| XP of a registered form   | **Pending branches, then shiny.** With children not yet unlocked, each extra `registerXP` opens the next branch; otherwise it feeds `shinyXP`.                                   |
| Evolved wild forms        | **Yes, with reduced weight:** 65/30/5 for three-stage lines and 75/25 for two-stage lines, biased toward species you do not have.                                              |
| Scale                     | **`graduationTotal` ÷ 15**: the full Pokédex in 1–2 years for an average agentic user.                                                                                          |
| Rare Candy                | **25% of the current stage's threshold, at most 2 per species.**                                                                                                                 |
| Shiny                     | **One bar** of `8 × graduationTotal(lineRarity)` per form, with an optional paid boost of up to half of it.                                                                     |
| Currency                  | **Raw tokens**, the same number the panel shows. Not weighted by cost.                                                                                                          |
| Registering at 100%       | **Pays no tokens.** Its reward is the evolution, the Pokédex entry and the road to the shiny.                                                                                   |
| Eggs                      | **One free egg a day, up to 3 in stock.** Incubating one is always a companion option (5M to hatch). Shop eggs only add a tier guarantee.                                        |
| Economy                   | **The simulator comes first**: phases 2–6 fix their constants from its numbers.                                                                                                 |

## The species registry

`CompanionState.species` holds one `SpeciesProgress` per species (`src/core/companion/registry.ts`):
experience, the flags `seen`, `unlocked`, `registered`, the shiny flags, `caught` and
`candiesUsed`, and the lazily fixed `threshold` and `lineRarity`.

- **The requirement.** `registerXP` is the threshold of the species' stage within its line,
  `PokemonBalance.phaseThreshold(lineRarity, forms, stage)`. A common three-form line asks 8M,
  17M and 25M.
- **Two rarities, two names.** The _encounter_ rarity comes from the species' capture rate and
  decides expiry, thefts and the badge. The _line_ rarity prices registration and duplicates.
- **The threshold is lazy.** `registerXP` needs the evolution line, so `threshold` and
  `lineRarity` are fixed the first time the species gains experience with its line loaded.
  Before that, experience accrues raw, `registrationPercent` clamps to 100% and nothing is ever
  marked registered. `applyUsage` settles an evolution by capping the species evolved from at its
  threshold (`registered`) and crediting the overflow to the species evolved into.
- **The states are flags**, never derived from experience: unknown → seen → unlocked →
  registered, and the shiny axis beside it. A merge unions them, so the Pokédex never goes
  backwards. Experience comes whole from the merge winner, plus the merge's own credit of the
  loser's unseen tokens; a per-key maximum would count those tokens twice.
- **The seed runs last and only when the key is absent.** `seedRegistry` unlocks at 0% every
  species a save already shows and resets `usedAtStage`. It runs after `active` is decoded.
- **The Rare Candy** is worth `rareCandyXP` = 25% of the current stage's threshold, and a species
  takes at most `RareCandy.maxPerSpecies`. The count lives on the form, so evolving renews it.

## The wallet

`spendableBalance = max(0, usedSinceInstall + earnedTokens − spentTokens)`, defined once in
`src/core/companion/ledger.ts`. The shop, the legendary trail and an attack all read it there.
`spentTokens` is the wallet's only debit; `earnedTokens` only grows, so a reward is never lost to
the clamp that keeps `spentTokens` at zero or above.

## Economy: sources and sinks

Per day for an average user (100M tokens a day), with the figures of the plan.

|         | Today                                                                                                                                                                  | With the plan                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Sources | tokens; item finds (a quarter of arrivals); Rare Candy from exhausted rate-limit windows; legendaries from usage milestones and streaks                                 | + duplicate catches and hatches (the first registration pays nothing)       |
| Sinks   | balls 5/15/40M (Master 1.5B), berries 3/3/8M, Rare Candy 500M, Mint 100M, Shiny Charm 3B, eggs 1/2.5/4B, trail 100/200/400M, thefts 0.5–4M                             | + shiny boost (up to half of `shinyXP`), lure                               |

**Anti-farm rule for duplicates.** A duplicate's reward stays strictly below half the cheapest
expected catch in its rarity band: the band's ceiling capture rate (255, 120, 45, and 45 for
legendaries), a neutral temperament's initial mood, and the right ball (Poké Ball for common and
uncommon, Ultra Ball for rare and legendary). Those catches cost 5.9M, 10.3M, 102M and 102M, so
the rewards are 2M, 4M, 30M and 40M. `test/economy.test.ts` measures the costs with the engine's
own `encounterCatchChance` and enforces the rule.

**Profiles** (raw tokens, the currency): agentic heavy 150–600M a day, agentic average ~100M,
light CLI ~20M, chat in the editor 1–5M. The full Pokédex is meant for the agentic average in
1–2 years; chat users play in a slow mode, with a cheap first stretch (first encounter at 500k,
hatch at 5M, an arrival every 2M, the first common stage at 8M).

## Constants in force

Every balance table, its current values and the file that defines it.
`src/core/companion/economy.ts` re-exports all of them, so they can be read in one place.

### `PokemonBalance` — `src/core/companion/model.ts`

| Constant            | Value                                                         |
| ------------------- | ------------------------------------------------------------- |
| `eggHatchThreshold` | 5M                                                            |
| `graduationTotal`   | common 50M · uncommon 125M · rare 200M · legendary 400M       |
| `phaseThreshold`    | `round(graduationTotal × stage / (forms × (forms + 1) / 2))` |

### `Pokeball` — `src/core/companion/model.ts`

| Constant           | Value                                                 |
| ------------------ | ----------------------------------------------------- |
| `price`            | Poké 5M · Great 15M · Ultra 40M · Master 1.5B         |
| `multiplier`       | Poké 1 · Great 1.5 · Ultra 2 · Master always catches  |
| `bundleSize`       | 10                                                    |
| `bundleMultiplier` | 9 (a ten-pack costs nine)                             |
| `starterCount`     | 5 Poké Balls                                          |

### `Berry` — `src/core/companion/model.ts`

| Constant | Value                          |
| -------- | ------------------------------ |
| `price`  | Oran 3M · Nanab 3M · Razz 8M   |

### `RareCandy` — `src/core/companion/model.ts`

| Constant        | Value                                 |
| --------------- | ------------------------------------- |
| `stageShare`    | 0.25 of the current stage's threshold |
| `maxPerSpecies` | 2                                     |
| `weeklyGrant`   | 5 (a weekly window exhausted)         |
| `price`         | 500M                                  |

### `Mint` — `src/core/companion/model.ts`

| Constant | Value |
| -------- | ----- |
| `price`  | 100M  |

### `ShinyCharm` — `src/core/companion/model.ts`

| Constant           | Value                   |
| ------------------ | ----------------------- |
| `price`            | 3B                      |
| `shinyDenominator` | 48 (1/64 without it)    |

### `FreshEgg` — `src/core/companion/model.ts`

| Constant    | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| `price`     | 1B (any rarity)                                                 |
| `shopTiers` | any · uncommon or better · rare or better                       |
| `price_`    | 1B scaled by `graduationTotal` ratio: uncommon 2.5B · rare 4B   |

### `EncounterBalance` — `src/core/companion/encounters.ts`

| Constant         | Value                             |
| ---------------- | --------------------------------- |
| `threshold`      | 2M of usage per arrival           |
| `firstThreshold` | 500k for the very first           |
| `maxQueue`       | 30                                |
| `findShare`      | 250‰ of arrivals are item finds   |

### `StealBalance` — `src/core/companion/encounters.ts`

| Constant       | Value                                                   |
| -------------- | ------------------------------------------------------- |
| `amount`       | common 0.5M · uncommon 1M · rare 2M · legendary 4M      |
| `perEncounter` | 3 attacks' worth at most from one Pokémon               |

### `TrailBalance` — `src/core/companion/encounters.ts`

| Constant     | Value                                   |
| ------------ | --------------------------------------- |
| `windowMs`   | 72 hours                                |
| `basePrice`  | 100M, doubling each track (`growth` 2)  |
| `maxTracks`  | 3                                       |
| `maxEntries` | 6                                       |

### `FIND_TABLE` — `src/core/companion/encounters.ts`

| Tier      | Share | Contents (weight)                                         |
| --------- | ----- | --------------------------------------------------------- |
| common    | 700‰  | Poké Ball (3) · Oran (1) · Nanab (1) · Razz (1), one each |
| uncommon  | 230‰  | 2 Poké Balls (1) · Great Ball (1) · 2 Razz (1)            |
| rare      | 60‰   | 2 Great Balls (1) · Ultra Ball (1)                        |
| legendary | 10‰   | 3 Ultra Balls                                             |

### `MilestoneBalance` — `src/core/companion/encounters.ts`

| Constant | Value                                           |
| -------- | ----------------------------------------------- |
| `tokens` | 1B of usage per milestone (a legendary arrives) |

### `StreakBalance` — `src/core/companion/encounters.ts`

| Constant     | Value                                       |
| ------------ | ------------------------------------------- |
| `days`       | 3 days with usage                           |
| `windowDays` | within 7 days (a legendary arrives)         |

### `LegendaryBalance` — `src/core/companion/encounters.ts`

| Constant  | Value                                  |
| --------- | -------------------------------------- |
| `maxOwed` | 12 legendary encounters owed at most   |

### `EconomyBalance` — `src/core/companion/economy.ts`

The new economy's own constants. Not wired into the game yet; phase 3 reads them.

| Constant          | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| `duplicateReward` | common 2M · uncommon 4M · rare 30M · legendary 40M       |
| `shinyBoostShare` | 0.5 of `shinyXP` at most may be bought from the wallet   |
