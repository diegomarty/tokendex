import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PokeAPIClient,
  attachForms,
  chooseBaseFromIndex,
  chooseBaseViaREST,
  chooseWildFromIndex,
  wildLineWeight,
  type BaseSpecies,
  type WildStatus,
} from '../src/core/pokeapi.js'
import { rarityFrom } from '../src/core/companion/model.js'
import { EconomyBalance } from '../src/core/companion/economy.js'

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

// Plan 9.7: the species card is a Pokédex entry, built from what PokéAPI already sends.
describe('PokeAPIClient.dexDetails', () => {
  const species = {
    capture_rate: 190,
    is_legendary: false,
    is_mythical: false,
    names: [{ name: 'Galvantula', language: { name: 'en' } }],
    genera: [
      { genus: 'EleSpider Pokémon', language: { name: 'en' } },
      { genus: 'Pokémon Electroaraña', language: { name: 'es' } },
      { genus: 'でんきグモポケモン', language: { name: 'ja-Hrkt' } },
      { genus: '電気蜘蛛ポケモン', language: { name: 'ja' } },
    ],
    flavor_text_entries: [
      { flavor_text: 'Old\nEnglish\fentry.', language: { name: 'en' }, version: { name: 'black' } },
      { flavor_text: 'Texto\nantiguo.', language: { name: 'es' }, version: { name: 'x' } },
      {
        flavor_text: 'It  employs\nan\felectrically\u00ad charged web.',
        language: { name: 'en' },
        version: { name: 'y' },
      },
      { flavor_text: 'Teje una\ntela electrificada.', language: { name: 'es' }, version: { name: 'y' } },
      {
        flavor_text: 'でんきを\nおびた　いとで　すを　はる。',
        language: { name: 'ja-Hrkt' },
        version: { name: 'y' },
      },
      { flavor_text: '電気を帯びた糸で巣を張る。', language: { name: 'ja' }, version: { name: 'y' } },
      { flavor_text: 'Ignored.', language: { name: 'fr' }, version: { name: 'y' } },
    ],
  }
  const pokemon = {
    height: 8,
    weight: 143,
    stats: [
      { base_stat: 70, stat: { name: 'hp' } },
      { base_stat: 77, stat: { name: 'attack' } },
      { base_stat: 60, stat: { name: 'defense' } },
      { base_stat: 97, stat: { name: 'special-attack' } },
      { base_stat: 60, stat: { name: 'special-defense' } },
      { base_stat: 108, stat: { name: 'speed' } },
    ],
    types: [
      { slot: 1, type: { name: 'bug' } },
      { slot: 2, type: { name: 'electric' } },
    ],
  }
  const respond = (body: unknown, ok = true) =>
    Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response)
  const dir = () => join(mkdtempSync(join(tmpdir(), 'ptb-dex-')), 'i.json')

  afterEach(() => vi.unstubAllGlobals())

  it('keeps the newest entry per language, in kana for Japanese, with clean spacing', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      respond(url.includes('/pokemon-species/') ? species : pokemon),
    )
    const details = await new PokeAPIClient(dir()).dexDetails(596)
    expect(details.flavor['en']).toBe('It employs an electrically charged web.')
    expect(details.flavor['es']).toBe('Teje una tela electrificada.')
    // The UI writes Japanese in kana, like the games; the kanji text is the fallback only.
    expect(details.flavor['ja']).toBe('でんきを おびた　いとで　すを　はる。')
    expect(details.flavor['fr']).toBeUndefined()
    expect(details.genus).toMatchObject({ en: 'EleSpider Pokémon', ja: 'でんきグモポケモン' })
    expect(details).toMatchObject({
      captureRate: 190,
      heightDm: 8,
      weightHg: 143,
      types: ['bug', 'electric'],
    })
    expect(details.stats?.speed).toBe(108)
  })

  // [trigger branch] A card seen once opens offline: the details are kept on disk.
  it('answers from disk when the network is gone', async () => {
    const path = dir()
    vi.stubGlobal('fetch', (url: string) =>
      respond(url.includes('/pokemon-species/') ? species : pokemon),
    )
    await new PokeAPIClient(path).dexDetails(596)
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const offline = await new PokeAPIClient(path).dexDetails(596)
    expect(offline.flavor['en']).toBe('It employs an electrically charged web.')
    expect(offline.stats?.hp).toBe(70)
  })

  // [trigger branch] Without `/pokemon` the entry still has its text, and is not kept on disk
  // half-made: the next open asks for the size and stats again.
  it('returns the text without size or stats when /pokemon fails, and does not keep it', async () => {
    const path = dir()
    vi.stubGlobal('fetch', (url: string) =>
      url.includes('/pokemon-species/') ? respond(species) : Promise.reject(new Error('down')),
    )
    const partial = await new PokeAPIClient(path).dexDetails(596)
    expect(partial.flavor['es']).toBe('Teje una tela electrificada.')
    expect(partial.stats).toBeUndefined()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    await expect(new PokeAPIClient(path).dexDetails(596)).rejects.toThrow()
  })
})

