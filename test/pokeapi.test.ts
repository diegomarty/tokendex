import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PokeAPIClient,
  chooseBaseFromIndex,
  chooseBaseViaREST,
  type BaseSpecies,
} from '../src/core/pokeapi.js'

const index: BaseSpecies[] = [
  { id: 1, captureRate: 45 }, // rare
  { id: 10, captureRate: 255 }, // common
  { id: 50, captureRate: 120 }, // uncommon
]

const rng = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

describe('chooseBaseFromIndex', () => {
  it('picks from the whole pool without a guarantee', () => {
    expect(chooseBaseFromIndex(index, undefined, new Set(), rng(0))).toBe(1)
  })

  // The capture-rate ceiling IS the rarity floor, so a rare guarantee also admits legendary.
  it('narrows the pool to the guaranteed tier or better', () => {
    for (let r = 0; r < 200; r++) {
      const picked = chooseBaseFromIndex(index, 'rare', new Set(), rng(r))
      expect(picked).toBe(1) // only the capture_rate 45 entry qualifies
    }
  })

  it('admits uncommon-or-better for an uncommon guarantee', () => {
    const picks = new Set<number | undefined>()
    for (let r = 0; r < 400; r++) picks.add(chooseBaseFromIndex(index, 'uncommon', new Set(), rng(r)))
    expect(picks).toEqual(new Set([1, 50]))
  })

  // Falling back to the full pool would silently break a guarantee that was paid for; keeping
  // the egg lets the next tick retry.
  it('returns undefined rather than breaking an unsatisfiable guarantee', () => {
    const commonOnly: BaseSpecies[] = [{ id: 10, captureRate: 255 }]
    expect(chooseBaseFromIndex(commonOnly, 'rare', new Set(), rng(0))).toBeUndefined()
  })

  it('halves the weight of an already-collected line without excluding it', () => {
    const two: BaseSpecies[] = [
      { id: 1, captureRate: 100 },
      { id: 2, captureRate: 100 },
    ]
    const collected = new Set([1])
    // Weights become 50 and 100, total 150: r<50 picks 1, r>=50 picks 2.
    expect(chooseBaseFromIndex(two, undefined, collected, rng(49))).toBe(1)
    expect(chooseBaseFromIndex(two, undefined, collected, rng(50))).toBe(2)
    // Still reachable, just rarer.
    expect(chooseBaseFromIndex(two, undefined, collected, rng(0))).toBe(1)
  })

  it('never weighs an entry at zero', () => {
    const tiny: BaseSpecies[] = [{ id: 7, captureRate: 1 }]
    expect(chooseBaseFromIndex(tiny, undefined, new Set([7]), rng(0))).toBe(7)
  })
})

// The legendary tier is the one `capture_rate` cannot express: every legendary sits at or
// below 45, but so do plenty of ordinary rares. These tests are what keep a "guaranteed
// legendary" from quietly handing over a Dratini.
describe('a legendary-only pool', () => {
  const withFlags: BaseSpecies[] = [
    { id: 1, captureRate: 45 }, // rare, and indistinguishable from a legendary by rate alone
    { id: 150, captureRate: 3, isLegendary: true }, // Mewtwo-class
    { id: 151, captureRate: 45, isMythical: true }, // Mew-class
    { id: 10, captureRate: 255 },
  ]

  it('draws only the flagged species', () => {
    const picks = new Set<number | undefined>()
    for (let r = 0; r < 400; r++)
      picks.add(chooseBaseFromIndex(withFlags, 'legendary', new Set(), rng(r)))
    expect(picks).toEqual(new Set([150, 151]))
  })

  it('counts a mythical as legendary, as the rarity table does', () => {
    const mythicalOnly: BaseSpecies[] = [{ id: 151, captureRate: 45, isMythical: true }]
    expect(chooseBaseFromIndex(mythicalOnly, 'legendary', new Set(), rng(0))).toBe(151)
  })

  // An index cached by a version that predates the flags. Empty is the honest answer: the
  // reward stays owed until a fresh index lands, rather than being paid with a rare.
  it('is empty, not wrong, for an index that predates the flags', () => {
    expect(chooseBaseFromIndex(index, 'legendary', new Set(), rng(0))).toBeUndefined()
  })

  // Legendaries were always admitted by a rare guarantee, through the capture-rate ceiling.
  // Adopting the flags must not have narrowed that.
  it('still admits a legendary into a rare-or-better pool', () => {
    const picks = new Set<number | undefined>()
    for (let r = 0; r < 400; r++) picks.add(chooseBaseFromIndex(withFlags, 'rare', new Set(), rng(r)))
    expect(picks).toEqual(new Set([1, 150, 151]))
  })
})

