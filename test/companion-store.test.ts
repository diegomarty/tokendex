import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompanionStore } from '../src/core/companion/store.js'
import { PokemonBalance, makeEvoLine, type EvoNode } from '../src/core/companion/model.js'
import type { BaseSpecies, PokeProviding } from '../src/core/pokeapi.js'
import { BACKUP_FILE_PREFIX } from '../src/core/companion/saveTransfer.js'

const node = (id: number, children: EvoNode[] = []): EvoNode => ({ speciesID: id, children })

/** Stub provider: no network, deterministic lines. */
function stubProvider(over: Partial<PokeProviding> = {}): PokeProviding {
  return {
    line: async (baseID: number) =>
      makeEvoLine(baseID, node(baseID, [node(baseID + 1)]), 'common', {
        [baseID]: { en: `Base${baseID}` },
        [baseID + 1]: { en: `Evo${baseID}` },
      }),
    baseSpeciesIndex: async (): Promise<BaseSpecies[]> => [{ id: 1, captureRate: 255 }],
    baseSpecies: async (id: number) => ({ id, captureRate: 255 }),
    ...over,
  }
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ptb-store-')), 'companion-state.json')
}

const store = (over: Partial<ConstructorParameters<typeof CompanionStore>[0]> = {}) =>
  new CompanionStore({
    provider: stubProvider(),
    filePath: tempFile(),
    now: () => 1_700_000_000_000,
    rng: () => 1, // never hits the 1-in-N rolls
    hostLanguage: 'en',
    dittoEnabled: false,
    ...over,
  })

const obs = (tokens: number, date = '2026-08-19') => ({
  todayTokensByProvider: { claude_code: tokens },
  todayDate: date,
  hasUsageData: true,
})

describe('update flow', () => {
  it('takes a baseline first without granting anything', async () => {
    const s = store()
    await s.update(obs(9_000_000))
    expect(s.snapshot().usedSinceInstall).toBe(0)
    expect(s.snapshot().eggUsage).toBe(0)
  })

  it('accrues into the egg after the baseline', async () => {
    const s = store()
    await s.update(obs(1_000))
    await s.update(obs(1_000 + 2_000_000))
    expect(s.snapshot().eggUsage).toBe(2_000_000)
    expect(s.snapshot().active).toBeUndefined() // below the hatch threshold
  })

  it('hatches once the threshold is crossed, carrying the overflow', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold + 777))
    const active = s.snapshot().active
    expect(active).toBeDefined()
    expect(active?.usedAtStage).toBe(777) // overflow carried into the hatchling
    expect(s.snapshot().eggUsage).toBe(0)
    expect(s.drainEvents().map((e) => e.kind)).toContain('hatched')
  })

  // Fixed at hatch like shininess. Without it the Mint would act on nothing.
  it('assigns a nature at hatch', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active?.nature).toBeDefined()
  })

  it('keeps the egg when the network is down', async () => {
    const failing = stubProvider({
      line: async () => {
        throw new Error('offline')
      },
      baseSpeciesIndex: async () => {
        throw new Error('offline')
      },
      baseSpecies: async () => {
        throw new Error('offline')
      },
    })
    const s = store({ provider: failing })
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active).toBeUndefined()
    // The usage is not lost, so the next tick hatches without re-earning it.
    expect(s.snapshot().eggUsage).toBeGreaterThanOrEqual(PokemonBalance.eggHatchThreshold)
  })

  it('consumes the egg guarantee exactly at hatch', async () => {
    const s = store()
    await s.update(obs(0))
    s.replaceState({ ...s.snapshot(), eggTier: 'common', pendingHatchID: 1 })
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().eggTier).toBeUndefined()
    expect(s.snapshot().pendingHatchID).toBeUndefined()
  })

  it('evolves and then graduates, recording the line in the dex', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.snapshot().active).toBeDefined()

    // Enough to clear both stages of the two-form common line.
    const huge = PokemonBalance.eggHatchThreshold + PokemonBalance.graduationTotal('common') * 2
    await s.update(obs(huge))

    const after = s.snapshot()
    expect(after.active).toBeUndefined() // graduated, a new egg is waiting
    expect(after.dex).toHaveLength(1)
    expect(after.collectedFinals).toHaveLength(1)
    expect(after.eggUsage).toBe(0)
    expect(s.drainEvents().map((e) => e.kind)).toContain('graduated')
  })

  it('stores per-species names at graduation so the dex works offline', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    await s.update(obs(PokemonBalance.eggHatchThreshold + PokemonBalance.graduationTotal('common') * 2))
    expect(s.snapshot().dex[0]?.names).toBeDefined()
  })
})

describe('persistence', () => {
  it('round-trips through disk', async () => {
    const path = tempFile()
    const first = store({ filePath: path })
    await first.update(obs(0))
    await first.update(obs(3_000_000))
    await first.save()

    const second = store({ filePath: path })
    await second.update(obs(3_000_000))
    expect(second.snapshot().eggUsage).toBe(3_000_000)
  })

  // A corrupt file must never be silently destroyed — the user may still want to send it in.
  it('backs a corrupt file up before starting fresh', async () => {
    const path = tempFile()
    writeFileSync(path, 'this is not json', 'utf8')
    const s = store({ filePath: path })
    await s.update(obs(0))
    expect(s.snapshot().dex).toEqual([])
    // The original survives beside it. The name is timestamped in local time, so it is found
    // by prefix rather than by hardcoding a timezone-dependent string.
    const dir = join(path, '..')
    const backup = readdirSync(dir).find((n) => n.startsWith(BACKUP_FILE_PREFIX))
    expect(backup, 'no backup was written').toBeDefined()
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe('this is not json')
  })

  it('sanitises a hand-edited save on load', async () => {
    const path = tempFile()
    writeFileSync(path, JSON.stringify({ usedSinceInstall: 1e30, eggTier: 'legendary' }), 'utf8')
    const s = store({ filePath: path })
    await s.update(obs(0))
    expect(s.snapshot().usedSinceInstall).toBe(1_000_000_000_000_000)
    expect(s.snapshot().eggTier).toBeUndefined() // unsatisfiable, would lock the egg forever
  })
})

describe('display', () => {
  it('reports an egg before hatching and a mood after', async () => {
    const s = store()
    const inputs = { burnTier: 'normal' as const, limitWarning: false, hasUsageData: true, todayTokens: 10 }
    await s.update(obs(0))
    expect(s.displayState(inputs)).toBe('egg')

    await s.update(obs(PokemonBalance.eggHatchThreshold))
    // The hatch opens a celebration window.
    expect(s.displayState(inputs)).toBe('levelUp')
  })

  it('names the current Pokémon once the line is loaded', async () => {
    const s = store()
    await s.update(obs(0))
    await s.update(obs(PokemonBalance.eggHatchThreshold))
    expect(s.displayName()).toBe('Base1')
  })
})