describe('the index with every form of each line', () => {
  // A branched line (Eevee) and a three-stage one, with a form whose parent is out of range
  // dropped rather than attached to nothing.
  it('attaches each line its forms, with their stage and the length of the road through them', () => {
    const lines = attachForms(
      [
        { id: 1, captureRate: 45 },
        { id: 133, captureRate: 45 },
        { id: 10, captureRate: 255 },
      ],
      [
        { id: 2, captureRate: 45, from: 1 },
        { id: 3, captureRate: 45, from: 2 },
        { id: 134, captureRate: 45, from: 133 },
        { id: 135, captureRate: 45, from: 133 },
        { id: 900, captureRate: 45, from: 899 },
      ],
    )
    expect(lines[0]).toMatchObject({
      id: 1,
      lineForms: 3,
      forms: [
        { id: 2, stage: 1, captureRate: 45, totalForms: 3 },
        { id: 3, stage: 2, captureRate: 45, totalForms: 3 },
      ],
    })
    expect(lines[1]?.forms?.map((f) => [f.id, f.stage, f.totalForms])).toEqual([
      [134, 1, 2],
      [135, 1, 2],
    ])
    expect(lines[2]).toMatchObject({ id: 10, lineForms: 1 })
    expect(lines[2]?.forms ?? []).toEqual([])
  })
})

describe('chooseWildFromIndex', () => {
  const venusaur: BaseSpecies = {
    id: 1,
    captureRate: 45,
    lineForms: 3,
    forms: [
      { id: 2, stage: 1, captureRate: 45, totalForms: 3 },
      { id: 3, stage: 2, captureRate: 45, totalForms: 3 },
    ],
  }
  const missing = (): WildStatus => 'missing'

  // [trigger branch] The games' weights for a three-stage line, counted over every stage draw:
  // the line draw is pinned to 0 (the only line), the stage draw walks 0..99.
  it('picks a stage of a three-form line 65/30/5', () => {
    const counts = new Map<number, number>()
    for (let r = 0; r < 100; r++) {
      const pick = chooseWildFromIndex([venusaur], missing, rng(0, r, 0))!
      counts.set(pick.speciesID, (counts.get(pick.speciesID) ?? 0) + 1)
    }
    expect([counts.get(1), counts.get(2), counts.get(3)]).toEqual([65, 30, 5])
  })

  it('picks 75/25 on a two-form line, and always the base of a single one', () => {
    const two: BaseSpecies = {
      id: 4,
      captureRate: 45,
      lineForms: 2,
      forms: [{ id: 5, stage: 1, captureRate: 45, totalForms: 2 }],
    }
    let evolved = 0
    for (let r = 0; r < 100; r++)
      if (chooseWildFromIndex([two], missing, rng(0, r, 0))!.speciesID === 5) evolved++
    expect(evolved).toBe(25)
    expect(chooseWildFromIndex([{ id: 10, captureRate: 255 }], missing, rng(0, 99, 0))!.speciesID).toBe(
      10,
    )
  })

  // The pick carries where the form sits in its line and the line's rarity, which price its
  // registration and its duplicate — not the form's own capture rate.
  it('tells where the form sits in its line, with the line’s rarity', () => {
    const pick = chooseWildFromIndex([venusaur], missing, rng(0, 99, 0))!
    expect(pick).toEqual({
      speciesID: 3,
      line: { baseID: 1, stageIndex: 2, totalForms: 3, rarity: rarityFrom(45, false, false) },
    })
  })

  // [trigger branch] Among branches, what the player does not have weighs four times what is
  // registered: Jolteon (missing) against Vaporeon (registered), 4:1.
  it('favours the branch the player does not have', () => {
    const eevee: BaseSpecies = {
      id: 133,
      captureRate: 45,
      lineForms: 2,
      forms: [
        { id: 134, stage: 1, captureRate: 45, totalForms: 2 },
        { id: 135, stage: 1, captureRate: 45, totalForms: 2 },
      ],
    }
    const status = (id: number): WildStatus => (id === 134 ? 'registered' : 'missing')
    const counts = new Map<number, number>()
    for (let b = 0; b < 5; b++) {
      const id = chooseWildFromIndex([eevee], status, rng(0, 99, b))!.speciesID
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    expect([counts.get(135), counts.get(134)]).toEqual([4, 1])
  })

  // [trigger branch] An index without forms (REST-built, or an older schema read offline) knows
  // no line length: the pick carries no position, so the share is owed rather than mispriced.
  it('makes up no line position from an index without forms', () => {
    const pick = chooseWildFromIndex([{ id: 1, captureRate: 45 }], missing, rng(0, 99, 0))!
    expect(pick.speciesID).toBe(1)
    expect(pick.line).toBeUndefined()
  })

  // [trigger branch] A guaranteed floor narrows the pool and meets the base: the one pick builder
  // for ordinary and granted encounters alike.
  it('honours a rarity floor, at the base of the line', () => {
    const mew: BaseSpecies = { id: 151, captureRate: 45, isMythical: true, lineForms: 1, forms: [] }
    const pick = chooseWildFromIndex([venusaur, mew], missing, rng(0, 99, 0), 'legendary')!
    expect(pick).toEqual({
      speciesID: 151,
      line: { baseID: 151, stageIndex: 0, totalForms: 1, rarity: 'legendary' },
    })
    expect(chooseWildFromIndex([venusaur], missing, rng(0), 'legendary')).toBeUndefined()
  })

  // A line still missing a form weighs four times a line fully registered, twice one that is
  // owned but not registered.
  it('weighs a line by what is left in it', () => {
    expect(wildLineWeight(venusaur, () => 'missing')).toBe(45 * 4)
    expect(wildLineWeight(venusaur, () => 'owned')).toBe(45 * 2)
    expect(wildLineWeight(venusaur, () => 'registered')).toBe(45)
    expect(wildLineWeight(venusaur, (id) => (id === 3 ? 'missing' : 'registered'))).toBe(45 * 4)
  })
})

describe('PokeAPIClient.line from an evolved form', () => {
  afterEach(() => vi.unstubAllGlobals())
  const respond = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)

  // [trigger branch] Asked for Charmeleon, the line is Charmander's — its base and its rarity —
  // not one priced by the evolved form's capture rate.
  it('answers with the line of the chain’s root', async () => {
    const chain = 'https://pokeapi.co/api/v2/evolution-chain/2/'
    const speciesDTO = (id: number) => ({
      capture_rate: id === 4 ? 255 : 3,
      is_legendary: false,
      is_mythical: false,
      evolution_chain: { url: chain },
      names: [{ name: `#${id}`, language: { name: 'en' } }],
    })
    vi.stubGlobal('fetch', (url: string) => {
      if (url.includes('/evolution-chain/')) {
        return respond({
          chain: {
            species: { url: 'https://pokeapi.co/api/v2/pokemon-species/4/' },
            evolves_to: [
              { species: { url: 'https://pokeapi.co/api/v2/pokemon-species/5/' }, evolves_to: [] },
            ],
          },
        })
      }
      const id = Number(/pokemon-species\/(\d+)/.exec(url)?.[1])
      return respond(speciesDTO(id))
    })
    const line = await new PokeAPIClient(join(mkdtempSync(join(tmpdir(), 'ptb-api-')), 'i.json')).line(5)
    expect(line.baseID).toBe(4)
    expect(line.rarity).toBe(rarityFrom(255, false, false))
  })
})