describe('chooseBaseViaREST', () => {
  const provider = (bases: Record<number, BaseSpecies | undefined>) => ({
    baseSpecies: async (id: number) => bases[id],
  })

  it('rejects non-base species and keeps sampling', async () => {
    const p = provider({ 5: undefined, 9: { id: 9, captureRate: 200 } })
    expect(await chooseBaseViaREST(p, undefined, rng(4, 8))).toBe(9)
  })

  // [trigger branch] Leaving the guarantee out of this path would break it silently exactly
  // when the GraphQL index is down — the one moment it is hardest to notice.
  it('enforces the guarantee on the fallback path too', async () => {
    const p = provider({ 9: { id: 9, captureRate: 200 }, 3: { id: 3, captureRate: 20 } })
    expect(await chooseBaseViaREST(p, 'rare', rng(8, 2))).toBe(3) // skips the common one
  })

  it('keeps the egg when the network is down rather than consuming the purchase', async () => {
    const failing = {
      baseSpecies: async () => {
        throw new Error('offline')
      },
    }
    expect(await chooseBaseViaREST(failing, undefined, rng(0))).toBeUndefined()
  })

  it('gives up after the attempt budget', async () => {
    const p = provider({})
    expect(await chooseBaseViaREST(p, undefined, rng(0), 3)).toBeUndefined()
  })
})

describe('PokeAPIClient.wildSpecies', () => {
  const species = {
    capture_rate: 3,
    is_legendary: true,
    is_mythical: false,
    base_happiness: 0,
    names: [{ name: 'Mewtwo', language: { name: 'en' } }],
  }
  const pokemon = {
    stats: [
      { base_stat: 106, stat: { name: 'hp' } },
      { base_stat: 110, stat: { name: 'attack' } },
      { base_stat: 90, stat: { name: 'defense' } },
      { base_stat: 154, stat: { name: 'special-attack' } },
      { base_stat: 90, stat: { name: 'special-defense' } },
      { base_stat: 130, stat: { name: 'speed' } },
    ],
    // Out of order on purpose: the slot, not the array position, says which type is primary.
    types: [
      { slot: 2, type: { name: 'flying' } },
      { slot: 1, type: { name: 'bug' } },
    ],
  }
  const respond = (body: unknown, ok = true) =>
    Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response)

  afterEach(() => vi.unstubAllGlobals())

  it('reads base stats and happiness alongside the species', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      respond(url.includes('/pokemon-species/') ? species : pokemon),
    )
    const wild = await new PokeAPIClient(
      join(mkdtempSync(join(tmpdir(), 'ptb-api-')), 'i.json'),
    ).wildSpecies(150)
    expect(wild).toMatchObject({ rarity: 'legendary', baseHappiness: 0, types: ['bug', 'flying'] })
    expect(wild.stats).toEqual({
      hp: 106,
      attack: 110,
      defense: 90,
      specialAttack: 154,
      specialDefense: 90,
      speed: 130,
    })
  })

  // A type a newer PokéAPI adds (or a typo) must not reach the stylesheet as a class name.
  it('drops a type this build does not know', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      respond(
        url.includes('/pokemon-species/')
          ? species
          : {
              ...pokemon,
              types: [
                { slot: 1, type: { name: 'stellar' } },
                { slot: 2, type: { name: 'fire' } },
              ],
            },
      ),
    )
    const wild = await new PokeAPIClient(
      join(mkdtempSync(join(tmpdir(), 'ptb-api-')), 'i.json'),
    ).wildSpecies(150)
    expect(wild.types).toEqual(['fire'])
  })

  // [trigger branch] The stats only shape the temperament, which has a neutral fallback. A failing
  // `/pokemon` must not throw: that would defer the encounter and count against the backoff.
  it('still returns the species when the stats request fails', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      url.includes('/pokemon-species/') ? respond(species) : Promise.reject(new Error('offline')),
    )
    const wild = await new PokeAPIClient(
      join(mkdtempSync(join(tmpdir(), 'ptb-api-')), 'i.json'),
    ).wildSpecies(150)
    expect(wild.rarity).toBe('legendary')
    expect(wild.stats).toBeUndefined()
  })

  // [trigger branch] The stats only shape a temperament with a neutral fallback, so a hanging
  // `/pokemon` must not hold the spawn for the whole request timeout while the species is ready.
  it('gives up on slow stats quickly instead of holding the spawn', async () => {
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) =>
      url.includes('/pokemon-species/')
        ? respond(species)
        : new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
    )
    const client = new PokeAPIClient(join(mkdtempSync(join(tmpdir(), 'ptb-api-')), 'i.json'), {
      statsTimeoutMs: 50,
    })
    const started = Date.now()
    const wild = await client.wildSpecies(150)
    expect(wild.stats).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1_000)
  }, 2_000)
})
