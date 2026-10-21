import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompanionStore } from '../src/core/companion/store.js'
import { consumeRareCandy } from '../src/core/companion/shop.js'
import { rareCandyXP } from '../src/core/companion/registry.js'
import {
  PokemonBalance,
  RareCandy,
  currentSpeciesID,
  freshCompanionState,
  freshSpeciesProgress,
  makeEvoLine,
  type EvoNode,
} from '../src/core/companion/model.js'
import { encodeCompanionState } from '../src/core/companion/persistence.js'
import type { BaseSpecies, PokeProviding } from '../src/core/pokeapi.js'

// The candy end to end, through the store the worker uses: the debit, the count against the
// species and the XP it buys happen in one hold, exactly as the worker's `useItem` runs them.
// The harness is `companion-store.test.ts`'s, trimmed to what a candy needs.

const node = (id: number, children: EvoNode[] = []): EvoNode => ({ speciesID: id, children })

function stubProvider(): PokeProviding {
  return {
    line: async (baseID: number) =>
      makeEvoLine(baseID, node(baseID, [node(baseID + 1)]), 'common', {
        [baseID]: { en: `Base${baseID}` },
        [baseID + 1]: { en: `Evo${baseID}` },
      }),
    baseSpeciesIndex: async (): Promise<BaseSpecies[]> => [{ id: 1, captureRate: 255 }],
    baseSpecies: async (id: number) => ({ id, captureRate: 255 }),
    wildSpecies: async (id: number) => ({
      id,
      captureRate: 255,
      rarity: 'common' as const,
      names: { en: `Wild${id}` },
    }),
  }
}

/** A game that has begun (#600 obtained before), so usage hatches an egg rather than waiting for a starter. */
function begunFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ptb-candy-')), 'companion-state.json')
  const begun = {
    ...freshCompanionState('en'),
    species: { 600: { ...freshSpeciesProgress(), unlocked: true } },
  }
  writeFileSync(path, encodeCompanionState(begun), 'utf8')
  return path
}

const store = () =>
  new CompanionStore({
    provider: stubProvider(),
    filePath: begunFile(),
    now: () => 1_700_000_000_000,
    rng: () => 1,
    hostLanguage: 'en',
    dittoEnabled: false,
  })

const obs = (tokens: number) => ({
  todayTokensByProvider: { claude_code: tokens },
  todayDate: '2026-08-19',
  hasUsageData: true,
})

/** One candy, the way the worker feeds it. Resolves to whether one was consumed. */
async function feed(s: CompanionStore): Promise<boolean> {
  let fed = false
  await s.mutate((tx) => {
    const next = consumeRareCandy(tx.state)
    if (next === undefined) return
    tx.commit(next)
    tx.applyCandy()
    fed = true
  })
  return fed
}

async function hatched(candies: number): Promise<CompanionStore> {
  const s = store()
  await s.update(obs(0))
  await s.update(obs(PokemonBalance.eggHatchThreshold))
  await s.mutate((tx) => tx.commit({ ...tx.state, inventory: { rareCandy: candies } }))
  return s
}

describe('feeding a Rare Candy', () => {
  it('grows the companion by a share of its stage and counts the candy on its species', async () => {
    const s = await hatched(1)
    const before = s.snapshot().active!
    expect(await feed(s)).toBe(true)
    const after = s.snapshot()
    expect(after.active!.usedAtStage).toBe(before.usedAtStage + rareCandyXP(before))
    expect(after.species[currentSpeciesID(before)]?.candiesUsed).toBe(1)
    expect(after.inventory.rareCandy ?? 0).toBe(0)
  })

  // [trigger branch] Candies left in the bag, none left for the species: nothing is spent.
  it('refuses the candy past the cap and keeps it in the bag', async () => {
    const s = await hatched(RareCandy.maxPerSpecies + 1)
    for (let i = 0; i < RareCandy.maxPerSpecies; i++) expect(await feed(s)).toBe(true)
    const before = s.snapshot()
    expect(await feed(s)).toBe(false)
    expect(s.snapshot().inventory.rareCandy).toBe(1)
    expect(s.snapshot().active!.usedAtStage).toBe(before.active!.usedAtStage)
  })
})