describe('the REST-built index', () => {
  afterEach(() => vi.unstubAllGlobals())

  // [trigger branch] Built over REST it has no forms, so it is written under the previous schema:
  // read back, it counts as expired and the next load with GraphQL up replaces it, instead of
  // passing for current for 30 days.
  it('is written as an older schema, so it is replaced as soon as GraphQL answers', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          capture_rate: 45,
          is_legendary: false,
          is_mythical: false,
          evolves_from_species: null,
        }),
      } as Response),
    )
    const file = join(mkdtempSync(join(tmpdir(), 'ptb-api-')), 'i.json')
    await new PokeAPIClient(file).buildBaseIndexViaREST()
    const written = JSON.parse(readFileSync(file, 'utf8')) as { version: number }
    expect(written.version).toBe(2)
  })
})

describe('the lure in the wild draw', () => {
  const missing = (): WildStatus => 'missing'
  const line = (id: number): BaseSpecies => ({
    id,
    captureRate: 45,
    lineForms: 2,
    forms: [{ id: id + 1, stage: 1, captureRate: 45, totalForms: 2 }],
  })

  // [trigger branch] The lured line weighs `lineWeight` times its own: over one draw per line
  // weight across two equal lines, the lured one takes `lineWeight` of `lineWeight + 1`.
  it('weighs the lured line by the lure’s weight', () => {
    const lure = { speciesID: 21, baseID: 20, stageIndex: 1 }
    const unit = 4 * 45
    const k = EconomyBalance.lure.lineWeight
    let lured = 0
    for (let r = 0; r < unit * (k + 1); r += unit) {
      const pick = chooseWildFromIndex([line(10), line(20)], missing, rng(r, 99, 0), undefined, lure)!
      if (pick.line?.baseID === 20) lured++
    }
    expect(lured).toBe(k)
  })

  // [trigger branch] Inside the lured line the target's stage takes 60%, the rest share 40%.
  it('gives the lured stage 60% of its line', () => {
    const lure = { speciesID: 21, baseID: 20, stageIndex: 1 }
    let target = 0
    for (let r = 0; r < 100; r++) {
      if (chooseWildFromIndex([line(20)], missing, rng(0, r, 0), undefined, lure)!.speciesID === 21)
        target++
    }
    expect(target).toBe(60)
  })

  it('leaves the draw alone without a lure', () => {
    let evolved = 0
    for (let r = 0; r < 100; r++)
      if (chooseWildFromIndex([line(20)], missing, rng(0, r, 0))!.speciesID === 21) evolved++
    expect(evolved).toBe(25)
  })
})
